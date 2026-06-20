/**
 * Consolidated benchmark report.
 *
 * Pulls together every signal a reviewer needs to trust a leaderboard:
 *
 *   - bootstrap CI on per-case overall (n, mean, 95% CI)
 *   - per-dim summary
 *   - calibration verdict (when ≥ 1 run is supplied)
 *   - contamination scan
 *   - paired discrimination vs a baseline run (when --baseline supplied)
 *   - perturbation catch rate (when --perturb-report supplied)
 *   - provenance hash chain references
 *
 * Single source-of-truth artifact suitable for attaching to a paper, a PR, or
 * an arXiv submission.
 */

import { readJsonFile } from "./io.js";
import { readSuiteRun } from "./leaderboard.js";
import { bootstrapCI } from "./stats.js";
import { discriminate } from "./discriminate.js";
import { calibrateJudges, scanContamination } from "./calibrate.js";
import type { SuiteRunResult } from "./types.js";

export type ConsolidatedReport = {
  generatedAt: string;
  benchmarkVersion: string;
  primary: {
    runName: string;
    suiteId: string;
    locale: string;
    judge: string;
    n: number;
    mean: number;
    ci95: [number, number];
    perDim: Record<string, number>;
    allPassRate: number;
    criterionPassRate: number;
    passRate: number;
    strictPassRate: number;
    cost: number;
    avgLatencyMs: number;
  };
  contamination: {
    verdict: "clean" | "suspicious" | "contaminated";
    canaryHits: number;
    judgeFlagged: number;
    canaryToken: string | undefined;
  };
  calibration?: {
    verdict: "calibrated" | "weak" | "uncalibrated";
    notes: string[];
  };
  discrimination?: {
    baselineRun: string;
    verdict: "discriminates" | "weak" | "fails";
    meanDiff: number;
    ci95: [number, number];
    pValue: number;
    notes: string[];
  };
  perturbation?: {
    overallCatchRate: number;
    verdict: "robust" | "leaky" | "broken";
    perKind: Array<{ kind: string; n: number; caught: number; rate: number }>;
  };
  provenance?: {
    suiteHash: string;
    runHash?: string;
    note: string;
  };
};

export async function buildConsolidatedReport(args: {
  primaryPath: string;
  baselinePath?: string;
  calibrationInputs?: string[];
  perturbReportPath?: string;
  provenancePath?: string;
}): Promise<ConsolidatedReport> {
  // FIX 3 (gap-1): the consolidated report publishes the same public numbers as
  // the leaderboard, so its inputs MUST pass the same verdict-integrity gate.
  // Loading via readSuiteRun (not bare readJsonFile) means a tampered run whose
  // critical gate would veto it can never be published in a consolidated report.
  const primary: SuiteRunResult = await readSuiteRun(args.primaryPath);
  const overalls = primary.results.map((r) => r.combinedOverall);
  const ci = bootstrapCI(overalls, 10000, 0.05);

  const contamination = scanContamination(primary);

  let calibration: ConsolidatedReport["calibration"];
  if (args.calibrationInputs && args.calibrationInputs.length > 0) {
    const runs = await Promise.all(args.calibrationInputs.map((p) => readSuiteRun(p)));
    const cal = calibrateJudges(runs);
    calibration = { verdict: cal.verdict, notes: cal.notes };
  }

  let discrimination: ConsolidatedReport["discrimination"];
  if (args.baselinePath) {
    const baseline: SuiteRunResult = await readSuiteRun(args.baselinePath);
    const d = discriminate(primary, baseline);
    discrimination = {
      baselineRun: baseline.manifest.runName,
      verdict: d.verdict,
      meanDiff: d.overall.meanDiff,
      ci95: d.overall.ci,
      pValue: d.overall.pValue,
      notes: d.notes,
    };
  }

  let perturbation: ConsolidatedReport["perturbation"];
  if (args.perturbReportPath) {
    const p = await readJsonFile<{
      overallCatchRate: number;
      verdict: "robust" | "leaky" | "broken";
      perKind: Array<{ kind: string; n: number; caught: number; rate: number }>;
    }>(args.perturbReportPath);
    perturbation = {
      overallCatchRate: p.overallCatchRate,
      verdict: p.verdict,
      perKind: p.perKind,
    };
  }

  let provenance: ConsolidatedReport["provenance"];
  if (args.provenancePath) {
    const prov = await readJsonFile<{ suites: Array<{ suiteId: string; suiteHash: string }>; scoringHash: string }>(args.provenancePath);
    const ourSuite = prov.suites.find((s) => s.suiteId === primary.manifest.suiteId);
    provenance = {
      suiteHash: ourSuite?.suiteHash ?? primary.manifest.suiteHash,
      note: `scoringHash=${prov.scoringHash}`,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    benchmarkVersion: primary.manifest.benchmarkVersion,
    primary: {
      runName: primary.manifest.runName,
      suiteId: primary.manifest.suiteId,
      locale: primary.manifest.locale,
      judge: `${primary.manifest.judgeProvider ?? "none"}:${primary.manifest.judgeModel ?? "none"}`,
      n: overalls.length,
      mean: ci.mean,
      ci95: [ci.lower, ci.upper],
      perDim: Object.fromEntries(Object.entries(primary.summary.averagePerDim ?? {}).map(([k, v]) => [k, v as number])),
      allPassRate: primary.summary.allPassRate ?? 0,
      criterionPassRate: primary.summary.criterionPassRate ?? 0,
      passRate: primary.summary.passRate,
      strictPassRate: primary.summary.strictPassRate,
      cost: primary.summary.totalCostUsd,
      avgLatencyMs: primary.summary.averageLatencyMs,
    },
    contamination: {
      verdict: contamination.verdict,
      canaryHits: contamination.canaryHits,
      judgeFlagged: contamination.judgeFlaggedContamination,
      canaryToken: contamination.canaryToken,
    },
    calibration,
    discrimination,
    perturbation,
    provenance,
  };
}

export function reportToMarkdown(r: ConsolidatedReport): string {
  const L: string[] = [];
  L.push(`# laibench Consolidated Report — ${r.primary.runName}`);
  L.push(``);
  L.push(`**Generated:** ${r.generatedAt}  `);
  L.push(`**Benchmark version:** ${r.benchmarkVersion}  `);
  L.push(`**Suite:** ${r.primary.suiteId} (${r.primary.locale})  `);
  L.push(`**Judge:** ${r.primary.judge}  `);
  L.push(``);
  L.push(`## Primary metrics`);
  L.push(``);
  L.push(`| Metric | Value |`);
  L.push(`| --- | --- |`);
  L.push(`| n cases | ${r.primary.n} |`);
  L.push(`| All-pass completion | ${r.primary.allPassRate.toFixed(2)}% |`);
  L.push(`| Criterion pass rate | ${r.primary.criterionPassRate.toFixed(2)}% |`);
  L.push(`| Mean overall | ${r.primary.mean.toFixed(2)}% |`);
  L.push(`| 95% CI | [${r.primary.ci95[0].toFixed(2)}, ${r.primary.ci95[1].toFixed(2)}] |`);
  L.push(`| Pass rate | ${r.primary.passRate.toFixed(2)}% |`);
  L.push(`| Strict pass rate | ${r.primary.strictPassRate.toFixed(2)}% |`);
  L.push(`| Cost (USD) | $${r.primary.cost.toFixed(4)} |`);
  L.push(`| Avg latency | ${r.primary.avgLatencyMs.toFixed(1)}ms |`);
  L.push(``);
  L.push(`### Per-dimension averages`);
  L.push(``);
  L.push(`| Dim | Mean |`);
  L.push(`| --- | ---: |`);
  for (const [k, v] of Object.entries(r.primary.perDim)) L.push(`| ${k} | ${v.toFixed(2)}% |`);
  L.push(``);
  L.push(`## Contamination scan`);
  L.push(`- **Verdict:** ${r.contamination.verdict.toUpperCase()}`);
  L.push(`- Canary token: ${r.contamination.canaryToken ?? "(none)"}`);
  L.push(`- Canary hits: ${r.contamination.canaryHits}`);
  L.push(`- Judge-flagged: ${r.contamination.judgeFlagged}`);
  L.push(``);
  if (r.calibration) {
    L.push(`## Judge calibration`);
    L.push(`- **Verdict:** ${r.calibration.verdict.toUpperCase()}`);
    for (const note of r.calibration.notes) L.push(`- ${note}`);
    L.push(``);
  }
  if (r.discrimination) {
    L.push(`## Discrimination vs baseline (${r.discrimination.baselineRun})`);
    L.push(`- **Verdict:** ${r.discrimination.verdict.toUpperCase()}`);
    L.push(`- ΔMean: ${r.discrimination.meanDiff.toFixed(2)}pp`);
    L.push(`- 95% CI: [${r.discrimination.ci95[0].toFixed(2)}, ${r.discrimination.ci95[1].toFixed(2)}]`);
    L.push(`- p-value: ${r.discrimination.pValue.toFixed(4)}`);
    for (const note of r.discrimination.notes) L.push(`- ${note}`);
    L.push(``);
  }
  if (r.perturbation) {
    L.push(`## Adversarial perturbation robustness`);
    L.push(`- **Verdict:** ${r.perturbation.verdict.toUpperCase()}`);
    L.push(`- Overall catch rate: ${r.perturbation.overallCatchRate}%`);
    L.push(``);
    L.push(`| Kind | n | caught | rate |`);
    L.push(`| --- | ---: | ---: | ---: |`);
    for (const k of r.perturbation.perKind) L.push(`| ${k.kind} | ${k.n} | ${k.caught} | ${k.rate}% |`);
    L.push(``);
  }
  if (r.provenance) {
    L.push(`## Provenance`);
    L.push(`- Suite hash: \`${r.provenance.suiteHash}\``);
    L.push(`- ${r.provenance.note}`);
    L.push(``);
  }
  L.push(`---`);
  L.push(`Generated by laibench v${r.benchmarkVersion}.`);
  return L.join("\n");
}
