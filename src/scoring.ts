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

/**
 * The judge contract (buildJudgePrompt) requests scores on a 0-100 scale, but a
 * 0-5 Likert convention is also accepted (calibration fixtures, legacy judges).
 * We disambiguate the scale at the RESULT level, never per value: a result is
 * read as Likert only when EVERY emitted dimension score is <= 5. A single
 * catastrophic 0-100 score (e.g. CRIT=3 alongside QUAL=88) is therefore read as
 * a genuine low score, not silently multiplied by 20 into a passing 60.
 *
 * The previous per-value rule (value <= 5 ? value * 20) inflated the worst
 * reports across the exact 5/6 boundary, which is the unsafe failure direction
 * for a safety benchmark. Residual limit: a fully catastrophic 0-100 result
 * whose every dimension is <= 5 is indistinguishable from a 1/5 Likert result
 * without an explicit scale, so it is still treated as Likert. conservative-min
 * and the deterministic/adversarial critical-finding veto catch that case.
 */
export function judgeScoresAreLikert(values: Array<number | null | undefined>): boolean {
  const nums = values.filter((value): value is number => typeof value === "number" && !Number.isNaN(value));
  return nums.length > 0 && nums.every((value) => value <= 5);
}

function judgeScoreTo100(value: number | null | undefined, likert: boolean): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (likert) return round1(Math.max(0, Math.min(100, value * 20)));
  return round1(Math.max(0, Math.min(100, value)));
}

function severityCap(
  checks: Check[],
  judgeCriticalFailures: number,
): { cap: number; reason: string } | null {
  const failed = checks.filter((check) => !check.passed);
  const criticalCount = failed.filter((check) => check.severity === "critical").length + judgeCriticalFailures;
  const majorCount = failed.filter((check) => check.severity === "major").length;
  const severeWeight = criticalCount * 4 + majorCount * 2;

  if (severeWeight <= 0) return null;
  return {
    cap: criticalCount > 0 ? 59.9 : round1(Math.max(0, 99.9 - 4 * severeWeight)),
    reason: criticalCount > 0 ? "severity cap: critical failure" : `severity cap: severe failure weight ${severeWeight}`,
  };
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
      let score = round1(Math.max(0, Math.min(100, evalResult.score)));
      const evalChecks = evalResult.checks;
      const pass = evalChecks.filter((c) => c.passed).length;
      const total = evalChecks.length;
      const critFails = evalChecks.filter((c) => !c.passed && c.severity === "critical").length;
      const majorFails = evalChecks.filter((c) => !c.passed && c.severity === "major").length;

      // Parity with scoreDimensions: a critically-failing dimension cannot keep a
      // high numeric score. Without this cap the evaluator overlay would inflate
      // averagePerDim (the per-dimension leaderboard column) and the
      // conservative-min(det, judge) input even though the case is gated to FAIL
      // elsewhere, so two models with different critical-miss counts would show
      // indistinguishable dimension scores.
      if (critFails > 0) score = Math.min(score, Math.max(20, 60 - Math.min(critFails - 1, 2) * 20));
      else if (majorFails >= 3) score = Math.min(score, 70);

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

  // Single source of truth for weights: a policy may re-weight the dimensions
  // (e.g. the "strict" clinical profile up-weights CRIT). When no policy is
  // supplied, fall back to the canonical default WEIGHTS. The default policy's
  // weights are defined as exactly these canonical weights, so the no-policy and
  // default-policy paths produce identical numbers.
  const weights = policy?.weights ?? WEIGHTS;

  const combined = Object.fromEntries(DIMS.map((dim) => [dim, null])) as Record<Dim, number | null>;
  const scoredDims = DIMS.filter((dim) => detDims[dim].score !== null);

  // Decide the judge score scale once, over the whole result, so a single
  // catastrophic 0-100 dimension is never misread as a 0-5 Likert value.
  const judgeLikert = judgeScoresAreLikert(DIMS.map((dim) => adv?.scores?.[dim]));

  // The clinical dimensions (CRIT, QUAL) carry the safety-critical signal: a
  // missed/fabricated finding lives here. Even in judge-primary mode these dims
  // must never exceed the deterministic floor — a judge CRIT=100 cannot overwrite
  // a deterministic CRIT=40/FAIL, which would inflate the per-dimension clinical
  // column reported on the leaderboard. Non-clinical dims (TERM/GUIDE/RAG) keep
  // the judge-primary behavior for backward compatibility.
  const clinicalDimSet: ReadonlySet<Dim> = new Set<Dim>(["CRIT", "QUAL"]);

  let totalWeight = 0;
  let overall = 0;

  for (const dim of scoredDims) {
    const det = detDims[dim].score;
    const judge = judgeScoreTo100(adv?.scores?.[dim], judgeLikert);
    if (det === null) combined[dim] = null;
    else if (judge === null) combined[dim] = det;
    else if (scoreMode === "judge-primary" && !clinicalDimSet.has(dim)) combined[dim] = judge;
    else combined[dim] = Math.min(det, judge);
    totalWeight += weights[dim];
  }

  for (const dim of scoredDims) {
    const score = combined[dim];
    if (score === null) continue;
    overall += score * (weights[dim] / totalWeight);
  }

  overall = round1(overall);

  const hasDetCritical = checks.some((check) => !check.passed && check.severity === "critical");
  const hasJudgeCritical = (adv?.critical_failures.length ?? 0) > 0;
  const phaseStatus = adv ? "complete" : "degraded";
  const gateReasons: string[] = [];

  const cap = severityCap(checks, adv?.critical_failures.length ?? 0);
  if (cap && overall > cap.cap) {
    overall = cap.cap;
    gateReasons.push(cap.reason);
  }

  if (scoredDims.some((dim) => detDims[dim].verdict === "FAIL") && overall >= passThreshold) {
    overall = round1(passThreshold - 0.1);
    gateReasons.push("severity cap: deterministic dimension failure");
  }

  // Anti-compensation (substance is not rescued by form): TERM (20%) and GUIDE
  // (15%) make up 35% of the weighted score, enough to average a clinically
  // mediocre report up into the PASS band. A case cannot reach PASS while a
  // clinical dimension (CRIT or QUAL) is itself below PASS. This is the core
  // anti-HealthBench invariant: form and coverage never lift weak substance.
  const clinicalDims: Dim[] = ["CRIT", "QUAL"];
  const scoredClinical = clinicalDims.filter((dim) => combined[dim] !== null);
  const weakClinical = clinicalDims.filter(
    (dim) => combined[dim] !== null && (combined[dim] as number) < passThreshold,
  );
  // scoring-core-4: an UNSCORED clinical dimension is NOT evidence of clinical
  // adequacy — it is the ABSENCE of clinical evidence. The earlier guard
  // (combined[dim] !== null) silently treated a null CRIT/QUAL as "not weak", so
  // a report could reach PASS at 100 purely on form/coverage (TERM/GUIDE/RAG)
  // with NO scored clinical signal at all. Form and coverage must never reach
  // PASS on their own: require at least one SCORED clinical dimension. If BOTH
  // CRIT and QUAL are null/UNSCORED, cap below passThreshold and gate.
  if (scoredClinical.length === 0 && overall >= passThreshold) {
    overall = round1(passThreshold - 0.1);
    gateReasons.push("no scored clinical dimension: form/coverage alone cannot reach PASS");
  }
  if (weakClinical.length > 0 && overall >= passThreshold) {
    overall = round1(passThreshold - 0.1);
    gateReasons.push(`anti-compensation: ${weakClinical.join("/")} below PASS`);
  }

  if (hasDetCritical) gateReasons.push("deterministic critical failure");
  if (hasJudgeCritical) gateReasons.push("adversarial critical failure");
  // Judge absence is a phase status ("degraded"), not a gate failure — it must
  // not pollute gateReasons, which list reasons a case failed its gates.

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
