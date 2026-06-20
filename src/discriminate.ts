/**
 * Discrimination tests for benchmark validity.
 *
 * A reference benchmark must demonstrate that it ranks known-good systems above
 * known-bad systems. We use four discrimination signals:
 *
 *  1. **Reference vs. Adversarial**: feed gold report verbatim → score should
 *     be near-perfect; feed deliberately bad report → score should fail.
 *  2. **Top-vs-baseline gap**: state-of-the-art model overall must exceed a
 *     small/cheap baseline by at least DELTA on the same suite.
 *  3. **Stratified delta**: gap should hold across difficulty buckets and
 *     modalities (no single-stratum collapse).
 *  4. **Per-dim ranking**: each dimension must rank known-good > known-bad.
 *
 * The harness does NOT decide the absolute thresholds — it surfaces the deltas
 * with bootstrap CIs so reviewers can audit whether the bench is informative.
 */

import { pairedBootstrap } from "./kappa.js";
import type { CaseRunResult, Dim, SuiteRunResult } from "./types.js";

export type DiscriminationReport = {
  comparableKey: string;
  modelA: { runName: string; modelLabel: string };
  modelB: { runName: string; modelLabel: string };
  caseCount: number;
  overall: {
    aMean: number;
    bMean: number;
    meanDiff: number;
    ci: [number, number];
    pValue: number;
    significant: boolean;
  };
  perDim: Record<Dim, { aMean: number; bMean: number; meanDiff: number; ci: [number, number]; pValue: number }>;
  perModality: Array<{ modality: string; n: number; meanDiff: number; ci: [number, number] }>;
  perDifficulty: Array<{ difficulty: string; n: number; meanDiff: number; ci: [number, number] }>;
  // Strata too thin (n < 5) to rank, surfaced anyway with their n and bootstrap
  // CI so a small per-cell sample reads as uncertain instead of being silently
  // dropped. The CI widens as n shrinks.
  thinStrata: Array<{ dimension: "modality" | "difficulty"; key: string; n: number; meanDiff: number; ci: [number, number] }>;
  verdict: "discriminates" | "weak" | "fails";
  notes: string[];
};

const MIN_STRATUM_N = 5; // below this a stratum is reported as thin, not ranked

const DIMS: Dim[] = ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"];
const REFERENCE_PROBE_PASS_THRESHOLD = 84;

/**
 * Compare two runs over the same suite to test whether the benchmark separates
 * them with statistical confidence.
 */
export function discriminate(
  runA: SuiteRunResult,
  runB: SuiteRunResult,
  options: { alpha?: number; minDelta?: number } = {},
): DiscriminationReport {
  if (runA.manifest.comparableKey !== runB.manifest.comparableKey) {
    throw new Error(
      `discriminate: runs not comparable.\nA=${runA.manifest.comparableKey}\nB=${runB.manifest.comparableKey}`,
    );
  }
  const alpha = options.alpha ?? 0.05;
  const minDelta = options.minDelta ?? 5; // at least 5pp gap to call meaningful

  const byId = new Map<string, CaseRunResult>(runB.results.map((r) => [r.case.id, r]));
  const aligned: Array<{ a: CaseRunResult; b: CaseRunResult }> = [];
  for (const a of runA.results) {
    const b = byId.get(a.case.id);
    if (b) aligned.push({ a, b });
  }
  const n = aligned.length;
  if (n === 0) throw new Error(`discriminate: no overlapping cases between runs`);

  const aOverall = aligned.map(({ a }) => a.combinedOverall);
  const bOverall = aligned.map(({ b }) => b.combinedOverall);
  const overall = pairedBootstrap(aOverall, bOverall, 10000, alpha);

  const perDim = {} as Record<Dim, { aMean: number; bMean: number; meanDiff: number; ci: [number, number]; pValue: number }>;
  for (const d of DIMS) {
    const aDim = aligned.map(({ a }) => a.combined[d] ?? 0);
    const bDim = aligned.map(({ b }) => b.combined[d] ?? 0);
    const dimResult = pairedBootstrap(aDim, bDim, 5000, alpha);
    perDim[d] = {
      aMean: round1(aDim.reduce((s, x) => s + x, 0) / n),
      bMean: round1(bDim.reduce((s, x) => s + x, 0) / n),
      meanDiff: dimResult.meanDiff,
      ci: [dimResult.lower, dimResult.upper],
      pValue: dimResult.pValue,
    };
  }

  // Per-modality stratification
  const byModality = new Map<string, Array<{ aScore: number; bScore: number }>>();
  for (const { a, b } of aligned) {
    const m = a.meta.modality ?? "UNK";
    if (!byModality.has(m)) byModality.set(m, []);
    byModality.get(m)!.push({ aScore: a.combinedOverall, bScore: b.combinedOverall });
  }
  const perModality: DiscriminationReport["perModality"] = [];
  const thinStrata: DiscriminationReport["thinStrata"] = [];
  for (const [m, rows] of byModality.entries()) {
    const r = pairedBootstrap(rows.map((x) => x.aScore), rows.map((x) => x.bScore), 3000, alpha);
    if (rows.length < MIN_STRATUM_N) {
      thinStrata.push({ dimension: "modality", key: m, n: rows.length, meanDiff: r.meanDiff, ci: [r.lower, r.upper] });
    } else {
      perModality.push({ modality: m, n: rows.length, meanDiff: r.meanDiff, ci: [r.lower, r.upper] });
    }
  }

  // Per-difficulty stratification
  const byDiff = new Map<string, Array<{ aScore: number; bScore: number }>>();
  for (const { a, b } of aligned) {
    const d = a.case.difficulty ?? "unspecified";
    if (!byDiff.has(d)) byDiff.set(d, []);
    byDiff.get(d)!.push({ aScore: a.combinedOverall, bScore: b.combinedOverall });
  }
  const perDifficulty: DiscriminationReport["perDifficulty"] = [];
  for (const [d, rows] of byDiff.entries()) {
    const r = pairedBootstrap(rows.map((x) => x.aScore), rows.map((x) => x.bScore), 3000, alpha);
    if (rows.length < MIN_STRATUM_N) {
      thinStrata.push({ dimension: "difficulty", key: d, n: rows.length, meanDiff: r.meanDiff, ci: [r.lower, r.upper] });
    } else {
      perDifficulty.push({ difficulty: d, n: rows.length, meanDiff: r.meanDiff, ci: [r.lower, r.upper] });
    }
  }

  const aMean = round1(aOverall.reduce((s, x) => s + x, 0) / n);
  const bMean = round1(bOverall.reduce((s, x) => s + x, 0) / n);
  const significant = overall.pValue < alpha && overall.lower > 0;

  const notes: string[] = [];
  let verdict: DiscriminationReport["verdict"];
  if (significant && Math.abs(overall.meanDiff) >= minDelta) {
    verdict = "discriminates";
    notes.push(`Significant separation: ΔMean=${overall.meanDiff.toFixed(2)}pp, 95% CI [${overall.lower.toFixed(2)}, ${overall.upper.toFixed(2)}], p=${overall.pValue.toFixed(4)}`);
  } else if (significant) {
    verdict = "weak";
    notes.push(`Statistically significant but small effect (${overall.meanDiff.toFixed(2)}pp < ${minDelta}pp threshold).`);
  } else {
    verdict = "fails";
    notes.push(`Cannot reject null at α=${alpha}: 95% CI includes 0 or covers wrong direction.`);
  }

  // Stratum collapse check
  const wrongStrata = perModality.filter((s) => s.ci[0] < 0 && s.ci[1] < 0).length
    + perDifficulty.filter((s) => s.ci[0] < 0 && s.ci[1] < 0).length;
  if (wrongStrata > 0) notes.push(`${wrongStrata} stratum/strata reverse the global ranking — investigate.`);
  if (thinStrata.length > 0) {
    notes.push(`${thinStrata.length} thin stratum/strata (n < ${MIN_STRATUM_N}) reported with wide CIs; treat per-cell numbers as uncertain.`);
  }

  return {
    comparableKey: runA.manifest.comparableKey,
    modelA: { runName: runA.manifest.runName, modelLabel: runA.manifest.modelLabel },
    modelB: { runName: runB.manifest.runName, modelLabel: runB.manifest.modelLabel },
    caseCount: n,
    overall: { aMean, bMean, meanDiff: overall.meanDiff, ci: [overall.lower, overall.upper], pValue: overall.pValue, significant },
    perDim,
    perModality,
    perDifficulty,
    thinStrata,
    verdict,
    notes,
  };
}

/**
 * Sanity check: the gold reference report itself should score near-perfect.
 * Returns the per-case score distribution when each case's referenceReport is
 * scored as if it were the model output. Used to expose dataset/scoring bugs.
 *
 * Caller supplies a scorer because deterministic + judge wiring lives in benchmark.ts.
 */
export type ReferenceProbe = {
  totalCases: number;
  withReference: number;
  meanOverall: number;
  median: number;
  failures: Array<{ caseId: string; overall: number }>;
  passRate: number;
};

export function summarizeReferenceProbe(rows: Array<{ caseId: string; overall: number }>): ReferenceProbe {
  const total = rows.length;
  const overalls = rows.map((r) => r.overall).sort((a, b) => a - b);
  const mean = total === 0 ? 0 : overalls.reduce((s, x) => s + x, 0) / total;
  const median = total === 0 ? 0 : total % 2 === 0 ? (overalls[total / 2 - 1] + overalls[total / 2]) / 2 : overalls[Math.floor(total / 2)];
  const failures = rows.filter((r) => r.overall < REFERENCE_PROBE_PASS_THRESHOLD);
  const passRate = total === 0 ? 0 : (rows.filter((r) => r.overall >= REFERENCE_PROBE_PASS_THRESHOLD).length / total) * 100;
  return {
    totalCases: total,
    withReference: total,
    meanOverall: round1(mean),
    median: round1(median),
    failures,
    passRate: round1(passRate),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
