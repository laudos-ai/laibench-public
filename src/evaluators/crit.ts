/**
 * Critical finding evaluator.
 * If case has criticalFindings gold labels: compute sensitivity/recall/precision/F1.
 * If no gold labels: fall back to structural banned-phrase checks.
 * Score is recall-weighted (missing a critical finding is worse than a false positive).
 */

import { extractCriticalMentions, isNegated, type ExtractedCriticalMention } from "../extract.js";
import { normalizeLoose, stripTags } from "../normalize.js";
import type { BenchCase, Check, EvaluatorResult, ExamMeta, LocaleKey } from "../types.js";

/**
 * Match critical finding labels from gold against mentions in the report.
 * Uses both exact substring matching and semantic matching via keyword overlap.
 */
/**
 * Find the sentence in the report text that contains the matched gold label.
 * Splits on sentence boundaries and returns the first sentence containing the match.
 */
function findMatchingSentence(reportHtml: string, goldNorm: string): string | null {
  const text = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 3);
  for (const sentence of sentences) {
    if (normalizeLoose(sentence).includes(goldNorm)) {
      return sentence;
    }
  }
  return null;
}

/**
 * Find the sentence that best matches a set of gold tokens (for token-level matching).
 */
function findBestTokenMatchSentence(reportHtml: string, goldTokens: string[]): string | null {
  const text = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 3);
  let bestSentence: string | null = null;
  let bestRatio = 0;
  for (const sentence of sentences) {
    const norm = normalizeLoose(sentence);
    const matched = goldTokens.filter((t) => norm.includes(t));
    const ratio = goldTokens.length > 0 ? matched.length / goldTokens.length : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestSentence = sentence;
    }
  }
  return bestRatio >= 0.5 ? bestSentence : null;
}

function matchCriticalFindings(
  goldLabels: string[],
  reportHtml: string,
  locale: LocaleKey,
): {
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: ExtractedCriticalMention[];
  recall: number;
  precision: number;
  f1: number;
} {
  const reportText = normalizeLoose(stripTags(reportHtml));
  const extractedMentions = extractCriticalMentions(reportHtml, locale);
  const usedMentions = new Set<number>();

  const truePositives: string[] = [];
  const falseNegatives: string[] = [];

  for (const goldLabel of goldLabels) {
    const goldNorm = normalizeLoose(goldLabel);

    // Try direct substring match first
    if (reportText.includes(goldNorm)) {
      // BUG A FIX: Check if the matched region is negated before counting as TP
      const matchingSentence = findMatchingSentence(reportHtml, goldNorm);
      if (matchingSentence && isNegated(matchingSentence, locale)) {
        // Negated context — this is a miss, not a hit
        falseNegatives.push(goldLabel);
        continue;
      }

      truePositives.push(goldLabel);
      // Find the matching extracted mention to mark as used
      for (let i = 0; i < extractedMentions.length; i++) {
        if (usedMentions.has(i)) continue;
        if (normalizeLoose(extractedMentions[i].text).includes(goldNorm)) {
          usedMentions.add(i);
          break;
        }
      }
      continue;
    }

    // Try token-level matching
    const goldTokens = goldNorm.split(/\s+/).filter((t) => t.length > 2);
    const matchedTokens = goldTokens.filter((t) => reportText.includes(t));
    const tokenRatio = goldTokens.length > 0 ? matchedTokens.length / goldTokens.length : 0;

    if (tokenRatio >= 0.5) {
      // BUG A FIX: Check if the best matching sentence is negated
      const bestSentence = findBestTokenMatchSentence(reportHtml, goldTokens);
      if (bestSentence && isNegated(bestSentence, locale)) {
        falseNegatives.push(goldLabel);
        continue;
      }

      truePositives.push(goldLabel);
      // Find best matching extracted mention
      let bestIdx = -1;
      let bestSim = 0;
      for (let i = 0; i < extractedMentions.length; i++) {
        if (usedMentions.has(i)) continue;
        const mentionNorm = normalizeLoose(extractedMentions[i].text);
        const sim = goldTokens.filter((t) => mentionNorm.includes(t)).length / goldTokens.length;
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
      }
      if (bestIdx >= 0) usedMentions.add(bestIdx);
    } else {
      falseNegatives.push(goldLabel);
    }
  }

  // False positives: extracted critical mentions not matched to any gold label
  const falsePositives: ExtractedCriticalMention[] = [];
  for (let i = 0; i < extractedMentions.length; i++) {
    if (!usedMentions.has(i)) {
      // Only count as FP if it's a genuinely critical mention, not just incidental
      const mentionText = normalizeLoose(extractedMentions[i].text);
      // Check if this mention has any overlap with gold labels
      const hasAnyOverlap = goldLabels.some((gl) => {
        const tokens = normalizeLoose(gl).split(/\s+/).filter((t) => t.length > 2);
        return tokens.some((t) => mentionText.includes(t));
      });
      if (!hasAnyOverlap) {
        falsePositives.push(extractedMentions[i]);
      }
    }
  }

  const tp = truePositives.length;
  const fn = falseNegatives.length;
  const fp = falsePositives.length;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;

  return { truePositives, falseNegatives, falsePositives, recall, precision, f1 };
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
