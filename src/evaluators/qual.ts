/**
 * Clinical quality evaluator.
 * If case has goldFindings: severity-aware finding matching (exact/partial/missed/hallucinated).
 * If case has referenceReport: section-level comparison.
 * Otherwise: falls back to structural checks (backward compat).
 */

import { extractFindings, hasNegationCue, isFindingNegated, type ExtractedFinding } from "../extract.js";
import { getLocale } from "../locales/index.js";
import { escapeRegExp, normalizeLoose, stripTags } from "../normalize.js";
import {
  clinicalComparableText,
  clinicalTokenCoverage,
  clinicalTokenSimilarity,
  clinicalTokens,
  isFindingClinicallyReflected,
  isManagementOrDifferentialGold,
  sourceBackedFindingCoverage,
} from "../clinical-match.js";
import type { BenchCase, Check, EvaluatorResult, ExamMeta, FindingSeverity, GoldFinding, LocaleKey } from "../types.js";

const LATERALITY_STOPWORDS = new Set([
  "com", "sem", "para", "pela", "pelo", "dos", "das", "uma", "entre", "normal", "normais",
  "preservada", "preservado", "espessura", "dimensoes", "contornos", "regular", "regulares",
  "direita", "direito", "esquerda", "esquerdo", "bilateral",
]);

function lateralityRegex(side: NonNullable<GoldFinding["laterality"]>): RegExp {
  if (side === "right") return /\b(?:direit[ao]?|right)\b/i;
  if (side === "left") return /\b(?:esquerd[ao]?|left)\b/i;
  return /\b(?:bilateral|bilaterais)\b|(?:\bdireit[ao]?\b[\s\S]{0,80}\besquerd[ao]?\b)|(?:\besquerd[ao]?\b[\s\S]{0,80}\bdireit[ao]?\b)/i;
}

function contentTokensForLaterality(g: GoldFinding): string[] {
  const source = normalizeLoose([g.finding, g.location, ...(g.measurements ?? [])].filter(Boolean).join(" "));
  return Array.from(new Set(source.split(/\s+/).filter((t) => t.length > 3 && !LATERALITY_STOPWORDS.has(t))));
}

function lateralityMatches(g: GoldFinding, reportSentences: string[], reportText: string): boolean {
  if (!g.laterality) return false;
  const side = lateralityRegex(g.laterality);
  const tokens = contentTokensForLaterality(g);
  const tokenHit = (text: string) => tokens.some((t) => text.includes(t));

  if (reportSentences.some((s) => side.test(s) && tokenHit(s))) return true;

  const findingMentioned = tokens.length === 0 || tokens.filter((t) => reportText.includes(t)).length >= Math.min(2, tokens.length);
  const anchorSource = normalizeLoose([g.location, g.finding].filter(Boolean).join(" "));
  const anchorTokens = anchorSource.split(/\s+/).filter((t) => t.length > 3 && !LATERALITY_STOPWORDS.has(t));
  const anchoredSide = reportSentences.some((s) => side.test(s) && anchorTokens.some((t) => s.includes(t)));
  return findingMentioned && anchoredSide;
}

function lateralityCheckSeverity(goldWithLat: GoldFinding[]): Check["severity"] {
  return goldWithLat.some((g) => g.severity === "critical") ? "critical" : "major";
}

function normalizeMeasurementValue(value: string): string {
  return normalizeLoose(value)
    .replace(/,/g, ".")
    .replace(/\s+/g, "")
    .replace(/(\d+)\.0+(?=\D|$)/g, "$1");
}

function measurementPresent(reportText: string, measurement: string): boolean {
  const normalizedReport = normalizeMeasurementValue(reportText);
  const normalizedMeasurement = normalizeMeasurementValue(measurement);
  if (normalizedMeasurement.length === 0) return true;
  // Exact-boundary match, NOT naive substring. A digit or decimal point
  // immediately to the left means a different number: gold "2cm" must not match
  // inside "12cm", and "1.5cm" must not match inside "11.5cm". A tenfold size
  // error is a dangerous measurement mistake, not a preserved measurement.
  return new RegExp(`(?<![\\d.])${escapeRegExp(normalizedMeasurement)}`).test(normalizedReport);
}

// Severity weights for scoring
const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  critical: 4.0,
  major: 2.5,
  minor: 1.0,
  incidental: 0.5,
};

const SYNTHESIS_STOPWORDS = new Set([
  "texto", "sintetico", "teste", "harness", "exemplo", "demonstracao", "para", "com", "sem",
  "dos", "das", "uma", "este", "esta", "esse", "essa", "no", "na", "nos", "nas", "por",
  "pela", "pelo", "de", "do", "da", "ao", "aos", "as", "os", "que", "em", "entre",
  "maior", "menor", "eixo", "achados", "analise", "conclusao", "tecnica",
]);

function synthesisTokens(value: string): string[] {
  return normalizeLoose(stripTags(value))
    .split(/\W+/)
    .filter((token) => token.length > 3 && !SYNTHESIS_STOPWORDS.has(token));
}

function synthesisPenalty(reportHtml: string, benchCase: BenchCase, locale: LocaleKey): {
  penalty: number;
  copiedOutputRatio: number;
  addedTokenCount: number;
  clinicalAddedTokenCount: number;
  reason: string;
} {
  const inputTokens = new Set(synthesisTokens(benchCase.findings));
  const outputTokens = synthesisTokens(reportHtml);
  if (inputTokens.size === 0 || outputTokens.length === 0) {
    return { penalty: 0, copiedOutputRatio: 0, addedTokenCount: 0, clinicalAddedTokenCount: 0, reason: "no-token-basis" };
  }

  const copiedOutputRatio = outputTokens.filter((token) => inputTokens.has(token)).length / outputTokens.length;
  const addedTokens = Array.from(new Set(outputTokens)).filter((token) => !inputTokens.has(token));
  const addedTokenCount = addedTokens.length;

  // Padding resistance (anti-aesthetic): raw added-token count is gameable by
  // stuffing the report with non-clinical filler/synonyms to look "synthesized".
  // Only count added tokens that are clinically grounded in the case material
  // (gold findings, critical findings, reference report) as real synthesis.
  // Filler a model can pad with is not in that vocabulary and does not help it
  // escape the penalty. When the case exposes too little clinical vocabulary
  // beyond the input to judge this reliably, fall back to the raw count so no
  // new false positives are introduced on thin cases.
  const caseClinicalTokens = new Set(
    synthesisTokens([
      benchCase.referenceReport ?? "",
      ...(benchCase.goldFindings ?? []).map((g) => g.finding),
      ...(benchCase.criticalFindings ?? []),
    ].join(" ")),
  );
  const clinicalAddedTokenCount = addedTokens.filter((token) => caseClinicalTokens.has(token)).length;
  const clinicalVocabBeyondInput = Array.from(caseClinicalTokens).filter((token) => !inputTokens.has(token)).length;
  const effectiveAdded = clinicalVocabBeyondInput >= 4 ? clinicalAddedTokenCount : addedTokenCount;

  const goldFindings = (benchCase.goldFindings ?? []).filter((g) => !isManagementOrDifferentialGold(g.finding));
  if (goldFindings.length > 0 && !hasRecognizableConclusionSection(reportHtml, locale)) {
    return { penalty: 10, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: "missing-conclusion-section" };
  }

  const principal = goldFindings.filter((g) => !g.negated && (g.severity === "critical" || g.severity === "major"));
  if (principal.length > 0) {
    const conclusionText = extractConclusionText(reportHtml, locale);
    const sourceText = caseFindingsSourceText(benchCase);
    const covered = principal.filter((g) => findingReflectedInText(g.finding, conclusionText, sourceText)).length;
    if (covered === 0) {
      return { penalty: 12, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: `principalCovered=0/${principal.length}` };
    }
  }

  // A "substantive conclusion" earns the synthesis pass UNLESS the Impression is a
  // near-verbatim DUPLICATE of the Findings section (copy the source into both
  // sections). That echo otherwise satisfied hasSubstantiveConclusion and scored
  // QUAL=100 with zero synthesis — a leaderboard-gaming path. This is distinct from
  // a faithful concise report whose conclusion condenses/reframes the findings
  // (different text), which must still pass.
  if (hasSubstantiveConclusion(reportHtml, locale) && !impressionDuplicatesFindings(reportHtml, locale)) {
    return { penalty: 0, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: "substantive-conclusion" };
  }

  if (copiedOutputRatio >= 0.78 && effectiveAdded < 12) {
    return { penalty: 14, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: "high-copy-low-addition" };
  }
  if (copiedOutputRatio >= 0.72 && effectiveAdded < 18) {
    return { penalty: 10, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: "moderate-copy-low-addition" };
  }
  if (copiedOutputRatio >= 0.66 && effectiveAdded < 15) {
    return { penalty: 6, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: "borderline-copy-low-addition" };
  }
  return { penalty: 0, copiedOutputRatio, addedTokenCount, clinicalAddedTokenCount, reason: "sufficient-token-distance" };
}

type FindingMatchResult = {
  goldFinding: string;
  severity: FindingSeverity;
  matchType: "exact" | "partial" | "missed";
  matchedText?: string;
  score: number; // 0-1 for this finding
};

type HallucinationResult = {
  text: string;
  confidence: "high" | "medium" | "low";
};

function clinicalUtilityFloor(matches: FindingMatchResult[], hallucinations: HallucinationResult[]): number {
  if (matches.length === 0) return 100;

  const missed = matches.filter((m) => m.matchType === "missed");
  const criticalMissed = missed.filter((m) => m.severity === "critical");
  if (criticalMissed.length > 0) return 0;
  if (missed.length > 0 && missed.every((m) => m.severity === "minor" || m.severity === "incidental")) return 84;

  const detected = matches.length - missed.length;
  const detectionRatio = detected / matches.length;
  const highHallucinations = hallucinations.filter((h) => h.confidence === "high").length;

  if (highHallucinations > 0) return detectionRatio >= 0.8 ? 72 : 0;
  if (missed.length === 0) return 88;
  if (detectionRatio >= 0.9) return 84;
  if (detectionRatio >= 0.8) return 80;
  return 0;
}

/**
 * Compute text similarity between two strings using token overlap (Jaccard-like).
 */
function tokenSimilarity(a: string, b: string): number {
  return clinicalTokenSimilarity(a, b);
}

function tokenContainment(needle: string, haystack: string): number {
  return clinicalTokenCoverage(needle, haystack);
}

function sourceSupportsExtractedFinding(text: string, benchCase: BenchCase): boolean {
  const finding = normalizeLoose(text);
  if (finding.length < 8) return false;
  const sourceText = caseSourceText(benchCase);
  const normalizedSourceText = normalizeLoose(sourceText);
  if (!sourceText) return false;
  if (normalizedSourceText.includes(finding)) return true;
  return tokenContainment(text, sourceText) >= 0.58;
}

function caseSourceText(benchCase: BenchCase): string {
  return stripTags([
    benchCase.findings,
    benchCase.referenceReport ?? "",
  ].join("\n"));
}

function caseFindingsSourceText(benchCase: BenchCase): string {
  return stripTags(benchCase.findings);
}

function reportSentences(reportHtml: string): string[] {
  return stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"))
    .split(/[.\n;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

function bestSentenceForTokens(sentences: string[], tokens: string[]): string | null {
  let best: string | null = null;
  let bestRatio = 0;
  for (const sentence of sentences) {
    const n = normalizeLoose(sentence);
    const hits = tokens.filter((token) => n.includes(token)).length;
    const ratio = tokens.length > 0 ? hits / tokens.length : 0;
    if (ratio > bestRatio) {
      best = sentence;
      bestRatio = ratio;
    }
  }
  return bestRatio >= 0.5 ? best : null;
}

// Select the REPORT text whose polarity decides whether `gold` is affirmed or
// denied. Two rules close the qual-compound-polarity escape:
//   1. Scope sentence selection to the gold's PRIMARY finding clause tokens. The
//      full compound gold's embedded pertinent-negative tokens ("acute subdural
//      hematoma, no midline shift" -> midline/shift) otherwise dilute the
//      full-gold token ratio below 0.5, so bestSentenceForTokens returns null on
//      the very sentence that denies the finding ("No subdural hematoma").
//   2. NEVER fall back to the gold text itself. The old `?? gold.finding` made
//      polarityConcordant compare the affirmed gold against itself, so a NEGATING
//      report was scored as a concordant match. When no report sentence localizes
//      the primary finding we use the whole report so a bare negation is still
//      seen — erring toward MISS, the safe (conservative) direction for a critical.
function reportPolarityCandidate(gold: GoldFinding, sentences: string[], reportText: string): string {
  const primaryTokens = clinicalTokens(primaryFindingClause(gold.finding));
  const tokens = primaryTokens.length > 0 ? primaryTokens : clinicalTokens(gold.finding);
  return bestSentenceForTokens(sentences, tokens) ?? reportText;
}

// The PRIMARY finding clause of a (possibly compound) text: the first
// clause that still carries clinical content. Clauses are split on punctuation
// and contrast/conjunction markers so an embedded, unrelated pertinent negative
// ("acute subdural hematoma, no midline shift") lives in a SEPARATE clause from
// the principal affirmed finding and cannot flip its polarity.
// Coordinating "and"/"or" (PT "e"/"ou") are excluded for the same reason as in
// extract.ts CLAUSE_CONJUNCTION_RX: they coordinate items under one shared
// negation rather than introducing a separate clause.
const PRIMARY_CLAUSE_SPLIT_RX = /[,;:.\n]|\b(?:but|with|mas|com|porem|contudo|entretanto)\b/i;

function primaryFindingClause(text: string): string {
  const clauses = text
    .split(PRIMARY_CLAUSE_SPLIT_RX)
    .map((c) => c.trim())
    .filter((c) => clinicalTokens(c).length >= 1);
  return clauses[0] ?? text;
}

function polarityConcordant(gold: GoldFinding, candidateText: string, locale: LocaleKey, extracted?: ExtractedFinding): boolean {
  // Candidate polarity: prefer the clause-scoped predicate anchored on the gold
  // finding span (isFindingNegated), and only consider the candidate negated if
  // its PRIMARY clause carries the cue — a whole-text hasNegationCue would let
  // an unrelated pertinent negative elsewhere in the candidate sentence
  // ("...; no midline shift") wrongly mark an affirmed candidate as negated.
  const candidateNegated = extracted?.negated === true
    || hasNegationCue(primaryFindingClause(candidateText), locale)
    || isFindingNegated(candidateText, gold.finding, locale);
  // Gold polarity (negation-matching-2): clause/primary-anchor scoped, NOT
  // whole-text. An affirmed compound gold that embeds an unrelated pertinent
  // negative ("acute subdural hematoma, no midline shift") must stay AFFIRMED,
  // so a report that NEGATES the critical does not falsely match it.
  const goldNegated = gold.negated === true || hasNegationCue(primaryFindingClause(gold.finding), locale);
  return goldNegated ? candidateNegated : !candidateNegated;
}

/**
 * Match gold findings against extracted report findings.
 */
function matchFindings(
  goldFindings: GoldFinding[],
  reportHtml: string,
  locale: LocaleKey,
  benchCase: BenchCase,
  hallucinationReferenceFindings: GoldFinding[] = goldFindings,
): {
  matches: FindingMatchResult[];
  hallucinations: HallucinationResult[];
} {
  const extractedFindings = extractFindings(reportHtml, locale);
  const reportText = normalizeLoose(stripTags(reportHtml));
  const sourceText = caseFindingsSourceText(benchCase);
  const sentences = reportSentences(reportHtml);
  const matches: FindingMatchResult[] = [];
  const usedExtracted = new Set<number>();

  for (const gold of goldFindings) {
    const goldNorm = normalizeLoose(gold.finding);
    const comparableGold = clinicalComparableText(gold.finding);
    const reportWideCoverage = clinicalTokenCoverage(gold.finding, reportText);

    // Try exact substring match first
    const directMatch = reportText.includes(goldNorm);
    const clinicalExactMatch = comparableGold.length > 0 && reportWideCoverage >= 0.92;
    if (directMatch || clinicalExactMatch) {
      // Polarity candidate must be REPORT text, never the gold text (see
      // reportPolarityCandidate): comparing the affirmed gold to itself made a
      // negating report look concordant (qual-compound-polarity escape).
      const sentence = directMatch
        ? sentences.find((s) => normalizeLoose(s).includes(goldNorm)) ?? reportPolarityCandidate(gold, sentences, reportText)
        : reportPolarityCandidate(gold, sentences, reportText);
      if (!polarityConcordant(gold, sentence, locale)) {
        matches.push({
          goldFinding: gold.finding,
          severity: gold.severity,
          matchType: "missed",
          matchedText: sentence,
          score: 0,
        });
        continue;
      }
      matches.push({
        goldFinding: gold.finding,
        severity: gold.severity,
        matchType: "exact",
        matchedText: gold.finding,
        score: 1.0,
      });
      // Mark the closest extracted finding as used
      let bestIdx = -1;
      let bestSim = 0;
      for (let i = 0; i < extractedFindings.length; i++) {
        if (usedExtracted.has(i)) continue;
        const sim = tokenSimilarity(gold.finding, extractedFindings[i].text);
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
      }
      if (bestIdx >= 0) usedExtracted.add(bestIdx);
      continue;
    }

    // Try token-level partial match
    let bestMatchIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < extractedFindings.length; i++) {
      if (usedExtracted.has(i)) continue;
      if (!polarityConcordant(gold, extractedFindings[i].text, locale, extractedFindings[i])) continue;
      const sim = tokenSimilarity(gold.finding, extractedFindings[i].text);

      // Also check location and laterality concordance
      let bonus = 0;
      if (gold.location && extractedFindings[i].location) {
        if (normalizeLoose(gold.location) === normalizeLoose(extractedFindings[i].location!)) bonus += 0.1;
      }
      if (gold.laterality && extractedFindings[i].laterality === gold.laterality) bonus += 0.1;

      // Check measurement preservation
      if (gold.measurements && gold.measurements.length > 0) {
        const measPresent = gold.measurements.filter((m) =>
          measurementPresent(extractedFindings[i].text, m)
        ).length;
        bonus += (measPresent / gold.measurements.length) * 0.1;
      }

      const totalSim = Math.min(1.0, sim + bonus);
      if (totalSim > bestScore) {
        bestScore = totalSim;
        bestMatchIdx = i;
      }
    }

    if (bestScore >= 0.4) {
      usedExtracted.add(bestMatchIdx);
      matches.push({
        goldFinding: gold.finding,
        severity: gold.severity,
        matchType: bestScore >= 0.7 ? "exact" : "partial",
        matchedText: extractedFindings[bestMatchIdx]?.text,
        score: bestScore >= 0.7 ? 1.0 : bestScore,
      });
    } else {
      // Also try a looser substring approach - check if key terms from gold appear in report
      const goldTokens = clinicalTokens(gold.finding);
      const tokenRatio = clinicalTokenCoverage(gold.finding, reportText);
      const sourceCoverage = sourceBackedFindingCoverage(gold.finding, reportText, sourceText);
      const matchedSentence = bestSentenceForTokens(sentences, goldTokens);
      const polarityOk = matchedSentence ? polarityConcordant(gold, matchedSentence, locale) : gold.negated !== true;

      if ((tokenRatio >= 0.55 || sourceCoverage >= 0.55) && polarityOk) {
        matches.push({
          goldFinding: gold.finding,
          severity: gold.severity,
          matchType: "partial",
          matchedText: tokenRatio >= 0.55 ? clinicalComparableText(gold.finding) : "source-backed clinical finding",
          score: Math.max(0.55, Math.min(0.78, Math.max(tokenRatio, sourceCoverage) * 0.9)),
        });
      } else {
        matches.push({
          goldFinding: gold.finding,
          severity: gold.severity,
          matchType: "missed",
          score: 0,
        });
      }
    }
  }

  // Identify potential hallucinations: extracted findings that don't match any gold finding
  const hallucinations: HallucinationResult[] = [];
  // The similarity exemption must measure against AFFIRMED-ABNORMAL gold only. A
  // fabrication that shares an organ/location token with a NORMAL or negated gold
  // ("Liver normal" vs fabricated "Liver metastasis") otherwise reached the 0.2
  // similarity threshold and laundered past detection. Exclude negated/normality
  // gold from the reference set.
  const goldNormalityRx = locale === "pt-BR"
    ? /\bsem\b|\bausencia\b|\bnao ha\b|\bnao se (?:observa|identifica|detecta)|\blivres?\b|\bnormal\b|\bnormais\b|\bpreservad|\bhabituais?\b|\bsem alterac/i
    : /\bno\b|\bwithout\b|\bclear\b|\bunremarkable\b|\bnegative\b|\bwithin normal\b|\bnormal\b|\bpreserved\b|\bintact\b|\babsent\b/i;
  const goldNorms = hallucinationReferenceFindings
    .filter((g) => g.negated !== true && !goldNormalityRx.test(normalizeLoose(g.finding)))
    .map((g) => normalizeLoose(g.finding));

  // Fabricated-malignancy guard. A bag-of-token similarity exemption can be
  // defeated by a fabrication that shares only the ORGAN token with a benign gold
  // of the same organ ("renal cell carcinoma" vs gold "simple renal cyst"; share
  // "renal" → sim ≥ 0.2 → wrongly exempt). A malignancy assertion that appears
  // NOWHERE in the source material is unambiguously a high-stakes hallucination, so
  // it is flagged regardless of organ-token similarity.
  const MALIGNANCY_RX = /carcinoma|metastas|malign|neoplas|sarcoma|lymphoma|linfoma|adenocarcin|\bcancer/i;
  const sourceMalignancyNorm = normalizeLoose(
    `${benchCase.findings ?? ""} ${benchCase.referenceReport ?? ""} ` +
    `${(benchCase.goldFindings ?? []).map((g) => g.finding).join(" ")} ` +
    `${(benchCase.criticalFindings ?? []).join(" ")}`,
  );
  const sourceHasMalignancy = MALIGNANCY_RX.test(sourceMalignancyNorm);

  for (let i = 0; i < extractedFindings.length; i++) {
    if (usedExtracted.has(i)) continue;
    const ef = extractedFindings[i];

    if (sourceSupportsExtractedFinding(ef.text, benchCase)) continue;

    // BUG 3 FIX: Pertinent negatives are NOT hallucinations.
    // Normal/negative findings like "Lungs are clear", "No pleural effusion" are clinically required.
    // Locale-split: in pt-BR, "no" is the contraction em+o ("no exemplo"), not a negation —
    // matching it disabled hallucination detection for the primary locale.
    const efNorm = normalizeLoose(ef.text);
    // A pertinent negative must be negative/normal in EVERY substantive clause.
    // Testing the whole text for ANY normality cue let a fabricated frank finding
    // launder past detection by co-occurring with a normality word in the same
    // sentence ("Large hepatic metastasis, liver enzymes normal."). Scope the test
    // per clause: if any clause carries affirmed clinical content with no negation,
    // it is NOT a pure pertinent negative.
    const clauses = efNorm.split(/[.,;]/).map((c) => c.trim()).filter(Boolean);
    const isPertinentNegative =
      clauses.length > 0 && clauses.every((cl) => goldNormalityRx.test(cl) || clinicalTokens(cl).length < 2);
    if (isPertinentNegative) continue;

    // Fabricated malignancy absent from the source → high-confidence hallucination,
    // bypassing the organ-token similarity exemption (see MALIGNANCY_RX above). Only
    // when the malignancy term is AFFIRMED — a negated "..., no malignancy" must not
    // trip the guard (it's a pertinent negative, not a fabrication).
    const malMatch = efNorm.match(MALIGNANCY_RX);
    if (!sourceHasMalignancy && malMatch && !isFindingNegated(ef.text, malMatch[0], locale)) {
      hallucinations.push({ text: ef.text, confidence: "high" });
      continue;
    }

    // Check if this finding has any similarity to the input findings. The severity
    // classifier defaults unknown findings to "incidental", so a blanket
    // "incidental" exemption let fabrications with sim 0 escape entirely. A finding
    // that is unsupported by the source (checked above), not a pertinent negative,
    // and dissimilar to every gold finding is a hallucination regardless of severity.
    const maxSim = Math.max(0, ...goldNorms.map((g) => tokenSimilarity(g, ef.text)));
    if (maxSim < 0.2) {
      hallucinations.push({
        text: ef.text,
        confidence: maxSim < 0.1 ? "high" : "medium",
      });
    }
  }

  return { matches, hallucinations };
}

/**
 * Score finding matches weighted by clinical severity.
 */
function scoreFindingMatches(matches: FindingMatchResult[], hallucinations: HallucinationResult[]): number {
  if (matches.length === 0) return 100; // No gold findings, perfect score

  let totalWeight = 0;
  let totalWeightedScore = 0;

  for (const m of matches) {
    const weight = SEVERITY_WEIGHTS[m.severity];
    totalWeight += weight;
    totalWeightedScore += weight * m.score;
  }

  // Penalize hallucinations
  const hallucinationPenalty = hallucinations.reduce((sum, h) => {
    return sum + (h.confidence === "high" ? 5 : 1);
  }, 0);

  const baseScore = totalWeight > 0 ? (totalWeightedScore / totalWeight) * 100 : 100;
  return Math.max(clinicalUtilityFloor(matches, hallucinations), Math.max(0, Math.min(100, baseScore - hallucinationPenalty)));
}

// Cache of \b<header>\b regexes used by extractSectionText, keyed by the raw
// header string. Headers come from a small fixed set per locale, so the cache
// stays bounded.
const _headerRegexCache = new Map<string, RegExp>();

function headerRegex(header: string): RegExp {
  let rx = _headerRegexCache.get(header);
  if (!rx) {
    rx = new RegExp(`\\b${escapeRegExp(normalizeLoose(header))}\\b`, "i");
    _headerRegexCache.set(header, rx);
  }
  return rx;
}

/**
 * Extract the text content of a section from the full text, given section header patterns.
 * Sections are delimited by headers matching sectionHeaders entries.
 */
// Extract the conclusion/impression section text (normalized, tags stripped).
function extractConclusionText(reportHtml: string, locale: LocaleKey): string {
  const rawSection = rawConclusionSection(reportHtml, locale);
  if (rawSection) return normalizeLoose(rawSection);

  const localeSpec = getLocale(locale);
  const plain = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const labels = localeSpec.sectionLabels;
  const conclusionHeaders = locale === "pt-BR"
    ? [labels.conclusion, "Conclusao", "Impressão", "Impressao"]
    : [labels.conclusion, "Conclusion"];
  const allHeaders = locale === "pt-BR"
    ? [labels.analysis, "Analise", "Achados", labels.conclusion, "Conclusao", "Impressão", "Impressao", labels.technique, "Tecnica"]
    : [labels.analysis, "Findings", labels.conclusion, "Conclusion", labels.technique, "Technique"];
  const section = extractSectionText(plain, conclusionHeaders, allHeaders);
  // Fall back to the whole report if no recognizable conclusion section.
  return section || normalizeLoose(plain);
}

function rawConclusionSection(reportHtml: string, locale: LocaleKey): string {
  const header = locale === "pt-BR"
    ? /(?:conclus[aã]o|impress[aã]o)/i
    : /(?:impression|conclusion)/i;
  const match = new RegExp(`<b>\\s*${header.source}[^<]*<\\/b>\\s*(?:<br\\s*\\/?>|\\s|:)*([\\s\\S]*)$`, "i").exec(reportHtml);
  if (!match) return "";
  return stripTags(match[1].replace(/<br\s*\/?>/gi, "\n")).trim();
}

// True when the Impression/Conclusion section is a near-verbatim duplicate of the
// Findings section (the report copied the source into both sections rather than
// synthesizing). Requires high token overlap in BOTH directions, so a condensed or
// reframed conclusion (a subset, or adding interpretive terms) is NOT flagged.
function impressionDuplicatesFindings(reportHtml: string, locale: LocaleKey): boolean {
  const localeSpec = getLocale(locale);
  const labels = localeSpec.sectionLabels;
  const plain = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const conclusionHeaders = locale === "pt-BR"
    ? [labels.conclusion, "Conclusao", "Impressão", "Impressao"]
    : [labels.conclusion, "Conclusion"];
  const findingsHeaders = locale === "pt-BR"
    ? [labels.analysis, "Analise", "Achados"]
    : [labels.analysis, "Findings"];
  const allHeaders = locale === "pt-BR"
    ? [labels.analysis, "Analise", "Achados", labels.conclusion, "Conclusao", "Impressão", "Impressao", labels.technique, "Tecnica"]
    : [labels.analysis, "Findings", labels.conclusion, "Conclusion", labels.technique, "Technique"];
  const concTokens = clinicalTokens(extractSectionText(plain, conclusionHeaders, allHeaders));
  const findTokens = clinicalTokens(extractSectionText(plain, findingsHeaders, allHeaders));
  if (concTokens.length < 2 || findTokens.length < 2) return false;
  const concSet = new Set(concTokens);
  const findSet = new Set(findTokens);
  const aInB = concTokens.filter((t) => findSet.has(t)).length / concTokens.length;
  const bInA = findTokens.filter((t) => concSet.has(t)).length / findTokens.length;
  return aInB >= 0.9 && bInA >= 0.9;
}

function hasSubstantiveConclusion(reportHtml: string, locale: LocaleKey): boolean {
  const rawSection = rawConclusionSection(reportHtml, locale);
  if (normalizeLoose(rawSection).split(/\s+/).filter((t) => t.length > 2).length >= 3) return true;

  const localeSpec = getLocale(locale);
  const plain = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const labels = localeSpec.sectionLabels;
  const conclusionHeaders = locale === "pt-BR"
    ? [labels.conclusion, "Conclusao", "Impressão", "Impressao"]
    : [labels.conclusion, "Conclusion"];
  const allHeaders = locale === "pt-BR"
    ? [labels.analysis, "Analise", "Achados", labels.conclusion, "Conclusao", "Impressão", "Impressao", labels.technique, "Tecnica"]
    : [labels.analysis, "Findings", labels.conclusion, "Conclusion", labels.technique, "Technique"];
  const section = extractSectionText(plain, conclusionHeaders, allHeaders);
  const tokens = normalizeLoose(section).split(/\s+/).filter((t) => t.length > 2);
  return tokens.length >= 3;
}

function hasRecognizableConclusionSection(reportHtml: string, locale: LocaleKey): boolean {
  if (normalizeLoose(rawConclusionSection(reportHtml, locale)).split(/\s+/).filter((t) => t.length > 2).length >= 3) {
    return true;
  }

  const localeSpec = getLocale(locale);
  const plain = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const labels = localeSpec.sectionLabels;
  const conclusionHeaders = locale === "pt-BR"
    ? [labels.conclusion, "Conclusao", "Impressão", "Impressao"]
    : [labels.conclusion, "Conclusion"];
  const allHeaders = locale === "pt-BR"
    ? [labels.analysis, "Analise", "Achados", labels.conclusion, "Conclusao", "Impressão", "Impressao", labels.technique, "Tecnica"]
    : [labels.analysis, "Findings", labels.conclusion, "Conclusion", labels.technique, "Technique"];
  const section = extractSectionText(plain, conclusionHeaders, allHeaders);
  return normalizeLoose(section).split(/\s+/).filter((t) => t.length > 2).length >= 3;
}

// True when a gold finding is reflected through explicit report/source tokens;
// this stays reproducible without a hidden synonym table.
function findingReflectedInText(finding: string, text: string, sourceText = ""): boolean {
  const normText = normalizeLoose(text);
  const normFinding = normalizeLoose(finding);
  if (normText.includes(normFinding)) return true;
  return isFindingClinicallyReflected(finding, text, sourceText);
}

function extractSectionText(
  fullText: string,
  sectionHeaders: string[],
  allHeaders: string[],
): string {
  const headerRegexes = sectionHeaders.map(headerRegex);
  const stopRegexes = allHeaders.filter((h) => !sectionHeaders.includes(h)).map(headerRegex);
  const lines = fullText.split(/\n/);
  let capturing = false;
  const captured: string[] = [];

  for (const line of lines) {
    const normalizedLine = normalizeLoose(line);
    if (headerRegexes.some((rx) => rx.test(normalizedLine))) {
      capturing = true;
      continue; // skip the header line itself
    }
    // If we hit another section header while capturing, stop
    if (capturing && stopRegexes.some((rx) => rx.test(normalizedLine))) {
      break;
    }
    if (capturing) {
      captured.push(normalizedLine);
    }
  }

  return captured.join(" ").trim();
}

/**
 * Compare sections between candidate and reference report.
 */
function compareSections(candidateHtml: string, referenceHtml: string, locale: LocaleKey): {
  sectionScores: Record<string, number>;
  overallScore: number;
} {
  // BUG 2 FIX: Actually extract section content between headers and compare each separately
  // Replace <br> with newlines BEFORE stripping tags so sentence boundaries are preserved
  const candidateText = stripTags(candidateHtml.replace(/<br\s*\/?>/gi, "\n"));
  const referenceText = stripTags(referenceHtml.replace(/<br\s*\/?>/gi, "\n"));

  const sectionLabels = locale === "pt-BR"
    ? [
        { key: "analise", aliases: ["analise", "achados", "descricao"] },
        { key: "conclusao", aliases: ["conclusao", "impressao"] },
        { key: "tecnica", aliases: ["tecnica", "metodologia"] },
      ]
    : [
        { key: "findings", aliases: ["findings"] },
        { key: "impression", aliases: ["impression", "conclusion"] },
        { key: "technique", aliases: ["technique"] },
      ];

  const headerPatterns = sectionLabels.flatMap((section) => section.aliases);

  const sectionScores: Record<string, number> = {};
  let totalScore = 0;
  let count = 0;

  for (const section of sectionLabels) {
    const refContent = extractSectionText(referenceText, section.aliases, headerPatterns);
    const candContent = extractSectionText(candidateText, section.aliases, headerPatterns);

    // If reference has no content for this section, skip it
    const refTokens = refContent.split(/\s+/).filter((t) => t.length > 2);
    if (refTokens.length === 0) continue;

    const candTokens = candContent.split(/\s+/).filter((t) => t.length > 2);
    const refSet = new Set(refTokens);
    const candSet = new Set(candTokens);
    let overlap = 0;
    for (const t of refSet) {
      if (candSet.has(t)) overlap++;
    }

    const score = refSet.size > 0 ? (overlap / refSet.size) * 100 : 100;
    sectionScores[section.key] = Math.round(score);
    totalScore += score;
    count++;
  }

  return {
    sectionScores,
    overallScore: count > 0 ? Math.round(totalScore / count) : 0,
  };
}

function severityWeightedFallbackScore(checks: Check[]): number {
  if (checks.length === 0) return 100;
  const weight = (c: Check): number => (c.severity === "critical" ? 4 : c.severity === "major" ? 2 : 1);
  const total = checks.reduce((sum, c) => sum + weight(c), 0);
  const passed = checks.reduce((sum, c) => sum + (c.passed ? weight(c) : 0), 0);
  return Math.round((passed / total) * 100);
}

/**
 * Evaluate clinical quality of a report.
 * Uses gold data when available, falls back to structural checks.
 */
export function evaluateQuality(
  reportHtml: string,
  benchCase: BenchCase,
  locale: LocaleKey,
  _meta: ExamMeta,
  structuralChecks: Check[],
): EvaluatorResult {
  const checks: Check[] = [];
  const details: Record<string, unknown> = {};

  // Strategy 1: Gold findings available
  if (benchCase.goldFindings && benchCase.goldFindings.length > 0) {
    const scoredGoldFindings = benchCase.goldFindings.filter((g) => !isManagementOrDifferentialGold(g.finding));
    const unscoredGoldFindings = benchCase.goldFindings.filter((g) => isManagementOrDifferentialGold(g.finding));
    const { matches, hallucinations } = matchFindings(scoredGoldFindings, reportHtml, locale, benchCase, benchCase.goldFindings);
    const synthesis = synthesisPenalty(reportHtml, benchCase, locale);
    const score = Math.max(0, scoreFindingMatches(matches, hallucinations) - synthesis.penalty);

    details.mode = "gold-findings";
    details.findingMatches = matches;
    details.unscoredGoldFindings = unscoredGoldFindings.map((g) => g.finding);
    details.hallucinations = hallucinations;
    details.clinicalUtilityFloor = clinicalUtilityFloor(matches, hallucinations);
    details.synthesis = synthesis;

    const exactCount = matches.filter((m) => m.matchType === "exact").length;
    const partialCount = matches.filter((m) => m.matchType === "partial").length;
    const missedCount = matches.filter((m) => m.matchType === "missed").length;
    // The detection-rate gate is only critical when something clinically severe
    // was missed. Missing only minor findings is a deduction, not a case gate —
    // QG02 below separately gates critical-finding misses.
    const missedSevere = matches.some((m) => m.matchType === "missed" && (m.severity === "critical" || m.severity === "major"));

    if (matches.length > 0) {
      checks.push({
        dim: "QUAL",
        id: "QG01",
        name: "Gold finding detection rate",
        severity: missedSevere ? "critical" : "major",
        passed: missedCount === 0 || (exactCount + partialCount) / matches.length >= 0.8,
        evidence: `exact=${exactCount} partial=${partialCount} missed=${missedCount} total=${matches.length}`,
      });
    }

    // Critical findings must not be missed
    const criticalMissed = matches.filter((m) => m.matchType === "missed" && m.severity === "critical");
    if (criticalMissed.length > 0) {
      checks.push({
        dim: "QUAL",
        id: "QG02",
        name: "Critical findings not missed",
        severity: "critical",
        passed: false,
        evidence: `missed critical: ${criticalMissed.map((m) => m.goldFinding).join("; ")}`,
      });
    }

    // Hallucination check
    checks.push({
      dim: "QUAL",
      id: "QG03",
      name: "No significant hallucinations",
      severity: "major",
      passed: hallucinations.filter((h) => h.confidence === "high").length === 0,
      evidence: hallucinations.length > 0 ? `${hallucinations.length} potential hallucinations` : "ok",
    });

    checks.push({
      dim: "QUAL",
      id: "QG07",
      name: "Report synthesizes findings beyond input copy",
      severity: "major",
      passed: synthesis.penalty === 0,
      evidence: `copiedOutputRatio=${Math.round(synthesis.copiedOutputRatio * 100)}% addedTokens=${synthesis.addedTokenCount} clinicalAddedTokens=${synthesis.clinicalAddedTokenCount} reason=${synthesis.reason}`,
    });

    // Measurement preservation for gold findings
    const goldWithMeas = scoredGoldFindings.filter((g) => g.measurements && g.measurements.length > 0);
    if (goldWithMeas.length > 0) {
      const reportText = normalizeLoose(stripTags(reportHtml));
      let measPreserved = 0;
      let measTotal = 0;
      for (const g of goldWithMeas) {
        for (const m of g.measurements!) {
          measTotal++;
          if (measurementPresent(reportText, m)) measPreserved++;
        }
      }
      checks.push({
        dim: "QUAL",
        id: "QG04",
        name: "Gold finding measurements preserved",
        severity: "minor",
        passed: measTotal === 0 || measPreserved / measTotal >= 0.67,
        evidence: `${measPreserved}/${measTotal} measurements preserved`,
      });
    }

    // Impression synthesis: the conclusion is the most clinically-read section.
    // Each principal finding (non-negated, critical or major) must be reflected
    // in the impression. This rewards genuine synthesis and penalizes reports
    // that merely restate input findings and copy an arbitrary sentence as the
    // "impression" (a common gameable degenerate). Negated/minor findings are
    // not required in the impression.
    const principal = scoredGoldFindings.filter((g) => !g.negated && (g.severity === "critical" || g.severity === "major"));
    if (principal.length > 0) {
      const conclusionText = extractConclusionText(reportHtml, locale);
      if (conclusionText.trim().length > 0) {
        // Critical findings drive the gate: every critical finding must surface
        // in the impression. If a case has no criticals, the impression must
        // reflect at least one of the major findings. "Reflected" is lenient
        // (any distinctive term of the finding present) so genuine synthesis
        // ("M1 occlusion" for "occlusion of the M1 segment") passes, while an
        // impression that shares nothing with the principal finding fails.
        const criticals = principal.filter((g) => g.severity === "critical");
        const required = criticals.length > 0 ? criticals : principal;
        const sourceText = caseFindingsSourceText(benchCase);
        const missing = required.filter((g) => !findingReflectedInText(g.finding, conclusionText, sourceText));
        const passed = criticals.length > 0
          ? missing.length === 0
          : missing.length < required.length;
        // Quality signal, not a hard gate: a deficient impression drops QUAL to
        // PARTIAL and is surfaced in the report, but does not by itself FAIL the
        // case (critical-finding omission is already gated by CG01/CG02/QG02).
        checks.push({
          dim: "QUAL",
          id: "QG06",
          name: "Impression reflects the principal finding",
          severity: "major",
          passed,
          evidence: passed
            ? `principal finding(s) reflected in impression`
            : `impression does not address: ${missing.map((g) => g.finding).join("; ")}`,
        });
      }
    }

    // Laterality correctness for gold findings
    const goldWithLat = scoredGoldFindings.filter((g) => g.laterality);
    if (goldWithLat.length > 0) {
      const reportText = normalizeLoose(stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n")));
      const reportSentences = reportText.split(/[.\n;]/).map((s) => s.trim()).filter(Boolean);
      let latCorrect = 0;
      for (const g of goldWithLat) {
        if (lateralityMatches(g, reportSentences, reportText)) latCorrect++;
      }
      checks.push({
        dim: "QUAL",
        id: "QG05",
        name: "Gold finding laterality correct",
        severity: lateralityCheckSeverity(goldWithLat),
        passed: latCorrect === goldWithLat.length,
        evidence: `${latCorrect}/${goldWithLat.length} laterality correct`,
      });
    }

    return { dim: "QUAL", score: Math.round(score), checks, details };
  }

  // Strategy 2: Reference report available
  if (benchCase.referenceReport) {
    const comparison = compareSections(reportHtml, benchCase.referenceReport, locale);
    details.mode = "reference-comparison";
    details.sectionScores = comparison.sectionScores;

    checks.push({
      dim: "QUAL",
      id: "QR01",
      name: "Reference report similarity",
      severity: "major",
      passed: comparison.overallScore >= 50,
      evidence: `overall similarity: ${comparison.overallScore}%`,
    });

    return { dim: "QUAL", score: comparison.overallScore, checks, details };
  }

  // Strategy 3: Fall back to structural checks
  details.mode = "structural-fallback";
  const qualChecks = structuralChecks.filter((c) => c.dim === "QUAL");
  // Severity-weighted (anti-aesthetic): a minor formatting check must not count
  // as much as a critical content check even on the no-gold fallback path.
  const score = severityWeightedFallbackScore(qualChecks);

  return { dim: "QUAL", score, checks: qualChecks, details };
}
