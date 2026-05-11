import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discriminate, summarizeReferenceProbe } from "./discriminate.js";
import type { CaseRunResult, Dim, SuiteRunResult } from "./types.js";

function fakeCase(id: string, overall: number, modality: "CT" | "MRI" | "US" | "XR" = "CT", difficulty: "easy" | "medium" | "hard" = "medium"): CaseRunResult {
  const combined: Record<Dim, number | null> = { CRIT: overall, QUAL: overall, TERM: overall, GUIDE: overall, RAG: overall };
  return {
    case: { id, exam: "x", findings: "y", locale: "pt-BR", difficulty },
    locale: "pt-BR",
    rawHtml: "",
    normalizedHtml: "",
    sanitizedHtml: "",
    meta: { modality, contrast: false, region: "head", normalizedExam: "", normalizedFindings: "", abnormalStudy: false, expectedTitleTokens: [], expectedRegionTokens: [] },
    checks: [],
    detDims: { CRIT: { score: overall, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, QUAL: { score: overall, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, TERM: { score: overall, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, GUIDE: { score: overall, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, RAG: { score: overall, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 } },
    detOverall: overall,
    judge: null,
    combined,
    combinedOverall: overall,
    verdict: "PASS",
    confidence: "medium",
    phaseStatus: "complete",
    gateReasons: [],
    costUsd: 0,
    latencyMs: 0,
    trace: [],
  };
}

function fakeRun(name: string, perCase: Array<{ id: string; overall: number; modality?: "CT" | "MRI" | "US" | "XR"; difficulty?: "easy" | "medium" | "hard" }>): SuiteRunResult {
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
      provider: "x",
      modelLabel: name,
      entityName: "test",
      entityType: "research",
      systemType: "raw-model",
      comparisonClass: "test",
      scaffoldId: null,
      judgeProvider: null,
      judgeModel: null,
      evaluationMode: "local",
      submissionMode: "generator",
      validation: { valid: true, expectedIds: [], receivedIds: [], missingIds: [], duplicateIds: [], extraIds: [], emptyOutputs: [], errors: [] },
      comparableKey: "k",
    },
    summary: { accuracyRate: 0, averageOverall: 0, passRate: 0, strictPassRate: 0, averageLatencyMs: 0, totalCostUsd: 0, verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 0 }, averagePerDim: {} },
    results: perCase.map((c) => fakeCase(c.id, c.overall, c.modality, c.difficulty)),
  };
}

describe("discriminate", () => {
  it("flags 'discriminates' when A consistently exceeds B by >=5pp", () => {
    const a = fakeRun("A", Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, overall: 90 })));
    const b = fakeRun("B", Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, overall: 70 })));
    const r = discriminate(a, b);
    assert.equal(r.verdict, "discriminates");
    assert.ok(r.overall.meanDiff >= 19);
    assert.ok(r.overall.significant);
  });

  it("flags 'fails' when A == B", () => {
    const a = fakeRun("A", Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, overall: 80 })));
    const b = fakeRun("B", Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, overall: 80 })));
    const r = discriminate(a, b);
    assert.equal(r.verdict, "fails");
  });

  it("flags 'weak' when statistically significant but small effect", () => {
    const a = fakeRun("A", Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, overall: 80 + (i % 2) * 2 })));
    const b = fakeRun("B", Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, overall: 78 + (i % 2) * 2 })));
    const r = discriminate(a, b, { minDelta: 5 });
    assert.equal(r.verdict, "weak");
  });

  it("throws when comparable keys differ", () => {
    const a = fakeRun("A", [{ id: "1", overall: 80 }]);
    const b = fakeRun("B", [{ id: "1", overall: 70 }]);
    b.manifest.comparableKey = "different";
    assert.throws(() => discriminate(a, b));
  });

  it("only includes overlapping case IDs", () => {
    const a = fakeRun("A", [{ id: "x", overall: 90 }, { id: "y", overall: 95 }]);
    const b = fakeRun("B", [{ id: "x", overall: 70 }, { id: "z", overall: 60 }]);
    const r = discriminate(a, b);
    assert.equal(r.caseCount, 1);
  });

  it("computes per-modality strata", () => {
    const ids = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`,
      overall: 90,
      modality: i < 15 ? ("CT" as const) : ("MRI" as const),
    }));
    const a = fakeRun("A", ids);
    const b = fakeRun("B", ids.map((c) => ({ ...c, overall: 70 })));
    const r = discriminate(a, b);
    assert.equal(r.perModality.length, 2);
  });
});

describe("summarizeReferenceProbe", () => {
  it("computes mean, median, pass rate", () => {
    const rows = [
      { caseId: "1", overall: 95 },
      { caseId: "2", overall: 90 },
      { caseId: "3", overall: 85 },
      { caseId: "4", overall: 75 },
    ];
    const r = summarizeReferenceProbe(rows);
    assert.equal(r.totalCases, 4);
    assert.equal(r.passRate, 75);
    assert.equal(r.failures.length, 1);
    assert.ok(r.median >= 85 && r.median <= 90);
  });

  it("handles empty input", () => {
    const r = summarizeReferenceProbe([]);
    assert.equal(r.totalCases, 0);
    assert.equal(r.passRate, 0);
  });
});
