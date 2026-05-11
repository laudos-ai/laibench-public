import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calibrateJudges, scanContamination } from "./calibrate.js";
import type { CaseRunResult, Dim, JudgeResult, SuiteRunResult } from "./types.js";

function fakeJudge(overallScale1to5: number): JudgeResult {
  return {
    verdict: "PASS",
    scores: { CRIT: overallScale1to5, QUAL: overallScale1to5, TERM: overallScale1to5, GUIDE: overallScale1to5, RAG: overallScale1to5 },
    overall: overallScale1to5,
    critical_failures: [],
    missing: [],
    hallucinated: [],
    spot_checks: [],
    fix: "",
  };
}

function fakeCase(id: string, det: number, judgeOverall: number, html = "ok"): CaseRunResult {
  const dim: Record<Dim, number | null> = { CRIT: det, QUAL: det, TERM: det, GUIDE: det, RAG: det };
  return {
    case: { id, exam: "x", findings: "y", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: html,
    normalizedHtml: html,
    sanitizedHtml: html,
    meta: { modality: "CT", contrast: false, region: "head", normalizedExam: "", normalizedFindings: "", abnormalStudy: false, expectedTitleTokens: [], expectedRegionTokens: [] },
    checks: [],
    detDims: { CRIT: { score: det, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, QUAL: { score: det, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, TERM: { score: det, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, GUIDE: { score: det, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, RAG: { score: det, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 } },
    detOverall: det,
    judge: fakeJudge(judgeOverall),
    combined: dim,
    combinedOverall: det,
    verdict: "PASS",
    confidence: "high",
    phaseStatus: "complete",
    gateReasons: [],
    costUsd: 0,
    latencyMs: 0,
    trace: [],
  };
}

function fakeRun(name: string, judgeModel: string, perCase: Array<{ id: string; det: number; judge: number }>, canary?: string): SuiteRunResult {
  return {
    manifest: {
      benchmarkName: "laibench",
      benchmarkVersion: "2.0.0",
      createdAt: "",
      runName: name,
      suiteId: "test",
      suiteLabel: "",
      suiteVisibility: "public",
      suiteHash: "h",
      locale: "pt-BR",
      track: "model",
      provider: "openrouter",
      modelLabel: "model",
      entityName: "test",
      entityType: "research",
      systemType: "raw-model",
      comparisonClass: "test",
      scaffoldId: null,
      judgeProvider: "openrouter",
      judgeModel,
      evaluationMode: "local",
      submissionMode: "generator",
      validation: { valid: true, expectedIds: [], receivedIds: [], missingIds: [], duplicateIds: [], extraIds: [], emptyOutputs: [], errors: [] },
      comparableKey: "k",
      canaryToken: canary,
    },
    summary: { accuracyRate: 0, averageOverall: 0, passRate: 0, strictPassRate: 0, averageLatencyMs: 0, totalCostUsd: 0, verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 0 }, averagePerDim: {} },
    results: perCase.map((c) => fakeCase(c.id, c.det, c.judge)),
  };
}

describe("calibrateJudges", () => {
  it("flags 'calibrated' when det↔judge correlation is strong and α high", () => {
    const cases = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, det: 60 + i * 2, judge: 3 + i * 0.1 }));
    const run1 = fakeRun("r1", "claude-opus", cases);
    const run2 = fakeRun("r2", "claude-opus", cases);
    const r = calibrateJudges([run1, run2]);
    assert.equal(r.verdict, "calibrated");
    assert.ok(r.testRetestAlpha! >= 0.8);
    assert.ok(r.detVsJudgeCorrelation.spearman >= 0.4);
  });

  it("flags 'uncalibrated' when det↔judge correlation is near zero", () => {
    const cases = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, det: 60 + i * 2, judge: 3 - i * 0.1 + (i % 2) }));
    const run = fakeRun("r1", "j", cases);
    const r = calibrateJudges([run]);
    assert.ok(r.verdict !== "calibrated");
  });

  it("computes cross-judge metrics when 2+ judges share the suite", () => {
    const cases = Array.from({ length: 15 }, (_, i) => ({ id: `c${i}`, det: 60 + i * 2, judge: 3 + i * 0.1 }));
    const a = fakeRun("a", "judge-A", cases);
    const b = fakeRun("b", "judge-B", cases.map((c) => ({ ...c, judge: c.judge - 0.05 })));
    const r = calibrateJudges([a, b]);
    assert.ok(r.crossJudgeAlpha !== undefined);
  });

  it("throws when runs have different comparable keys", () => {
    const a = fakeRun("a", "j", [{ id: "1", det: 80, judge: 4 }]);
    const b = fakeRun("b", "j", [{ id: "1", det: 80, judge: 4 }]);
    b.manifest.comparableKey = "other";
    assert.throws(() => calibrateJudges([a, b]));
  });
});

describe("scanContamination", () => {
  it("flags 'contaminated' when canary token leaks in output", () => {
    const cases = [
      { id: "1", det: 80, judge: 4 },
      { id: "2", det: 80, judge: 4 },
    ];
    const run = fakeRun("r", "j", cases, "CANARY-XYZ-123");
    run.results[0].rawHtml = "leaked CANARY-XYZ-123 in output";
    const r = scanContamination(run);
    assert.equal(r.verdict, "contaminated");
    assert.equal(r.canaryHits, 1);
  });

  it("flags 'suspicious' when judge raises contamination but no canary leak", () => {
    const cases = [{ id: "1", det: 80, judge: 4 }];
    const run = fakeRun("r", "j", cases, "TOKEN");
    run.results[0].judge!.critical_failures = [{ dim: "CRIT", issue: "contamination-suspect", evidence: "" }];
    const r = scanContamination(run);
    assert.equal(r.verdict, "suspicious");
    assert.equal(r.judgeFlaggedContamination, 1);
  });

  it("flags 'clean' when no contamination signals", () => {
    const cases = [{ id: "1", det: 80, judge: 4 }];
    const run = fakeRun("r", "j", cases, "TOKEN");
    const r = scanContamination(run);
    assert.equal(r.verdict, "clean");
  });
});
