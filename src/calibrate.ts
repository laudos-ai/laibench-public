/**
 * LLM-judge calibration suite.
 *
 * Two consistency tests:
 *  1. **Test-retest reliability**: same judge, same case, multiple runs.
 *     Measured by Krippendorff α on continuous overall scores.
 *  2. **Cross-judge agreement**: different judge models on the same outputs.
 *     Measured by Cohen's κ (verdict) and α (overall).
 *
 * Plus a calibration audit: do judge scores correlate with deterministic
 * scores in the expected direction? If not, the judge or rubric is broken.
 */

import { cohensKappa, krippendorffAlphaInterval } from "./kappa.js";
import type { CaseRunResult, SuiteRunResult, Verdict } from "./types.js";

export type CalibrationReport = {
  comparableKey: string;
  judges: string[];
  caseCount: number;
  testRetestAlpha?: number; // same judge, multiple runs
  crossJudgeKappa?: number; // verdict agreement across judges
  crossJudgeAlpha?: number; // overall score agreement across judges
  detVsJudgeCorrelation: { spearman: number; n: number };
  notes: string[];
  verdict: "calibrated" | "weak" | "uncalibrated";
};

/** Spearman rank correlation. */
function spearman(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;
  const ranks = (arr: number[]): number[] => {
    const sorted = arr
      .map((v, i) => ({ v, i }))
      .sort((a, b) => a.v - b.v);
    const r = new Array(arr.length).fill(0) as number[];
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
      const avgRank = (i + j - 1) / 2 + 1;
      for (let k = i; k < j; k++) r[sorted[k].i] = avgRank;
      i = j;
    }
    return r;
  };
  const rx = ranks(x);
  const ry = ranks(y);
  const n = x.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (rx[i] - ry[i]) ** 2;
  return Number((1 - (6 * sum) / (n * (n * n - 1))).toFixed(6));
}

/**
 * Calibrate judges using:
 *  - 1 or more runs from the SAME judge on the SAME suite (test-retest)
 *  - 0 or more runs from DIFFERENT judges on the SAME suite (cross-judge)
 *
 * Multiple runs of one judge → α.
 * Multiple judges → κ on verdict + α on overall.
 */
export function calibrateJudges(runs: SuiteRunResult[]): CalibrationReport {
  if (runs.length === 0) throw new Error(`calibrateJudges: need >= 1 run`);
  const key = runs[0].manifest.comparableKey;
  for (const r of runs) {
    if (r.manifest.comparableKey !== key) {
      throw new Error(`calibrateJudges: runs must share comparableKey (${r.manifest.comparableKey} !== ${key})`);
    }
  }

  // Group by judge
  const byJudge = new Map<string, SuiteRunResult[]>();
  for (const r of runs) {
    const j = `${r.manifest.judgeProvider ?? "none"}:${r.manifest.judgeModel ?? "none"}`;
    if (!byJudge.has(j)) byJudge.set(j, []);
    byJudge.get(j)!.push(r);
  }

  const judges = [...byJudge.keys()];
  const caseIds = new Set<string>();
  for (const r of runs) for (const c of r.results) caseIds.add(c.case.id);
  const orderedIds = [...caseIds];

  // Build (cases × runs) score matrix
  const scoreMatrix: number[][] = orderedIds.map((id) =>
    runs.map((r) => {
      const found = r.results.find((c) => c.case.id === id);
      return found ? found.combinedOverall : Number.NaN;
    }),
  );

  // Test-retest: any judge with >=2 runs
  let testRetestAlpha: number | undefined;
  for (const [, judgeRuns] of byJudge.entries()) {
    if (judgeRuns.length >= 2) {
      const matrix = orderedIds.map((id) =>
        judgeRuns.map((r) => r.results.find((c) => c.case.id === id)?.combinedOverall ?? Number.NaN),
      );
      testRetestAlpha = krippendorffAlphaInterval(matrix).alpha;
      break;
    }
  }

  // Cross-judge: only if 2+ distinct judges
  let crossJudgeKappa: number | undefined;
  let crossJudgeAlpha: number | undefined;
  if (judges.length >= 2) {
    const judgeAvgPerCase = orderedIds.map((id) =>
      judges.map((j) => {
        const judgeRuns = byJudge.get(j)!;
        const scores: number[] = [];
        for (const r of judgeRuns) {
          const found = r.results.find((c) => c.case.id === id);
          if (found) scores.push(found.combinedOverall);
        }
        return scores.length === 0 ? Number.NaN : scores.reduce((s, x) => s + x, 0) / scores.length;
      }),
    );
    crossJudgeAlpha = krippendorffAlphaInterval(judgeAvgPerCase).alpha;

    if (judges.length === 2) {
      const verdictsA: Verdict[] = [];
      const verdictsB: Verdict[] = [];
      const judgeARuns = byJudge.get(judges[0])!;
      const judgeBRuns = byJudge.get(judges[1])!;
      for (const id of orderedIds) {
        const a = judgeARuns.flatMap((r) => r.results).find((c) => c.case.id === id);
        const b = judgeBRuns.flatMap((r) => r.results).find((c) => c.case.id === id);
        if (a && b) {
          verdictsA.push(a.verdict);
          verdictsB.push(b.verdict);
        }
      }
      if (verdictsA.length > 0) crossJudgeKappa = cohensKappa(verdictsA as string[], verdictsB as string[]).kappa;
    }
  }

  // Det-vs-judge correlation: aggregate across all runs
  const detScores: number[] = [];
  const judgeScores: number[] = [];
  for (const r of runs) {
    for (const c of r.results) {
      if (c.judge && typeof c.detOverall === "number") {
        const j = c.judge.overall ?? null;
        if (j !== null && Number.isFinite(j)) {
          detScores.push(c.detOverall);
          judgeScores.push(j * 20); // judge is 1-5, convert to 0-100
        }
      }
    }
  }
  const corr = spearman(detScores, judgeScores);

  const notes: string[] = [];
  if (testRetestAlpha !== undefined) notes.push(`Test-retest α=${testRetestAlpha.toFixed(3)} (${interpret(testRetestAlpha)})`);
  if (crossJudgeAlpha !== undefined) notes.push(`Cross-judge α=${crossJudgeAlpha.toFixed(3)} (${interpret(crossJudgeAlpha)})`);
  if (crossJudgeKappa !== undefined) notes.push(`Verdict κ=${crossJudgeKappa.toFixed(3)}`);
  notes.push(`Det↔Judge Spearman ρ=${corr.toFixed(3)} on n=${detScores.length}`);

  let verdict: CalibrationReport["verdict"];
  const minMetric = Math.min(testRetestAlpha ?? 1, crossJudgeAlpha ?? 1);
  if (minMetric >= 0.8 && corr >= 0.4) verdict = "calibrated";
  else if (minMetric >= 0.667 && corr >= 0.2) verdict = "weak";
  else verdict = "uncalibrated";

  return {
    comparableKey: key,
    judges,
    caseCount: orderedIds.length,
    testRetestAlpha,
    crossJudgeKappa,
    crossJudgeAlpha,
    detVsJudgeCorrelation: { spearman: corr, n: detScores.length },
    notes,
    verdict,
  };
}

function interpret(a: number): string {
  if (a < 0) return "no agreement";
  if (a < 0.667) return "tentative";
  if (a < 0.8) return "acceptable";
  return "high";
}

/** Detect benchmark contamination signals in a run. */
export type ContaminationReport = {
  runName: string;
  canaryToken: string | undefined;
  canaryHits: number;
  judgeFlaggedContamination: number;
  suspiciousCases: string[];
  verdict: "clean" | "suspicious" | "contaminated";
};

/**
 * Whitespace-insensitive substring search.
 * Defeats trivial evasion (canary token split by spaces or newlines).
 */
function containsCanary(haystack: string, token: string): boolean {
  if (!token) return false;
  const normalize = (s: string): string => s.replace(/\s+/g, "").toLowerCase();
  return normalize(haystack).includes(normalize(token));
}

export function scanContamination(run: SuiteRunResult): ContaminationReport {
  const token = run.manifest.canaryToken;
  let canaryHits = 0;
  let judgeFlagged = 0;
  const suspicious: string[] = [];

  for (const c of run.results) {
    let hit = false;
    if (
      token &&
      (containsCanary(c.rawHtml, token) ||
        containsCanary(c.normalizedHtml, token) ||
        containsCanary(c.sanitizedHtml, token))
    ) {
      canaryHits++;
      suspicious.push(c.case.id);
      hit = true;
    }
    if (!hit && c.judge?.critical_failures.some((f) => f.issue.toLowerCase().includes("contamination"))) {
      judgeFlagged++;
      suspicious.push(c.case.id);
    }
  }

  let verdict: ContaminationReport["verdict"];
  if (canaryHits > 0) verdict = "contaminated";
  else if (judgeFlagged > 0) verdict = "suspicious";
  else verdict = "clean";

  return {
    runName: run.manifest.runName,
    canaryToken: token,
    canaryHits,
    judgeFlaggedContamination: judgeFlagged,
    suspiciousCases: suspicious,
    verdict,
  };
}
