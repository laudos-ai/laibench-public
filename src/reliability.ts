/**
 * pass^k reliability for repeated runs of the SAME system on the SAME suite.
 *
 * Motivation: a single-shot critical-finding pass-rate saturates quickly and is
 * gameable by verbose "restate every handed-in finding" reports. What matters
 * clinically is CONSISTENCY — does the system preserve every critical finding
 * on EVERY attempt? pass^k answers that: the fraction of cases for which the
 * critical-finding gate held across all k runs.
 *
 * This is a meta-metric computed over k SuiteRunResult objects (the same system,
 * same suite, k independent attempts). It does not change scoring; it summarizes
 * stability of the existing critical-finding gate and the overall verdict.
 *
 * No external dependencies.
 */

import type { SuiteRunResult, CaseRunResult } from "./types.js";

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * A run is "critical-safe" for a case when it preserved every critical FINDING:
 * no deterministic critical-finding failure (CRIT-dimension critFails OR any
 * failed severity:'critical' check) and no judge-flagged critical failure. This
 * is intentionally NARROWER than the overall gate — a case can FAIL its verdict
 * on low RAG/structure while still preserving all critical findings, and that
 * distinction is the whole point of a critical-finding safety metric. It is the
 * per-(case, run) unit pass^k aggregates.
 *
 * FIX (gap-4/gap-5): a deterministic failed critical check is the SAME signal
 * scoring.ts vetoes on (hasDetCritical: checks.some(c => !c.passed &&
 * c.severity==='critical')). A critical check can fail in a dimension other than
 * CRIT (so detDims.CRIT.critFails stays 0), and the old headline silently passed
 * it. Aligning here closes that escape — the critical-safe headline can never
 * rate a case safe while a critical finding actually failed.
 */
export function isCriticalSafe(result: CaseRunResult): boolean {
  const detCritFails = result.detDims?.CRIT?.critFails ?? 0;
  const judgeCritFails = result.judge?.critical_failures?.length ?? 0;
  const failedCriticalCheck = (result.checks ?? []).some(
    (check) => !check.passed && check.severity === "critical",
  );
  return detCritFails === 0 && judgeCritFails === 0 && !failedCriticalCheck;
}

export type CaseReliability = {
  caseId: string;
  k: number;
  /** runs in which all critical findings were preserved (gate held) */
  criticalSafePasses: number;
  /** runs whose overall verdict was not FAIL */
  verdictPasses: number;
  /** criticalSafePasses / k */
  criticalSafeRate: number;
  /** true iff the critical gate held in ALL k runs */
  consistentlyCriticalSafe: boolean;
};

export type ReliabilityReport = {
  /** number of repeated runs compared */
  k: number;
  caseCount: number;
  /**
   * HEADLINE: pass^k for critical-finding safety — fraction of cases that
   * preserved every critical finding across ALL k runs.
   */
  passPowerKCriticalSafe: number;
  /** pass@1 baseline: mean per-case single-run critical-safe rate */
  passAt1CriticalSafe: number;
  /** pass^k over the overall verdict (verdict !== FAIL on all k runs) */
  passPowerKVerdict: number;
  /** pass@1 over the overall verdict */
  passAt1Verdict: number;
  /** cases that were critical-safe in some but not all runs (the flaky tail) */
  flakyCriticalCases: string[];
  perCase: CaseReliability[];
};

/**
 * Compute pass^k reliability across k runs of the same suite. All runs must
 * cover exactly the same set of case ids (fails loud otherwise — a reliability
 * number over a shifting case set would be meaningless).
 */
export function reliabilityAtK(runs: SuiteRunResult[]): ReliabilityReport {
  if (runs.length === 0) throw new Error("reliabilityAtK: need >= 1 run");
  const k = runs.length;

  const caseIds = runs[0].results.map((r) => r.case.id);
  const expected = new Set(caseIds);
  if (expected.size !== caseIds.length) {
    throw new Error("reliabilityAtK: duplicate case ids within a run");
  }
  for (let i = 0; i < runs.length; i++) {
    const ids = new Set(runs[i].results.map((r) => r.case.id));
    if (ids.size !== expected.size || caseIds.some((id) => !ids.has(id))) {
      throw new Error(
        `reliabilityAtK: run ${i} (${runs[i].manifest?.runName ?? "?"}) covers a different case set than run 0`,
      );
    }
  }

  const perCase: CaseReliability[] = caseIds.map((caseId) => {
    let criticalSafePasses = 0;
    let verdictPasses = 0;
    for (const run of runs) {
      const res = run.results.find((r) => r.case.id === caseId);
      if (!res) continue;
      if (isCriticalSafe(res)) criticalSafePasses++;
      if (res.verdict !== "FAIL") verdictPasses++;
    }
    return {
      caseId,
      k,
      criticalSafePasses,
      verdictPasses,
      criticalSafeRate: round4(criticalSafePasses / k),
      consistentlyCriticalSafe: criticalSafePasses === k,
    };
  });

  const n = perCase.length || 1;
  const passPowerKCriticalSafe = round4(
    perCase.filter((c) => c.consistentlyCriticalSafe).length / n,
  );
  const passAt1CriticalSafe = round4(
    perCase.reduce((s, c) => s + c.criticalSafeRate, 0) / n,
  );
  const passPowerKVerdict = round4(
    perCase.filter((c) => c.verdictPasses === k).length / n,
  );
  const passAt1Verdict = round4(
    perCase.reduce((s, c) => s + c.verdictPasses / k, 0) / n,
  );
  const flakyCriticalCases = perCase
    .filter((c) => c.criticalSafePasses > 0 && c.criticalSafePasses < k)
    .map((c) => c.caseId);

  return {
    k,
    caseCount: perCase.length,
    passPowerKCriticalSafe,
    passAt1CriticalSafe,
    passPowerKVerdict,
    passAt1Verdict,
    flakyCriticalCases,
    perCase,
  };
}

/** Render a reliability report as leaderboard-style markdown. */
export function reliabilityToMarkdown(report: ReliabilityReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`# Reliability (pass^${report.k})`);
  lines.push("");
  lines.push(`Cases: ${report.caseCount} | Runs (k): ${report.k}`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| **Critical-safe pass^${report.k}** (headline) | ${pct(report.passPowerKCriticalSafe)} |`);
  lines.push(`| Critical-safe pass@1 | ${pct(report.passAt1CriticalSafe)} |`);
  lines.push(`| Verdict pass^${report.k} | ${pct(report.passPowerKVerdict)} |`);
  lines.push(`| Verdict pass@1 | ${pct(report.passAt1Verdict)} |`);
  lines.push("");
  if (report.flakyCriticalCases.length > 0) {
    lines.push(`Flaky (critical-safe in some but not all runs): ${report.flakyCriticalCases.join(", ")}`);
  } else {
    lines.push("No flaky critical cases: every case was critical-safe in all-or-none of the runs.");
  }
  return lines.join("\n");
}
