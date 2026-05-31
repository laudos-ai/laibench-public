/**
 * Critical finding evaluator.
 * If case has criticalFindings gold labels: compute sensitivity/recall/precision/F1.
 * If no gold labels: fall back to structural banned-phrase checks.
 * Score is recall-weighted (missing a critical finding is worse than a false positive).
 */

import { getDefaultCriticalExtractor } from "../extractors/critical-extractor.js";
import { normalizeLoose } from "../normalize.js";
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

  // Strategy 1: Gold critical finding labels
  if (benchCase.criticalFindings && benchCase.criticalFindings.length > 0) {
    const result = matchCriticalFindings(benchCase.criticalFindings, reportHtml, locale);
    details.mode = "gold-critical";
    details.truePositives = result.truePositives;
    details.falseNegatives = result.falseNegatives;
    details.falsePositives = result.falsePositives.map((fp) => fp.text);
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
      severity: "major",
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

  // Strategy 2: Fall back to structural checks
  details.mode = "structural-fallback";
  const critChecks = structuralChecks.filter((c) => c.dim === "CRIT");
  const passCount = critChecks.filter((c) => c.passed).length;
  const totalCount = critChecks.length;
  const score = totalCount > 0 ? Math.round((passCount / totalCount) * 100) : 100;

  return { dim: "CRIT", score, checks: critChecks, details };
}
