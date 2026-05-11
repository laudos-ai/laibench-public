/**
 * Clinical quality evaluator.
 * If case has goldFindings: severity-aware finding matching (exact/partial/missed/hallucinated).
 * If case has referenceReport: section-level comparison.
 * Otherwise: falls back to structural checks (backward compat).
 */

import { extractFindings } from "../extract.js";
import { normalizeLoose, stripTags } from "../normalize.js";
import type { BenchCase, Check, EvaluatorResult, ExamMeta, FindingSeverity, GoldFinding, LocaleKey } from "../types.js";

// ---------------------------------------------------------------------------
// Medical synonym groups (Portuguese + English radiology terminology)
// Each sub-array contains terms that are clinically equivalent.
// All entries are lowercase; accents are stripped at lookup time via normalizeLoose.
// ---------------------------------------------------------------------------
const SYNONYM_GROUPS: string[][] = [
  // 1 – Pulmonary consolidation
  ["consolidacao", "opacidade alveolar", "consolidation", "airspace opacity", "opacidade parenquimatosa"],
  // 2 – Fracture
  ["fratura", "descontinuidade ossea", "fracture", "osseous discontinuity", "traco de fratura"],
  // 3 – Pleural effusion
  ["derrame pleural", "liquido pleural", "pleural effusion", "liquido no espaco pleural"],
  // 4 – Pulmonary nodule
  ["nodulo", "lesao focal", "nodule", "focal lesion", "nodulo pulmonar", "pulmonary nodule"],
  // 5 – Hepatic steatosis
  ["esteatose", "infiltracao gordurosa", "fatty infiltration", "steatosis", "esteatose hepatica", "hepatic steatosis"],
  // 6 – Hemangioma
  ["hemangioma", "lesao vascular hepatica", "hepatic hemangioma", "lesao vascular"],
  // 7 – Disc herniation
  ["hernia discal", "protrusao discal", "disc herniation", "disc protrusion", "herniacao discal", "extrusao discal", "disc extrusion"],
  // 8 – Stenosis / narrowing
  ["estenose", "estreitamento", "stenosis", "narrowing"],
  // 9 – Dilation / ectasia
  ["dilatacao", "ectasia", "dilation", "ectasia", "dilatacao ductal"],
  // 10 – Calcification
  ["calcificacao", "calcificacao vascular", "calcification", "vascular calcification"],
  // 11 – Lymphadenopathy
  ["linfonodomegalia", "linfonodo aumentado", "lymphadenopathy", "adenopatia", "linfonodos aumentados"],
  // 12 – Thromboembolism
  ["tromboembolismo", "embolia", "thromboembolism", "embolism", "tromboembolia pulmonar", "pulmonary embolism"],
  // 13 – Hydronephrosis
  ["hidronefrose", "dilatacao pielocalicinal", "hydronephrosis", "dilatacao do sistema coletor"],
  // 14 – Pneumothorax
  ["pneumotorax", "ar no espaco pleural", "pneumothorax"],
  // 15 – Atelectasis
  ["atelectasia", "colapso pulmonar", "atelectasis", "lung collapse", "atelectasia subsegmentar", "subsegmental atelectasis"],
  // 16 – Edema
  ["edema", "congestao", "edema pulmonar", "pulmonary edema", "congestion"],
  // 17 – Aneurysm
  ["aneurisma", "dilatacao aneurismatica", "aneurysm", "aneurysmal dilation"],
  // 18 – Pneumonia
  ["pneumonia", "processo infeccioso pulmonar", "pulmonary infection", "foco pneumonico", "infectious process"],
  // 19 – Mass / tumor
  ["massa", "tumor", "neoplasia", "lesao expansiva", "mass", "tumor", "neoplasm", "space-occupying lesion"],
  // 20 – Cyst
  ["cisto", "formacao cistica", "cyst", "cystic lesion", "cisto simples", "simple cyst"],
  // 21 – Fibrosis
  ["fibrose", "alteracoes fibrocicatriciais", "fibrosis", "fibrotic changes", "estrias fibrocicatriciais"],
  // 22 – Ground-glass opacity
  ["vidro fosco", "opacidade em vidro fosco", "ground-glass opacity", "ground glass", "ggo"],
  // 23 – Cardiomegaly
  ["cardiomegalia", "aumento da area cardiaca", "cardiomegaly", "cardiac enlargement", "indice cardiotoraco aumentado"],
  // 24 – Splenomegaly
  ["esplenomegalia", "baco aumentado", "splenomegaly", "splenic enlargement"],
  // 25 – Hepatomegaly
  ["hepatomegalia", "figado aumentado", "hepatomegaly", "hepatic enlargement"],
  // 26 – Scoliosis
  ["escoliose", "desvio lateral da coluna", "scoliosis", "lateral curvature"],
  // 27 – Degenerative changes
  ["alteracoes degenerativas", "espondiloartrose", "degenerative changes", "spondylosis", "osteoartrose", "osteoarthritis"],
  // 28 – Emphysema
  ["enfisema", "hiperinsuflacao", "emphysema", "hyperinflation", "enfisema pulmonar"],
  // 29 – Bronchiectasis
  ["bronquiectasias", "dilatacao bronquica", "bronchiectasis", "bronchial dilation"],
  // 30 – Thrombosis
  ["trombose", "trombo", "thrombosis", "thrombus"],
];

// Build a lookup map: normalized term -> Set of all normalized synonyms in its group
const _synonymMap = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  // Normalize every entry the same way tokens are normalized at comparison time
  const normalized = group.map((t) => normalizeLoose(t));
  const fullSet = new Set(normalized);
  for (const term of normalized) {
    const existing = _synonymMap.get(term);
    if (existing) {
      for (const s of fullSet) existing.add(s);
    } else {
      _synonymMap.set(term, new Set(fullSet));
    }
  }
}

/**
 * Expand a set of tokens with their synonyms.
 * For every *contiguous n-gram* (1-, 2-, 3-token) present in `tokens` that
 * appears in the synonym map, add all synonyms of its group (split into
 * individual words) to the returned set.
 */
function expandWithSynonyms(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  const arr = [...tokens];

  // Check n-grams of length 1..3
  for (let n = 1; n <= Math.min(3, arr.length); n++) {
    for (let i = 0; i <= arr.length - n; i++) {
      const ngram = arr.slice(i, i + n).join(" ");
      const syns = _synonymMap.get(ngram);
      if (syns) {
        for (const syn of syns) {
          // Each synonym phrase may itself be multi-word; add individual tokens
          for (const word of syn.split(/\s+/)) {
            if (word.length > 2) expanded.add(word);
          }
        }
      }
    }
  }
  return expanded;
}

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
  return normalizedReport.includes(normalizedMeasurement);
}

// Severity weights for scoring
const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  critical: 4.0,
  major: 2.5,
  minor: 1.0,
  incidental: 0.5,
};

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
 * Token sets are first expanded with medical synonyms so that clinically
 * equivalent terms (e.g. "consolidation" vs "airspace opacity") count as
 * overlapping.
 */
function tokenSimilarity(a: string, b: string): number {
  const rawA = new Set(normalizeLoose(a).split(/\s+/).filter((t) => t.length > 2));
  const rawB = new Set(normalizeLoose(b).split(/\s+/).filter((t) => t.length > 2));
  if (rawA.size === 0 || rawB.size === 0) return 0;

  const tokensA = expandWithSynonyms(rawA);
  const tokensB = expandWithSynonyms(rawB);

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Match gold findings against extracted report findings.
 */
function matchFindings(goldFindings: GoldFinding[], reportHtml: string, locale: LocaleKey): {
  matches: FindingMatchResult[];
  hallucinations: HallucinationResult[];
} {
  const extractedFindings = extractFindings(reportHtml, locale);
  const reportText = normalizeLoose(stripTags(reportHtml));
  const matches: FindingMatchResult[] = [];
  const usedExtracted = new Set<number>();

  for (const gold of goldFindings) {
    const goldNorm = normalizeLoose(gold.finding);

    // Try exact substring match first
    if (reportText.includes(goldNorm)) {
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
      const goldTokens = goldNorm.split(/\s+/).filter((t) => t.length > 3);
      const matchedTokens = goldTokens.filter((t) => reportText.includes(t));
      const tokenRatio = goldTokens.length > 0 ? matchedTokens.length / goldTokens.length : 0;

      if (tokenRatio >= 0.5) {
        matches.push({
          goldFinding: gold.finding,
          severity: gold.severity,
          matchType: "partial",
          matchedText: matchedTokens.join(" "),
          score: tokenRatio * 0.7, // Cap partial at 0.7
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
  const goldNorms = goldFindings.map((g) => normalizeLoose(g.finding));

  for (let i = 0; i < extractedFindings.length; i++) {
    if (usedExtracted.has(i)) continue;
    const ef = extractedFindings[i];

    // BUG 3 FIX: Pertinent negatives are NOT hallucinations.
    // Normal/negative findings like "Lungs are clear", "No pleural effusion" are clinically required.
    const efNorm = normalizeLoose(ef.text);
    const isPertinentNegative =
      /\bsem\b|\bausencia\b|\bnormal\b|\bpreservad|\bno\s|\bclear\b|\bunremarkable\b|\bwithout\b|\bnegative\b|\bwithin normal\b|\bsem alterac/i.test(efNorm);
    if (isPertinentNegative) continue;

    // Check if this finding has any similarity to the input findings
    const maxSim = Math.max(0, ...goldNorms.map((g) => tokenSimilarity(g, ef.text)));
    if (maxSim < 0.2 && ef.severity !== "incidental") {
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

/**
 * Extract the text content of a section from the full text, given section header patterns.
 * Sections are delimited by headers matching sectionHeaders entries.
 */
function extractSectionText(
  fullText: string,
  sectionHeaders: string[],
  allHeaders: string[],
): string {
  const headerRegexes = sectionHeaders.map((header) => new RegExp(`\\b${header}\\b`, "i"));
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
    if (capturing && allHeaders.some((h) => !sectionHeaders.includes(h) && new RegExp(`\\b${h}\\b`, "i").test(normalizeLoose(line)))) {
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
    const { matches, hallucinations } = matchFindings(benchCase.goldFindings, reportHtml, locale);
    const score = scoreFindingMatches(matches, hallucinations);

    details.mode = "gold-findings";
    details.findingMatches = matches;
    details.hallucinations = hallucinations;
    details.clinicalUtilityFloor = clinicalUtilityFloor(matches, hallucinations);

    const exactCount = matches.filter((m) => m.matchType === "exact").length;
    const partialCount = matches.filter((m) => m.matchType === "partial").length;
    const missedCount = matches.filter((m) => m.matchType === "missed").length;

    checks.push({
      dim: "QUAL",
      id: "QG01",
      name: "Gold finding detection rate",
      severity: "critical",
      passed: missedCount === 0 || (exactCount + partialCount) / matches.length >= 0.8,
      evidence: `exact=${exactCount} partial=${partialCount} missed=${missedCount} total=${matches.length}`,
    });

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

    // Measurement preservation for gold findings
    const goldWithMeas = benchCase.goldFindings.filter((g) => g.measurements && g.measurements.length > 0);
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

    // Laterality correctness for gold findings
    const goldWithLat = benchCase.goldFindings.filter((g) => g.laterality);
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
  const passCount = qualChecks.filter((c) => c.passed).length;
  const totalCount = qualChecks.length;
  const score = totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 100;

  return { dim: "QUAL", score, checks: qualChecks, details };
}
