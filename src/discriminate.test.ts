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
      { caseId: "4", overall: 83 },
    ];
    const r = summarizeReferenceProbe(rows);
    assert.equal(r.totalCases, 4);
    assert.equal(r.passRate, 75);
    assert.deepEqual(r.failures.map((f) => f.caseId), ["4"]);
    assert.ok(r.median >= 85 && r.median <= 90);
  });

  it("handles empty input", () => {
    const r = summarizeReferenceProbe([]);
    assert.equal(r.totalCases, 0);
    assert.equal(r.passRate, 0);
  });
});

describe("discriminate thin strata (per-cell n + CI)", () => {
  it("surfaces a thin stratum (n < 5) with its n and CI instead of dropping it, and the CI widens as n shrinks", () => {
    // Same per-case delta pattern in both strata, different n. Thin US stratum
    // (n=3) must appear in thinStrata; wide CT stratum (n=20) stays ranked.
    const pattern = [10, 20, 30];
    const us = Array.from({ length: 3 }, (_, i) => ({ id: `us${i}`, base: 70, modality: "US" as const }));
    const ct = Array.from({ length: 20 }, (_, i) => ({ id: `ct${i}`, base: 70, modality: "CT" as const }));
    const all = [...us, ...ct];
    const a = fakeRun("A", all.map((c, i) => ({ id: c.id, overall: c.base + pattern[i % 3], modality: c.modality })));
    const b = fakeRun("B", all.map((c) => ({ id: c.id, overall: c.base, modality: c.modality })));

    const r = discriminate(a, b);

    const thinUs = r.thinStrata.find((t) => t.dimension === "modality" && t.key === "US");
    assert.ok(thinUs, "thin US stratum should be surfaced");
    assert.equal(thinUs!.n, 3);
    assert.equal(thinUs!.ci.length, 2);
    assert.ok(thinUs!.ci[1] >= thinUs!.ci[0], "CI is ordered [lower, upper]");

    // US must NOT be ranked among the n>=5 strata.
    assert.equal(r.perModality.some((m) => m.modality === "US"), false);
    const ct20 = r.perModality.find((m) => m.modality === "CT");
    assert.ok(ct20, "CT stratum (n=20) should be ranked");

    const width = (ci: [number, number]) => ci[1] - ci[0];
    assert.ok(
      width(thinUs!.ci) > width(ct20!.ci),
      `thin n=3 CI width ${width(thinUs!.ci)} should exceed n=20 CI width ${width(ct20!.ci)}`,
    );
    assert.ok(r.notes.some((note) => /thin stratum/.test(note)), "a thin-stratum note should be emitted");
  });
});
