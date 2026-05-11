import { basename } from "node:path";
import { readJsonFile, writeJsonFile, writeTextFile } from "./io.js";
import { round1 } from "./normalize.js";
import { DIMS, WEIGHTS } from "./scoring.js";
import { buildComparableKey } from "./manifests.js";
import type { CaseDifficulty, CompareRow, DifficultyBreakdown, Dim, EntityType, Leaderboard, LeaderboardEntry, LeaderboardGroup, PublicSubmissionValidation, SubmissionValidation, SuiteRunResult, SuiteSummary, SystemType } from "./types.js";

const DIFFICULTY_ORDER: CaseDifficulty[] = ["easy", "medium", "hard"];

function computePerDifficultyBreakdown(run: SuiteRunResult): DifficultyBreakdown[] | undefined {
  const byDifficulty = new Map<CaseDifficulty, { overalls: number[]; verdicts: Array<"PASS" | "PARTIAL" | "FAIL"> }>();

  for (const result of run.results) {
    const diff = result.case.difficulty;
    if (!diff) continue;
    if (!byDifficulty.has(diff)) byDifficulty.set(diff, { overalls: [], verdicts: [] });
    const bucket = byDifficulty.get(diff)!;
    bucket.overalls.push(result.combinedOverall);
    bucket.verdicts.push(result.verdict);
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

function recomputeSummary(run: SuiteRunResult): SuiteSummary {
  const results = run.results;
  const verdictCounts = { PASS: 0, PARTIAL: 0, FAIL: 0 } as Record<"PASS" | "PARTIAL" | "FAIL", number>;
  const averagePerDim: Partial<Record<Dim, number>> = {};
  let averageOverall = 0;
  let passRate = 0;
  let strictPassRate = 0;
  let averageLatencyMs = 0;
  let totalCostUsd = 0;

  for (const result of results) {
    verdictCounts[result.verdict] += 1;
    averageOverall += result.combinedOverall;
    if (result.verdict !== "FAIL") passRate += 1;
    if (result.verdict === "PASS") strictPassRate += 1;
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
    const expectedOverall = recomputeCombinedOverall(result.combined);
    if (!closeEnough(result.combinedOverall, expectedOverall)) {
      errors.push(`case ${result.case?.id ?? index} combinedOverall mismatch: expected ${expectedOverall}, got ${result.combinedOverall}`);
    }
    if (result.costUsd < 0) errors.push(`case ${result.case?.id ?? index} has negative cost`);
    if (result.latencyMs < 0) errors.push(`case ${result.case?.id ?? index} has negative latency`);
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
    lines.push("| Rank | Eligible | Validation | Entity | Type | System | Run | Clinical Score | Strict PASS | Non-fail | Cost | Avg Latency | Source |",
      "| ---: | :---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const entry of group.entries) {
      const validation = entry.eligible ? "ok" : cleanMarkdownCell(entry.validation.errors[0] ?? "invalid submission");
      lines.push(`| ${entry.rank ?? "—"} | ${entry.eligible ? "yes" : "no"} | ${validation} | ${entry.entityName} | ${entry.systemType} | ${entry.modelLabel} | ${entry.runName} | ${entry.averageOverall.toFixed(1)}% | ${entry.accuracyRate.toFixed(1)}% | ${entry.passRate.toFixed(1)}% | $${entry.totalCostUsd.toFixed(4)} | ${entry.averageLatencyMs.toFixed(1)}ms | ${entry.sourceFile} |`);
    }
    lines.push("");

    // Per-difficulty breakdown if any entries have difficulty data
    const entriesWithDifficulty = group.entries.filter((e) => e.perDifficulty && e.perDifficulty.length > 0);
    if (entriesWithDifficulty.length > 0) {
      lines.push(`### Per-Difficulty Breakdown`);
      lines.push("");
      lines.push("| Run | Difficulty | Cases | Clinical Score | Strict PASS | Non-fail |",
        "| --- | --- | ---: | ---: | ---: | ---: |");
      for (const entry of entriesWithDifficulty) {
        for (const bd of entry.perDifficulty!) {
          lines.push(`| ${entry.runName} | ${bd.difficulty} | ${bd.caseCount} | ${bd.averageOverall.toFixed(1)}% | ${bd.accuracyRate.toFixed(1)}% | ${bd.passRate.toFixed(1)}% |`);
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
