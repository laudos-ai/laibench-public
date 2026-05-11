import { round1 } from "./normalize.js";
import type { PolicyProfile } from "./policies.js";
import type { Check, Dim, DimSummary, EvaluatorResult, JudgeResult, Verdict, Confidence } from "./types.js";

export const DIMS: Dim[] = ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"];
export const WEIGHTS: Record<Dim, number> = {
  CRIT: 0.3,
  QUAL: 0.25,
  TERM: 0.2,
  GUIDE: 0.15,
  RAG: 0.1,
};

export type ScoreCombinationMode = "conservative-min" | "judge-primary";

function judgeScoreTo100(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value <= 5) return round1(value * 20);
  return round1(Math.max(0, Math.min(100, value)));
}

export function scoreDimensions(checks: Check[]): { dims: Record<Dim, DimSummary>; overall: number } {
  const dims = {} as Record<Dim, DimSummary>;
  const scoredDims: Dim[] = [];

  for (const dim of DIMS) {
    const dimChecks = checks.filter((check) => check.dim === dim);

    if (dimChecks.length === 0) {
      dims[dim] = { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 };
      continue;
    }

    scoredDims.push(dim);
    const pass = dimChecks.filter((check) => check.passed).length;
    const total = dimChecks.length;
    const critFails = dimChecks.filter((check) => !check.passed && check.severity === "critical").length;
    const majorFails = dimChecks.filter((check) => !check.passed && check.severity === "major").length;

    let score = round1((pass / total) * 100);
    if (critFails > 0) score = Math.min(score, Math.max(20, 60 - Math.min(critFails - 1, 2) * 20));
    else if (majorFails >= 3) score = Math.min(score, 70);

    const verdict: Verdict = critFails > 0 ? "FAIL" : pass === total ? "PASS" : score >= 80 ? "PARTIAL" : "FAIL";
    dims[dim] = { score, pass, total, critFails, verdict, appliedWeight: 0 };
  }

  const totalWeight = scoredDims.reduce((sum, dim) => sum + WEIGHTS[dim], 0) || 1;
  let overall = 0;

  for (const dim of scoredDims) {
    const appliedWeight = WEIGHTS[dim] / totalWeight;
    dims[dim].appliedWeight = appliedWeight;
    overall += (dims[dim].score ?? 0) * appliedWeight;
  }

  return { dims, overall: round1(overall) };
}

/**
 * Score dimensions using evaluator results alongside legacy checks.
 * Evaluator results provide direct scores (0-100) that override the check-based scoring
 * for their dimension. Checks from evaluators are still tracked for reporting.
 */
export function scoreDimensionsWithEvaluators(
  checks: Check[],
  evaluatorResults: EvaluatorResult[],
): { dims: Record<Dim, DimSummary>; overall: number } {
  // Start with the basic check-based scoring
  const baseResult = scoreDimensions(checks);

  // Overlay evaluator scores where available
  const scoredDims: Dim[] = [];
  for (const dim of DIMS) {
    const evalResult = evaluatorResults.find((e) => e.dim === dim);
    if (evalResult && evalResult.score >= 0) {
      // Evaluator provides a direct 0-100 score
      const score = round1(Math.max(0, Math.min(100, evalResult.score)));
      const evalChecks = evalResult.checks;
      const pass = evalChecks.filter((c) => c.passed).length;
      const total = evalChecks.length;
      const critFails = evalChecks.filter((c) => !c.passed && c.severity === "critical").length;

      const verdict: Verdict = critFails > 0 ? "FAIL" : score >= 80 ? (pass === total ? "PASS" : "PARTIAL") : score >= 50 ? "PARTIAL" : "FAIL";
      baseResult.dims[dim] = { score, pass, total, critFails, verdict, appliedWeight: 0 };
      scoredDims.push(dim);
    } else if (baseResult.dims[dim].score !== null) {
      scoredDims.push(dim);
    }
  }

  // Recompute weighted overall
  const totalWeight = scoredDims.reduce((sum, dim) => sum + WEIGHTS[dim], 0) || 1;
  let overall = 0;

  for (const dim of scoredDims) {
    const appliedWeight = WEIGHTS[dim] / totalWeight;
    baseResult.dims[dim].appliedWeight = appliedWeight;
    overall += (baseResult.dims[dim].score ?? 0) * appliedWeight;
  }

  baseResult.overall = round1(overall);
  return baseResult;
}

export function combineScores(
  detDims: Record<Dim, DimSummary>,
  adv: JudgeResult | null,
  checks: Check[],
  policy?: PolicyProfile,
  scoreMode: ScoreCombinationMode = "conservative-min",
): {
  combined: Record<Dim, number | null>;
  overall: number;
  verdict: Exclude<Verdict, "UNSCORED">;
  phaseStatus: "complete" | "degraded";
  confidence: Confidence;
  gateReasons: string[];
} {
  // BUG C FIX: Use policy thresholds when provided, otherwise use defaults
  const passThreshold = policy?.passThreshold ?? 84;
  const partialThreshold = policy?.partialThreshold ?? 60;
  const criticalFailForces = policy?.criticalFailForces ?? true;

  const combined = Object.fromEntries(DIMS.map((dim) => [dim, null])) as Record<Dim, number | null>;
  const scoredDims = DIMS.filter((dim) => detDims[dim].score !== null);

  let totalWeight = 0;
  let overall = 0;

  for (const dim of scoredDims) {
    const det = detDims[dim].score;
    const judge = judgeScoreTo100(adv?.scores?.[dim]);
    if (det === null) combined[dim] = null;
    else if (judge === null) combined[dim] = det;
    else combined[dim] = scoreMode === "judge-primary" ? judge : Math.min(det, judge);
    totalWeight += WEIGHTS[dim];
  }

  for (const dim of scoredDims) {
    const score = combined[dim];
    if (score === null) continue;
    overall += score * (WEIGHTS[dim] / totalWeight);
  }

  overall = round1(overall);

  const hasDetCritical = checks.some((check) => !check.passed && check.severity === "critical");
  const hasJudgeCritical = (adv?.critical_failures.length ?? 0) > 0;
  const phaseStatus = adv ? "complete" : "degraded";
  const gateReasons: string[] = [];

  if (hasDetCritical) gateReasons.push("deterministic critical failure");
  if (hasJudgeCritical) gateReasons.push("adversarial critical failure");
  if (!adv) gateReasons.push("adversarial phase unavailable");

  let verdict: Exclude<Verdict, "UNSCORED">;
  if (criticalFailForces && (hasDetCritical || hasJudgeCritical)) verdict = "FAIL";
  else if (overall >= passThreshold) verdict = "PASS";
  else if (overall >= partialThreshold) verdict = "PARTIAL";
  else verdict = "FAIL";

  let confidence: Confidence = adv ? "high" : "low";
  if (!adv && overall >= 80 && !hasDetCritical) confidence = "medium";
  if (adv && (adv.hallucinated.length > 0 || adv.missing.length > 0 || overall < passThreshold)) confidence = "medium";

  return { combined, overall, verdict, phaseStatus, confidence, gateReasons };
}
