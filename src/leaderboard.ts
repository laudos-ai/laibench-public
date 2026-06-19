import { basename } from "node:path";
import { readJsonFile, writeJsonFile, writeTextFile } from "./io.js";
import { round1 } from "./normalize.js";
import { combineScores, DIMS, WEIGHTS } from "./scoring.js";
import { buildComparableKey } from "./manifests.js";
import type { CaseDifficulty, CompareRow, DifficultyBreakdown, Dim, DimSummary, EntityType, Leaderboard, LeaderboardEntry, LeaderboardGroup, PublicSubmissionValidation, SubmissionValidation, SuiteRunResult, SuiteSummary, SystemType, Verdict } from "./types.js";

type ScoredVerdict = Exclude<Verdict, "UNSCORED">;

const DIFFICULTY_ORDER: CaseDifficulty[] = ["easy", "medium", "hard"];

function criterionStats(checks: SuiteRunResult["results"][number]["checks"]): {
  allPass: boolean;
  criteriaPassed: number;
  criteriaTotal: number;
} {
  const criteriaTotal = checks.length;
  const criteriaPassed = checks.filter((check) => check.passed).length;
  return {
    allPass: criteriaTotal > 0 && criteriaPassed === criteriaTotal,
    criteriaPassed,
    criteriaTotal,
  };
}

function computePerDifficultyBreakdown(run: SuiteRunResult): DifficultyBreakdown[] | undefined {
  const byDifficulty = new Map<CaseDifficulty, {
    overalls: number[];
    verdicts: Array<"PASS" | "PARTIAL" | "FAIL">;
    allPassCount: number;
    criteriaPassed: number;
    criteriaTotal: number;
  }>();

  for (const result of run.results) {
    const diff = result.case.difficulty;
    if (!diff) continue;
    if (!byDifficulty.has(diff)) byDifficulty.set(diff, { overalls: [], verdicts: [], allPassCount: 0, criteriaPassed: 0, criteriaTotal: 0 });
    const bucket = byDifficulty.get(diff)!;
    const criteria = criterionStats(result.checks);
    bucket.overalls.push(result.combinedOverall);
    bucket.verdicts.push(result.verdict);
    if (criteria.allPass) bucket.allPassCount += 1;
    bucket.criteriaPassed += criteria.criteriaPassed;
    bucket.criteriaTotal += criteria.criteriaTotal;
  }

  if (byDifficulty.size === 0) return undefined;

  const breakdowns: DifficultyBreakdown[] = [];
  for (const difficulty of DIFFICULTY_ORDER) {
    const bucket = byDifficulty.get(difficulty);
    if (!bucket) continue;
    const n = bucket.overalls.length;
    const avgOverall = round1(bucket.overalls.reduce((a, b) => a + b, 0) / n);
    const passCount = bucket.verdicts.filter((v) => v !== "FAIL").length;
    const strictCount = bucket.verdicts.filter((v) => v === "PASS").length;
    breakdowns.push({
      difficulty,
      caseCount: n,
      allPassRate: round1((bucket.allPassCount / n) * 100),
      criterionPassRate: bucket.criteriaTotal > 0 ? round1((bucket.criteriaPassed / bucket.criteriaTotal) * 100) : 0,
      averageOverall: avgOverall,
      accuracyRate: round1((strictCount / n) * 100),
      passRate: round1((passCount / n) * 100),
      strictPassRate: round1((strictCount / n) * 100),
    });
  }

  return breakdowns.length > 0 ? breakdowns : undefined;
}

type IntegrityOptions = {
  requireResults?: boolean;
};

function closeEnough(actual: number, expected: number, tolerance = 0.11): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function recomputeCombinedOverall(combined: Partial<Record<Dim, number | null>>): number {
  const scoredDims = DIMS.filter((dim) => typeof combined[dim] === "number");
  const totalWeight = scoredDims.reduce((sum, dim) => sum + WEIGHTS[dim], 0);
  if (totalWeight <= 0) return 0;
  let overall = 0;
  for (const dim of scoredDims) overall += (combined[dim] as number) * (WEIGHTS[dim] / totalWeight);
  return round1(overall);
}

function hasDimSummaries(value: unknown): value is Record<Dim, DimSummary> {
  if (!value || typeof value !== "object") return false;
  const dims = value as Partial<Record<Dim, Partial<DimSummary>>>;
  return DIMS.every((dim) => {
    const item = dims[dim];
    return !!item && typeof item === "object" && "verdict" in item && "appliedWeight" in item;
  });
}

/**
 * Matches scoring.ts: a deterministic critical-finding miss/fabrication is any
 * failed check whose severity is 'critical'. This is the policy-independent
 * hard veto — every registered policy sets criticalFailForces=true, so a
 * failed critical check (or a judge critical_failure) MUST drive the verdict to
 * FAIL no matter which policy or scoreMode produced the run.
 */
function hasDetCritical(checks: SuiteRunResult["results"][number]["checks"]): boolean {
  return (checks ?? []).some((check) => !check.passed && check.severity === "critical");
}

function hasJudgeCritical(result: SuiteRunResult["results"][number]): boolean {
  return (result.judge?.critical_failures?.length ?? 0) > 0;
}

type RecomputedCase = {
  overall: number;
  /** Re-derived verdict from the gated combiner, or undefined when detDims is absent. */
  verdict: ScoredVerdict | undefined;
  /** Set when the artifact cannot be re-verified through the real (gated) combiner. */
  integrityError?: string;
};

/**
 * Recompute a case's overall AND verdict through the REAL (gated) combiner.
 *
 * For any artifact that feeds PUBLIC numbers we REQUIRE full deterministic
 * dimension summaries: without them we cannot run the real critical-finding
 * gate, and validating combinedOverall against an UNGATED weighted mean would
 * let a critical-miss case (capped to 59.9 by the gate) masquerade as a passing
 * mean. So an absent/partial detDims is reported as an integrity error rather
 * than silently trusted.
 *
 * The run's policy id is not persisted in the manifest, so we re-derive with the
 * default policy (undefined) and the run's stored scoreMode. The default and
 * "research"/"leaderboard" policies share the canonical weights/thresholds, so
 * those runs re-derive their overall/verdict exactly. A non-default policy
 * ("strict") may legitimately disagree on the PASS/PARTIAL boundary; that is why
 * the verdict equality check below is bounded by an explicit critical-veto
 * cross-check (which holds under every policy) rather than relying solely on the
 * band comparison.
 */
function recomputeCaseResult(
  result: SuiteRunResult["results"][number],
  scoreMode: SuiteRunResult["manifest"]["scoreMode"],
): RecomputedCase {
  if (hasDimSummaries(result.detDims)) {
    const combined = combineScores(result.detDims, result.judge, result.checks ?? [], undefined, scoreMode);
    return { overall: combined.overall, verdict: combined.verdict };
  }
  return {
    overall: recomputeCombinedOverall(result.combined),
    verdict: undefined,
    integrityError: "missing deterministic dimension summaries (cannot re-verify through the gated combiner)",
  };
}

/**
 * The verdict the summary tallies (passRate/strictPassRate/verdictCounts) must
 * be driven from, in order of trust:
 *   1. the RE-DERIVED gated verdict (when detDims is present), never the stored one;
 *   2. failing that, an absolute critical veto: any failed critical check or judge
 *      critical_failure forces FAIL regardless of the stored verdict.
 * Only when neither signal is available do we fall back to the stored verdict —
 * and {@link recomputeCaseResult} already flags that detDims-absent case as an
 * integrity error, so a public artifact never reaches the fallback unflagged.
 */
function effectiveVerdict(
  result: SuiteRunResult["results"][number],
  reDerived: ScoredVerdict | undefined,
): ScoredVerdict {
  if (reDerived !== undefined) return reDerived;
  if (hasDetCritical(result.checks) || hasJudgeCritical(result)) return "FAIL";
  return result.verdict;
}

function recomputeSummary(run: SuiteRunResult): SuiteSummary {
  const results = run.results;
  const verdictCounts = { PASS: 0, PARTIAL: 0, FAIL: 0 } as Record<"PASS" | "PARTIAL" | "FAIL", number>;
  const averagePerDim: Partial<Record<Dim, number>> = {};
  let averageOverall = 0;
  let passRate = 0;
  let strictPassRate = 0;
  let allPassCount = 0;
  let criteriaPassed = 0;
  let criteriaTotal = 0;
  let averageLatencyMs = 0;
  let totalCostUsd = 0;

  for (const result of results) {
    const criteria = criterionStats(result.checks);
    // Drive verdict tallies from the RE-DERIVED gated verdict, never the stored
    // one: a tampered run that flips FAIL->PASS while leaving combinedOverall
    // honest must not be able to inflate passRate/strictPassRate/verdictCounts.
    const reDerived = recomputeCaseResult(result, run.manifest.scoreMode).verdict;
    const verdict = effectiveVerdict(result, reDerived);
    verdictCounts[verdict] += 1;
    averageOverall += result.combinedOverall;
    if (verdict !== "FAIL") passRate += 1;
    if (verdict === "PASS") strictPassRate += 1;
    if (criteria.allPass) allPassCount += 1;
    criteriaPassed += criteria.criteriaPassed;
    criteriaTotal += criteria.criteriaTotal;
    averageLatencyMs += result.latencyMs;
    totalCostUsd += result.costUsd;
  }

  const denominator = results.length || 1;
  for (const dim of DIMS) {
    const scored = results.map((result) => result.combined[dim]).filter((value): value is number => typeof value === "number");
    if (scored.length > 0) averagePerDim[dim] = round1(scored.reduce((sum, value) => sum + value, 0) / scored.length);
  }

  const strict = round1((strictPassRate / denominator) * 100);
  return {
    accuracyRate: strict,
    allPassRate: round1((allPassCount / denominator) * 100),
    allPassCount,
    criterionPassRate: criteriaTotal > 0 ? round1((criteriaPassed / criteriaTotal) * 100) : 0,
    criteriaPassed,
    criteriaTotal,
    averageOverall: round1(averageOverall / denominator),
    passRate: round1((passRate / denominator) * 100),
    strictPassRate: strict,
    averageLatencyMs: round1(averageLatencyMs / denominator),
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    verdictCounts,
    averagePerDim,
  };
}

export function assertSuiteRunIntegrity(run: SuiteRunResult, label = "suite run", options: IntegrityOptions = {}): void {
  const errors: string[] = [];
  if (!run || typeof run !== "object") throw new Error(`${label}: invalid run artifact`);
  if (!run.manifest || typeof run.manifest !== "object") errors.push("missing manifest");
  if (!run.summary || typeof run.summary !== "object") errors.push("missing summary");
  if (!Array.isArray(run.results)) errors.push("missing results array");
  if (errors.length > 0) throw new Error(`${label}: integrity check failed: ${errors.join("; ")}`);

  if ((options.requireResults ?? true) && run.results.length === 0) errors.push("run has no case results");

  const expectedComparableKey = buildComparableKey({
    benchmarkVersion: run.manifest.benchmarkVersion,
    suiteId: run.manifest.suiteId,
    locale: run.manifest.locale,
    track: run.manifest.track,
    comparisonClass: run.manifest.comparisonClass,
    scaffoldId: run.manifest.scaffoldId,
    judgeProvider: run.manifest.judgeProvider,
    judgeModel: run.manifest.judgeModel,
    scoreMode: run.manifest.scoreMode,
  });
  if (run.manifest.comparableKey !== expectedComparableKey) {
    errors.push(`comparableKey mismatch: expected ${expectedComparableKey}, got ${run.manifest.comparableKey}`);
  }

  if (run.manifest.validation.valid && run.results.length !== run.manifest.validation.expectedIds.length) {
    errors.push(`valid run result count mismatch: expected ${run.manifest.validation.expectedIds.length}, got ${run.results.length}`);
  }

  run.results.forEach((result, index) => {
    const caseId = result.case?.id ?? index;
    const recomputed = recomputeCaseResult(result, run.manifest.scoreMode);
    const expectedOverall = recomputed.overall;
    const expectedCriteria = criterionStats(result.checks);
    // FIX 2: a public artifact that cannot be re-verified through the gated
    // combiner (no/partial deterministic dimension summaries) is an integrity
    // FAILURE — we refuse to validate combinedOverall against an ungated mean.
    if (recomputed.integrityError) {
      errors.push(`case ${caseId}: ${recomputed.integrityError}`);
    }
    if (!closeEnough(result.combinedOverall, expectedOverall)) {
      errors.push(`case ${caseId} combinedOverall mismatch: expected ${expectedOverall}, got ${result.combinedOverall}`);
    }
    // FIX 1: re-derive the verdict through the gated combiner and reject a run
    // whose stored verdict disagrees. A tamper that flips FAIL->PASS while
    // leaving combinedOverall honest (e.g. 59.9) is caught here.
    if (recomputed.verdict !== undefined && result.verdict !== recomputed.verdict) {
      errors.push(`case ${caseId} verdict mismatch: expected ${recomputed.verdict}, got ${result.verdict}`);
    }
    // FIX 1 (absolute, policy-independent veto): a failed critical check or a
    // judge critical_failure MUST drive the verdict to FAIL. This holds under
    // every policy/scoreMode, so it is enforced even when detDims is absent.
    if ((hasDetCritical(result.checks) || hasJudgeCritical(result)) && result.verdict !== "FAIL") {
      errors.push(`case ${caseId} verdict must be FAIL: a critical finding failure cannot be rescued (got ${result.verdict})`);
    }
    if (result.allPass !== undefined && result.allPass !== expectedCriteria.allPass) {
      errors.push(`case ${caseId} allPass mismatch: expected ${expectedCriteria.allPass}, got ${result.allPass}`);
    }
    if (result.criteriaPassed !== undefined && result.criteriaPassed !== expectedCriteria.criteriaPassed) {
      errors.push(`case ${caseId} criteriaPassed mismatch: expected ${expectedCriteria.criteriaPassed}, got ${result.criteriaPassed}`);
    }
    if (result.criteriaTotal !== undefined && result.criteriaTotal !== expectedCriteria.criteriaTotal) {
      errors.push(`case ${caseId} criteriaTotal mismatch: expected ${expectedCriteria.criteriaTotal}, got ${result.criteriaTotal}`);
    }
    if (result.costUsd < 0) errors.push(`case ${caseId} has negative cost`);
    if (result.latencyMs < 0) errors.push(`case ${caseId} has negative latency`);
  });

  const expectedSummary = recomputeSummary(run);
  const summaryChecks: Array<[string, number, number]> = [
    ["summary.averageOverall", run.summary.averageOverall, expectedSummary.averageOverall],
    ["summary.accuracyRate", run.summary.accuracyRate, expectedSummary.accuracyRate],
    ["summary.strictPassRate", run.summary.strictPassRate, expectedSummary.strictPassRate],
    ["summary.passRate", run.summary.passRate, expectedSummary.passRate],
    ["summary.averageLatencyMs", run.summary.averageLatencyMs, expectedSummary.averageLatencyMs],
    ["summary.totalCostUsd", run.summary.totalCostUsd, expectedSummary.totalCostUsd],
  ];
  for (const [field, actual, expected] of summaryChecks) {
    if (!closeEnough(actual, expected)) errors.push(`${field} mismatch: expected ${expected}, got ${actual}`);
  }

  const optionalSummaryChecks: Array<[string, number | undefined, number | undefined]> = [
    ["summary.allPassRate", run.summary.allPassRate, expectedSummary.allPassRate],
    ["summary.allPassCount", run.summary.allPassCount, expectedSummary.allPassCount],
    ["summary.criterionPassRate", run.summary.criterionPassRate, expectedSummary.criterionPassRate],
    ["summary.criteriaPassed", run.summary.criteriaPassed, expectedSummary.criteriaPassed],
    ["summary.criteriaTotal", run.summary.criteriaTotal, expectedSummary.criteriaTotal],
  ];
  for (const [field, actual, expected] of optionalSummaryChecks) {
    if (actual !== undefined && expected !== undefined && !closeEnough(actual, expected)) {
      errors.push(`${field} mismatch: expected ${expected}, got ${actual}`);
    }
  }

  for (const verdict of ["PASS", "PARTIAL", "FAIL"] as const) {
    if (run.summary.verdictCounts[verdict] !== expectedSummary.verdictCounts[verdict]) {
      errors.push(`summary.verdictCounts.${verdict} mismatch: expected ${expectedSummary.verdictCounts[verdict]}, got ${run.summary.verdictCounts[verdict]}`);
    }
  }

  for (const dim of DIMS) {
    const actual = run.summary.averagePerDim[dim];
    const expected = expectedSummary.averagePerDim[dim];
    if (expected === undefined && actual !== undefined) errors.push(`summary.averagePerDim.${dim} should be absent`);
    if (expected !== undefined && (actual === undefined || !closeEnough(actual, expected))) {
      errors.push(`summary.averagePerDim.${dim} mismatch: expected ${expected}, got ${actual}`);
    }
  }

  if (errors.length > 0) throw new Error(`${label}: integrity check failed: ${errors.join("; ")}`);
}

export async function readSuiteRun(path: string, options: IntegrityOptions = {}): Promise<SuiteRunResult> {
  const run = await readJsonFile<SuiteRunResult>(path);
  assertSuiteRunIntegrity(run, path, options);
  return run;
}

function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if ((b.allPassRate ?? 0) !== (a.allPassRate ?? 0)) return (b.allPassRate ?? 0) - (a.allPassRate ?? 0);
  if ((b.criterionPassRate ?? 0) !== (a.criterionPassRate ?? 0)) return (b.criterionPassRate ?? 0) - (a.criterionPassRate ?? 0);
  if (b.averageOverall !== a.averageOverall) return b.averageOverall - a.averageOverall;
  if (b.accuracyRate !== a.accuracyRate) return b.accuracyRate - a.accuracyRate;
  if (b.passRate !== a.passRate) return b.passRate - a.passRate;
  if (a.totalCostUsd !== b.totalCostUsd) return a.totalCostUsd - b.totalCostUsd;
  return a.averageLatencyMs - b.averageLatencyMs;
}

function publicComparableKey(run: SuiteRunResult): string {
  const judgingMode = run.manifest.judgeModel ? `judged-frozen-${run.manifest.scoreMode ?? "conservative-min"}` : "deterministic";
  const comparisonClass = cleanPublicLabel(run.manifest.comparisonClass ?? run.manifest.systemType ?? run.manifest.track);
  return [
    run.manifest.benchmarkVersion,
    run.manifest.suiteId,
    run.manifest.locale,
    run.manifest.track,
    comparisonClass,
    publicScaffoldId(run.manifest.scaffoldId) ?? "none",
    judgingMode,
  ].join("::");
}

function publicScaffoldId(scaffoldId: string | null): string | null {
  if (!scaffoldId) return null;
  if (/laudos|pipeline|endpoint|route|api/i.test(scaffoldId)) return "product-agent";
  return cleanPublicLabel(scaffoldId);
}

function cleanPublicLabel(label: string): string {
  return label
    .replace(/\s*\(@[a-z0-9_.-]+\/[^)]+\)/gi, "")
    .replace(/@[a-z0-9_.-]+\/[a-z0-9_.-]+/gi, "private configuration")
    .replace(/\b(openrouter|openai-compatible|supabase|vercel)\b/gi, "private")
    .replace(/\/api\/[a-z0-9_./-]+/gi, "product reporting flow")
    .replace(/https?:\/\/\S+/gi, "private target")
    .trim();
}

function publicSystemMeta(run: SuiteRunResult): {
  entityName: string;
  entityType: EntityType;
  systemType: SystemType;
  comparisonClass: string;
  publicSystemLabel: string;
} {
  const rawLabel = run.manifest.modelLabel ?? "unknown";
  const looksLikeProductAgent = /laudos/i.test(rawLabel) || /laudos/i.test(run.manifest.entityName ?? "");
  const systemType = (run.manifest.systemType ?? (run.manifest.track === "model" ? "raw-model" : run.manifest.track === "mini-agent" ? "mini-agent" : looksLikeProductAgent ? "product-agent" : "custom-agent")) as SystemType;
  const entityName = run.manifest.entityName ?? (looksLikeProductAgent ? "Reporting agent" : cleanPublicLabel(rawLabel));
  const entityType = (run.manifest.entityType ?? (systemType === "raw-model" ? "model" : systemType === "product-agent" ? "company" : "agent")) as EntityType;
  const publicSystemLabel = looksLikeProductAgent ? "Reporting agent" : cleanPublicLabel(rawLabel);
  return {
    entityName: cleanPublicLabel(entityName),
    entityType,
    systemType,
    comparisonClass: cleanPublicLabel(run.manifest.comparisonClass ?? systemType),
    publicSystemLabel,
  };
}

function publicValidation(validation: SubmissionValidation): PublicSubmissionValidation {
  return {
    valid: validation.valid,
    expectedCount: validation.expectedIds.length,
    receivedCount: validation.receivedIds.length,
    missingCount: validation.missingIds.length,
    duplicateCount: validation.duplicateIds.length,
    extraCount: validation.extraIds.length,
    emptyOutputCount: validation.emptyOutputs.length,
    errors: validation.errors.map((error) => publicValidationError(error, validation)),
  };
}

function publicValidationError(error: string, validation: SubmissionValidation): string {
  if (/^missing cases:/i.test(error)) return `missing cases: ${validation.missingIds.length}`;
  if (/^duplicate cases:/i.test(error)) return `duplicate cases: ${validation.duplicateIds.length}`;
  if (/^extra cases:/i.test(error)) return `extra cases: ${validation.extraIds.length}`;
  if (/^empty outputs:/i.test(error)) return `empty outputs: ${validation.emptyOutputs.length}`;
  if (/metadata must be an object/i.test(error)) return cleanPublicLabel(error);
  if (/malformed jsonl/i.test(error)) return "malformed prediction file";
  return "invalid submission details withheld";
}

export function buildLeaderboard(inputs: Array<{ path: string; run: SuiteRunResult }>, options: IntegrityOptions = {}): Leaderboard {
  if (options.requireResults ?? true) {
    for (const { path, run } of inputs) assertSuiteRunIntegrity(run, path, options);
  }

  const byGroup = new Map<string, LeaderboardGroup>();

  for (const { path, run } of inputs) {
    const key = run.manifest.comparableKey;
    const displayKey = publicComparableKey(run);
    const publicMeta = publicSystemMeta(run);
    const displayJudgeProvider = run.manifest.judgeProvider ? "hidden" : null;
    const displayJudgeModel = run.manifest.judgeModel ? "hidden" : null;
    const group = byGroup.get(key) ?? {
      comparableKey: displayKey,
      suiteId: run.manifest.suiteId,
      locale: run.manifest.locale,
      track: run.manifest.track,
      scaffoldId: publicScaffoldId(run.manifest.scaffoldId),
      judgeProvider: displayJudgeProvider,
      judgeModel: displayJudgeModel,
      scoreMode: run.manifest.scoreMode ?? "conservative-min",
      entries: [],
    };

    const eligible = run.manifest.validation.valid;

    // Compute per-difficulty breakdown if cases have the difficulty field
    const perDifficulty = computePerDifficultyBreakdown(run);
    const expectedSummary = run.results.length > 0 ? recomputeSummary(run) : run.summary;

    group.entries.push({
      rank: null,
      eligible,
      runName: cleanPublicLabel(run.manifest.runName),
      provider: "hidden",
      modelLabel: publicMeta.publicSystemLabel,
      entityName: publicMeta.entityName,
      entityType: publicMeta.entityType,
      systemType: publicMeta.systemType,
      comparisonClass: publicMeta.comparisonClass,
      locale: run.manifest.locale,
      track: run.manifest.track,
      scaffoldId: publicScaffoldId(run.manifest.scaffoldId),
      judgeProvider: displayJudgeProvider,
      judgeModel: displayJudgeModel,
      allPassRate: run.summary.allPassRate ?? expectedSummary.allPassRate,
      allPassCount: run.summary.allPassCount ?? expectedSummary.allPassCount,
      criterionPassRate: run.summary.criterionPassRate ?? expectedSummary.criterionPassRate,
      criteriaPassed: run.summary.criteriaPassed ?? expectedSummary.criteriaPassed,
      criteriaTotal: run.summary.criteriaTotal ?? expectedSummary.criteriaTotal,
      averageOverall: run.summary.averageOverall,
      accuracyRate: run.summary.accuracyRate ?? run.summary.strictPassRate,
      passRate: run.summary.passRate,
      strictPassRate: run.summary.strictPassRate,
      totalCostUsd: run.summary.totalCostUsd,
      averageLatencyMs: run.summary.averageLatencyMs,
      averagePerDim: run.summary.averagePerDim,
      sourceFile: cleanPublicLabel(basename(path)),
      comparableKey: displayKey,
      suiteId: run.manifest.suiteId,
      validation: publicValidation(run.manifest.validation),
      perDifficulty,
    });
    byGroup.set(key, group);
  }

  const groups = Array.from(byGroup.values()).map((group) => {
    const sorted = [...group.entries].sort(compareEntries);
    let rank = 1;
    for (const entry of sorted) {
      if (entry.eligible) {
        entry.rank = rank;
        rank += 1;
      } else {
        entry.rank = null;
      }
    }
    return { ...group, entries: sorted };
  }).sort((a, b) => a.comparableKey.localeCompare(b.comparableKey));

  return {
    createdAt: new Date().toISOString(),
    benchmarkVersion: inputs[0]?.run.manifest.benchmarkVersion ?? "unknown",
    groups,
  };
}

export function leaderboardToMarkdown(leaderboard: Leaderboard): string {
  const lines: string[] = ["# laibench Leaderboard", ""];
  for (const group of leaderboard.groups) {
    const judgingMode = group.scoreMode === "judge-primary"
      ? "judged/frozen judge-primary"
      : group.judgeModel
        ? "judged/frozen conservative-min"
        : "deterministic";
    lines.push(`## ${group.suiteId} | ${group.locale} | ${group.track} | ${judgingMode}`);
    lines.push("");
    lines.push("| Rank | Eligible | Validation | Entity | Type | System | Run | All-pass | Criterion pass | Clinical score | Strict PASS | Cost | Avg Latency | Source |",
      "| ---: | :---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const entry of group.entries) {
      const validation = entry.eligible ? "ok" : cleanMarkdownCell(entry.validation.errors[0] ?? "invalid submission");
      lines.push(`| ${entry.rank ?? "—"} | ${entry.eligible ? "yes" : "no"} | ${validation} | ${entry.entityName} | ${entry.systemType} | ${entry.modelLabel} | ${entry.runName} | ${(entry.allPassRate ?? 0).toFixed(1)}% | ${(entry.criterionPassRate ?? 0).toFixed(1)}% | ${entry.averageOverall.toFixed(1)}% | ${entry.accuracyRate.toFixed(1)}% | $${entry.totalCostUsd.toFixed(4)} | ${entry.averageLatencyMs.toFixed(1)}ms | ${entry.sourceFile} |`);
    }
    lines.push("");

    // Per-difficulty breakdown if any entries have difficulty data
    const entriesWithDifficulty = group.entries.filter((e) => e.perDifficulty && e.perDifficulty.length > 0);
    if (entriesWithDifficulty.length > 0) {
      lines.push(`### Per-Difficulty Breakdown`);
      lines.push("");
      lines.push("| Run | Difficulty | Cases | All-pass | Criterion pass | Clinical score | Strict PASS | Non-fail |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const entry of entriesWithDifficulty) {
        for (const bd of entry.perDifficulty!) {
          lines.push(`| ${entry.runName} | ${bd.difficulty} | ${bd.caseCount} | ${(bd.allPassRate ?? 0).toFixed(1)}% | ${(bd.criterionPassRate ?? 0).toFixed(1)}% | ${bd.averageOverall.toFixed(1)}% | ${bd.accuracyRate.toFixed(1)}% | ${bd.passRate.toFixed(1)}% |`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function cleanMarkdownCell(value: string): string {
  return value.replaceAll("|", "/").replace(/\s+/g, " ").trim();
}

export function compareRuns(a: SuiteRunResult, b: SuiteRunResult): CompareRow[] {
  if (a.manifest.comparableKey !== b.manifest.comparableKey) {
    throw new Error(`Runs are not comparable.\nA=${a.manifest.comparableKey}\nB=${b.manifest.comparableKey}`);
  }

  const byId = new Map(b.results.map((result) => [result.case.id, result]));
  return a.results
    .map((resultA) => {
      const resultB = byId.get(resultA.case.id);
      if (!resultB) return null;
      return {
        caseId: resultA.case.id,
        caseLabel: resultA.case.label ?? resultA.case.id,
        aOverall: resultA.combinedOverall,
        bOverall: resultB.combinedOverall,
        delta: round1(resultA.combinedOverall - resultB.combinedOverall),
        aVerdict: resultA.verdict,
        bVerdict: resultB.verdict,
      };
    })
    .filter((row): row is CompareRow => row !== null)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

export function compareToText(a: SuiteRunResult, b: SuiteRunResult): string {
  const rows = compareRuns(a, b);
  const lines = [
    `${a.manifest.runName} vs ${b.manifest.runName}`,
    "",
    `Group: ${a.manifest.comparableKey}`,
    `A avg: ${a.summary.averageOverall.toFixed(1)}% | B avg: ${b.summary.averageOverall.toFixed(1)}%`,
    "",
    "caseId\tA\tB\tdelta\tA verdict\tB verdict\tlabel",
  ];

  for (const row of rows) {
    lines.push(`${row.caseId}\t${row.aOverall.toFixed(1)}%\t${row.bOverall.toFixed(1)}%\t${row.delta > 0 ? "+" : ""}${row.delta.toFixed(1)}\t${row.aVerdict}\t${row.bVerdict}\t${row.caseLabel}`);
  }

  return lines.join("\n");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeJsonFile(path, value);
}

export async function writeLeaderboardMarkdown(path: string, leaderboard: Leaderboard): Promise<void> {
  await writeTextFile(path, leaderboardToMarkdown(leaderboard));
}
