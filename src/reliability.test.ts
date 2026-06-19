import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reliabilityAtK, isCriticalSafe, reliabilityToMarkdown } from "./reliability.js";
import type { SuiteRunResult, CaseRunResult, Verdict } from "./types.js";

// Minimal CaseRunResult factory — reliability reads case.id, detDims.CRIT.critFails,
// judge.critical_failures, and verdict.
function mkCase(
  id: string,
  opts: {
    criticalFail?: boolean;
    judgeCriticalFail?: boolean;
    /** A failed severity:'critical' check in a dimension other than CRIT (detDims.CRIT.critFails stays 0). */
    criticalCheckFail?: boolean;
    verdict?: Exclude<Verdict, "UNSCORED">;
  } = {},
): CaseRunResult {
  const detDims = { CRIT: { critFails: opts.criticalFail ? 1 : 0 } };
  const judge = opts.judgeCriticalFail ? { critical_failures: [{ dim: "CRIT", issue: "x", evidence: "y" }] } : null;
  const checks = opts.criticalCheckFail
    ? [{ dim: "QUAL", id: "c", name: "critical preserved", severity: "critical", passed: false, evidence: "missed" }]
    : [];
  const verdict = opts.verdict ?? (opts.criticalFail ? "FAIL" : "PASS");
  return { case: { id }, detDims, judge, checks, verdict } as unknown as CaseRunResult;
}

function mkRun(name: string, cases: CaseRunResult[]): SuiteRunResult {
  return { manifest: { runName: name } as SuiteRunResult["manifest"], results: cases } as unknown as SuiteRunResult;
}

describe("reliabilityAtK", () => {
  it("pass^k = 1 when every case is critical-safe in all runs", () => {
    const runs = [
      mkRun("r1", [mkCase("A"), mkCase("B")]),
      mkRun("r2", [mkCase("A"), mkCase("B")]),
      mkRun("r3", [mkCase("A"), mkCase("B")]),
    ];
    const r = reliabilityAtK(runs);
    assert.equal(r.k, 3);
    assert.equal(r.caseCount, 2);
    assert.equal(r.passPowerKCriticalSafe, 1);
    assert.equal(r.passAt1CriticalSafe, 1);
    assert.equal(r.flakyCriticalCases.length, 0);
  });

  it("a single critical miss in one run drops pass^k but not pass@1 fully (the flaky tail)", () => {
    // Case A: critical-safe in 2 of 3 runs -> flaky. Case B: always safe.
    const runs = [
      mkRun("r1", [mkCase("A"), mkCase("B")]),
      mkRun("r2", [mkCase("A", { criticalFail: true }), mkCase("B")]),
      mkRun("r3", [mkCase("A"), mkCase("B")]),
    ];
    const r = reliabilityAtK(runs);
    // Only B is consistently safe -> pass^k = 1/2 = 0.5
    assert.equal(r.passPowerKCriticalSafe, 0.5);
    // pass@1 = mean(2/3, 3/3) = mean(0.6667, 1) = 0.8333
    assert.ok(Math.abs(r.passAt1CriticalSafe - 0.8333) < 1e-3);
    assert.deepEqual(r.flakyCriticalCases, ["A"]);
    const caseA = r.perCase.find((c) => c.caseId === "A")!;
    assert.equal(caseA.criticalSafePasses, 2);
    assert.equal(caseA.consistentlyCriticalSafe, false);
  });

  it("pass^k = 0 when a case fails the critical gate in at least one run, for all cases", () => {
    const runs = [
      mkRun("r1", [mkCase("A", { criticalFail: true })]),
      mkRun("r2", [mkCase("A")]),
    ];
    const r = reliabilityAtK(runs);
    assert.equal(r.passPowerKCriticalSafe, 0);
    assert.equal(r.passAt1CriticalSafe, 0.5);
  });

  it("verdict pass^k tracks FAIL verdicts independently of the critical gate", () => {
    // Critical-safe but verdict FAIL (e.g. low overall, no critical miss)
    const runs = [
      mkRun("r1", [mkCase("A", { verdict: "FAIL" })]),
      mkRun("r2", [mkCase("A", { verdict: "PASS" })]),
    ];
    const r = reliabilityAtK(runs);
    assert.equal(r.passPowerKCriticalSafe, 1); // never a critical failure
    assert.equal(r.passPowerKVerdict, 0); // failed verdict in run 1
    assert.equal(r.passAt1Verdict, 0.5);
  });

  it("throws when runs cover different case sets", () => {
    const runs = [mkRun("r1", [mkCase("A"), mkCase("B")]), mkRun("r2", [mkCase("A"), mkCase("C")])];
    assert.throws(() => reliabilityAtK(runs), /different case set/);
  });

  it("throws on empty input", () => {
    assert.throws(() => reliabilityAtK([]), /need >= 1 run/);
  });

  it("isCriticalSafe reflects critical-finding preservation, not the broad verdict", () => {
    assert.equal(isCriticalSafe(mkCase("X")), true);
    // deterministic critical-finding failure
    assert.equal(isCriticalSafe(mkCase("X", { criticalFail: true })), false);
    // judge-flagged critical failure is also caught
    assert.equal(isCriticalSafe(mkCase("Y", { judgeCriticalFail: true })), false);
    // FIX (gap-4/gap-5): a failed severity:'critical' CHECK — even in a dimension
    // other than CRIT, so detDims.CRIT.critFails is still 0 — must NOT be rated
    // critical-safe. This FAILS against the old isCriticalSafe, which ignored
    // result.checks entirely.
    assert.equal(isCriticalSafe(mkCase("W", { criticalCheckFail: true })), false);
    // a non-critical FAIL verdict (e.g. low RAG) does NOT count as a critical miss
    assert.equal(isCriticalSafe(mkCase("Z", { verdict: "FAIL" })), true);
  });

  it("reliabilityToMarkdown renders the headline pass^k", () => {
    const runs = [mkRun("r1", [mkCase("A")]), mkRun("r2", [mkCase("A")])];
    const md = reliabilityToMarkdown(reliabilityAtK(runs));
    assert.match(md, /pass\^2/);
    assert.match(md, /headline/);
  });
});
