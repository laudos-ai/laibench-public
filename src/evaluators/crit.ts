/**
 * Critical finding evaluator.
 * If case has criticalFindings gold labels: compute sensitivity/recall/precision/F1.
 * If no gold labels: fall back to structural banned-phrase checks.
 * Score is recall-weighted (missing a critical finding is worse than a false positive).
 */

import { getDefaultCriticalExtractor } from "../extractors/critical-extractor.js";
import { extractCriticalMentions, hasNegationCue, isFindingNegated, CRITICAL_KEYWORDS_PT, CRITICAL_KEYWORDS_EN } from "../extract.js";
import { clinicalTokenCoverage, isManagementOrDifferentialGold } from "../clinical-match.js";
import { normalizeLoose, stripTags } from "../normalize.js";
import type { BenchCase, Check, EvaluatorResult, ExamMeta, LocaleKey } from "../types.js";

/**
 * Match critical finding labels from gold against mentions in the report,
 * delegating to the active (pluggable) critical-finding extractor. The default
 * is the keyword/substring + token-overlap matcher with negation awareness;
 * swapping in a validated model-based extractor is a one-call change via
 * setDefaultCriticalExtractor (see src/extractors/critical-extractor.ts).
 */
function matchCriticalFindings(goldLabels: string[], reportHtml: string, locale: LocaleKey) {
  return getDefaultCriticalExtractor().detect(goldLabels, reportHtml, locale);
}

function isScoredCriticalLabel(label: string, locale: LocaleKey): boolean {
  if (isManagementOrDifferentialGold(label)) return false;
  // Clause-scoped negation, anchored on the critical term. A whole-label
  // hasNegationCue() check dropped an AFFIRMED critical whenever the label also
  // carried an unrelated pertinent negative ("Acute hemorrhage, no midline
  // shift"; "Hematoma subdural agudo, sem desvio da linha media"), un-gating a
  // real critical miss. We instead score the label if ANY recognized critical
  // anchor is affirmed within its own clause (handles either ordering of the
  // affirmed and negated parts). When the label contains no recognized critical
  // anchor to clause-scope on, fall back to the original whole-label check so a
  // pure pertinent negative ("No testicular torsion", "Sem hemorragia") is still
  // correctly excluded.
  const anchorRx = locale === "en-US" ? CRITICAL_KEYWORDS_EN : CRITICAL_KEYWORDS_PT;
  const anchors = label.match(new RegExp(anchorRx.source, "gi")) ?? [];
  if (anchors.length === 0) return !hasNegationCue(label, locale);
  return anchors.some((anchor) => !isFindingNegated(label, anchor, locale));
}

function criticalSourceText(benchCase: BenchCase): string {
  return stripTags([
    benchCase.findings,
    benchCase.referenceReport ?? "",
    ...(benchCase.goldFindings ?? []).map((finding) => finding.finding),
  ].join("\n"));
}

/** Source split into clauses for polarity-aware best-clause matching. */
function criticalSourceClauses(benchCase: BenchCase): string[] {
  return criticalSourceText(benchCase)
    .replace(/<br\s*\/?>/gi, "\n")
    .split(/[.\n;]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * crit-extract-1 / CG05: source-backing must be polarity-aware. The lexical
 * coverage that gates suppression (clinicalTokenCoverage) strips negation tokens
 * as stopwords, so a critical the SOURCE only ever stated as a pertinent NEGATIVE
 * ("No tension pneumothorax") would lexically "cover" a report that FABRICATES it
 * as present ("tension pneumothorax present") and wrongly suppress the fabricated
 * critical. We therefore suppress a report mention as source-backed ONLY when the
 * best-matching source clause AFFIRMS the same critical. If the best-matching
 * source clause NEGATED the critical, the report's affirmation is unsupported and
 * must NOT be suppressed (it counts as a fabricated critical).
 */
function isSourceBackedCriticalMention(text: string, benchCase: BenchCase, locale: LocaleKey): boolean {
  const clauses = criticalSourceClauses(benchCase);
  if (clauses.length === 0) return false;

  // Best-matching source clause by lexical coverage of the report mention.
  let bestClause = "";
  let bestCoverage = 0;
  for (const clause of clauses) {
    const coverage = clinicalTokenCoverage(text, clause);
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestClause = clause;
    }
  }
  if (bestCoverage < 0.55) return false;

  // Polarity gate: the report mention is an AFFIRMED critical (it came from
  // extractCriticalMentions, which already filters clause-negated mentions). It
  // is genuinely source-backed only if the matched source clause likewise
  // AFFIRMS that critical. Anchor on the critical term(s) shared with the report
  // mention; if any such anchor is negated in the source clause, the source did
  // NOT affirm it, so do not suppress.
  const anchorRx = locale === "en-US" ? CRITICAL_KEYWORDS_EN : CRITICAL_KEYWORDS_PT;
  const anchors = text.match(new RegExp(anchorRx.source, "gi")) ?? [];
  if (anchors.length === 0) {
    // No recognized critical anchor in the report mention to polarity-check on;
    // fall back to a whole-clause cue so an outright negated source clause still
    // blocks suppression.
    return !hasNegationCue(bestClause, locale);
  }
  // Suppress only if at least one shared critical anchor is AFFIRMED in the
  // matched source clause (i.e. the source genuinely backs the critical).
  return anchors.some((anchor) => bestClause.toLowerCase().includes(anchor.toLowerCase()) && !isFindingNegated(bestClause, anchor, locale));
}

function withSourceBackedFalsePositivesRemoved(
  result: ReturnType<typeof matchCriticalFindings>,
  benchCase: BenchCase,
  locale: LocaleKey,
) {
  const falsePositives = result.falsePositives.filter((fp) => !isSourceBackedCriticalMention(fp.text, benchCase, locale));
  const excludedFalsePositives = result.falsePositives.filter((fp) => isSourceBackedCriticalMention(fp.text, benchCase, locale));
  const tp = result.truePositives.length;
  const fn = result.falseNegatives.length;
  const fp = falsePositives.length;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return { ...result, falsePositives, excludedFalsePositives, recall, precision, f1 };
}

/**
 * Evaluate critical finding detection.
 * Uses gold data when available, falls back to structural checks.
 */
export function evaluateCritical(
  reportHtml: string,
  benchCase: BenchCase,
  locale: LocaleKey,
  _meta: ExamMeta,
  structuralChecks: Check[],
): EvaluatorResult {
  const checks: Check[] = [];
  const details: Record<string, unknown> = {};
  const explicitCriticalFindings = benchCase.criticalFindings ?? [];
  const goldCriticalFindings = (benchCase.goldFindings ?? [])
    .filter((finding) => finding.severity === "critical" && !finding.negated && isScoredCriticalLabel(finding.finding, locale))
    .map((finding) => finding.finding);
  const criticalLabels = (explicitCriticalFindings.length > 0 ? explicitCriticalFindings : goldCriticalFindings)
    .filter((label) => isScoredCriticalLabel(label, locale));

  // Strategy 1: Gold critical finding labels
  if (criticalLabels.length > 0) {
    const result = withSourceBackedFalsePositivesRemoved(
      matchCriticalFindings(criticalLabels, reportHtml, locale),
      benchCase,
      locale,
    );
    details.mode = "gold-critical";
    details.source = explicitCriticalFindings.length > 0 ? "criticalFindings" : "goldFindings";
    details.truePositives = result.truePositives;
    details.falseNegatives = result.falseNegatives;
    details.falsePositives = result.falsePositives.map((fp) => fp.text);
    details.excludedSourceBackedFalsePositives = result.excludedFalsePositives.map((fp) => fp.text);
    details.recall = result.recall;
    details.precision = result.precision;
    details.f1 = result.f1;

    // Recall check (most important - missing a critical finding is dangerous)
    checks.push({
      dim: "CRIT",
      id: "CG01",
      name: "Critical finding recall",
      severity: "critical",
      passed: result.recall >= 0.9,
      evidence: `recall=${(result.recall * 100).toFixed(0)}% (TP=${result.truePositives.length} FN=${result.falseNegatives.length})`,
    });

    // Each missed critical finding is a separate critical failure
    for (const missed of result.falseNegatives) {
      checks.push({
        dim: "CRIT",
        id: `CG02-${normalizeLoose(missed).replace(/\s+/g, "-").slice(0, 20)}`,
        name: `Missed critical finding: ${missed}`,
        severity: "critical",
        passed: false,
        evidence: `not found in report`,
      });
    }

    // Precision check (false positives are bad but less than false negatives)
    checks.push({
      dim: "CRIT",
      id: "CG03",
      name: "Critical finding precision",
      severity: result.falsePositives.length > 0 ? "critical" : "major",
      passed: result.precision >= 0.7,
      evidence: `precision=${(result.precision * 100).toFixed(0)}% (FP=${result.falsePositives.length})`,
    });

    // F1 check
    checks.push({
      dim: "CRIT",
      id: "CG04",
      name: "Critical finding F1 score",
      severity: "major",
      passed: result.f1 >= 0.8,
      evidence: `F1=${(result.f1 * 100).toFixed(0)}%`,
    });

    // Score: recall-weighted (0.7 recall + 0.3 precision)
    const score = Math.round(result.recall * 70 + result.precision * 30);
    return { dim: "CRIT", score, checks, details };
  }

  if ((benchCase.goldFindings?.length ?? 0) > 0) {
    const sourceBackedCriticalMentions = extractCriticalMentions(reportHtml, locale)
      .filter((fp) => isSourceBackedCriticalMention(fp.text, benchCase, locale));
    const unexpectedCriticalMentions = extractCriticalMentions(reportHtml, locale)
      .filter((fp) => !isSourceBackedCriticalMention(fp.text, benchCase, locale));
    details.mode = "gold-critical-none";
    details.source = "goldFindings";
    details.falsePositives = unexpectedCriticalMentions.map((fp) => fp.text);
    details.excludedSourceBackedFalsePositives = sourceBackedCriticalMentions.map((fp) => fp.text);
    if (unexpectedCriticalMentions.length > 0) {
      checks.push({
        dim: "CRIT",
        id: "CG00",
        name: "No unexpected critical finding",
        severity: "critical",
        passed: false,
        evidence: `unexpected critical mention(s): ${unexpectedCriticalMentions.map((fp) => fp.text).join("; ")}`,
      });
      return { dim: "CRIT", score: 0, checks, details };
    }
    checks.push({
      dim: "CRIT",
      id: "CG00",
      name: "No gold critical finding expected",
      severity: "minor",
      passed: true,
      evidence: "goldFindings contain no affirmative critical-severity finding",
    });
    return { dim: "CRIT", score: 100, checks, details };
  }

  // Strategy 2: Fall back to structural checks
  details.mode = "structural-fallback";
  const critChecks = structuralChecks.filter((c) => c.dim === "CRIT");
  // Severity-weighted (anti-aesthetic): a minor check must not count as much as
  // a critical content check on the no-gold fallback path.
  const score = ((): number => {
    if (critChecks.length === 0) return 100;
    const weight = (c: Check): number => (c.severity === "critical" ? 4 : c.severity === "major" ? 2 : 1);
    const total = critChecks.reduce((sum, c) => sum + weight(c), 0);
    const passed = critChecks.reduce((sum, c) => sum + (c.passed ? weight(c) : 0), 0);
    return Math.round((passed / total) * 100);
  })();

  return { dim: "CRIT", score, checks: critChecks, details };
}
