import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConsolidatedReport, reportToMarkdown } from "./report.js";
import type { CaseRunResult, Dim, SuiteRunResult } from "./types.js";

function makeRun(name: string, mean: number, ci: [number, number] = [mean - 2, mean + 2]): SuiteRunResult {
  const results: CaseRunResult[] = Array.from({ length: 10 }, (_, i) => ({
    case: { id: `c${i}`, exam: "ct head", findings: "ok", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: "<center>ok</center>",
    normalizedHtml: "<center>ok</center>",
    sanitizedHtml: "<center>ok</center>",
    meta: { modality: "CT", contrast: false, region: "head", normalizedExam: "", normalizedFindings: "", abnormalStudy: false, expectedTitleTokens: [], expectedRegionTokens: [] },
    checks: [],
    detDims: { CRIT: { score: mean, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, QUAL: { score: mean, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, TERM: { score: mean, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, GUIDE: { score: mean, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 }, RAG: { score: mean, pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: 0 } },
    detOverall: mean,
    judge: null,
    combined: { CRIT: mean, QUAL: mean, TERM: mean, GUIDE: mean, RAG: mean } as Record<Dim, number | null>,
    combinedOverall: i % 2 === 0 ? ci[0] + (mean - ci[0]) : ci[1] - (ci[1] - mean),
    verdict: "PASS",
    confidence: "high",
    phaseStatus: "complete",
    gateReasons: [],
    costUsd: 0,
    latencyMs: 100,
    trace: [],
  }));
  return {
    manifest: {
      benchmarkName: "laibench",
      benchmarkVersion: "2.0.0",
      createdAt: "",
      runName: name,
      suiteId: "test",
      suiteLabel: "",
      suiteVisibility: "public",
      suiteHash: "deadbeef",
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
      canaryToken: "TOKEN",
    },
    summary: {
      accuracyRate: 50,
      averageOverall: mean,
      passRate: 100,
      strictPassRate: 50,
      averageLatencyMs: 100,
      totalCostUsd: 0.5,
      verdictCounts: { PASS: 10, PARTIAL: 0, FAIL: 0 },
      averagePerDim: { CRIT: mean, QUAL: mean, TERM: mean, GUIDE: mean, RAG: mean } as Partial<Record<Dim, number>>,
    },
    results,
  };
}

describe("buildConsolidatedReport", () => {
  it("produces a primary block with CI and contamination scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lai-report-"));
    try {
      const path = join(dir, "primary.json");
      writeFileSync(path, JSON.stringify(makeRun("primary", 80)));
      const r = await buildConsolidatedReport({ primaryPath: path });
      assert.equal(r.primary.runName, "primary");
      assert.equal(r.primary.n, 10);
      assert.ok(r.primary.mean > 0);
      assert.ok(r.primary.ci95[0] <= r.primary.ci95[1]);
      assert.equal(r.contamination.verdict, "clean");
      assert.equal(r.benchmarkVersion, "2.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes discrimination block when baseline supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lai-report-"));
    try {
      const a = join(dir, "a.json");
      const b = join(dir, "b.json");
      writeFileSync(a, JSON.stringify(makeRun("modelA", 90, [88, 92])));
      writeFileSync(b, JSON.stringify(makeRun("modelB", 60, [58, 62])));
      const r = await buildConsolidatedReport({ primaryPath: a, baselinePath: b });
      assert.ok(r.discrimination);
      assert.equal(r.discrimination!.baselineRun, "modelB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders markdown with all sections", () => {
    const r: Awaited<ReturnType<typeof buildConsolidatedReport>> = {
      generatedAt: "2026-05-09T00:00:00Z",
      benchmarkVersion: "2.0.0",
      primary: {
        runName: "test",
        suiteId: "lite",
        locale: "pt-BR",
        judge: "openrouter:claude-opus-4.6",
        n: 49,
        mean: 84.5,
        ci95: [81.2, 87.6],
        perDim: { CRIT: 90, QUAL: 80 },
        passRate: 90,
        strictPassRate: 70,
        cost: 1.234,
        avgLatencyMs: 1200,
      },
      contamination: { verdict: "clean", canaryHits: 0, judgeFlagged: 0, canaryToken: "T" },
      calibration: { verdict: "calibrated", notes: ["α=0.85"] },
      discrimination: { baselineRun: "baseline", verdict: "discriminates", meanDiff: 14.2, ci95: [10, 18], pValue: 0.0001, notes: ["solid gap"] },
      perturbation: { overallCatchRate: 92, verdict: "robust", perKind: [{ kind: "laterality_flip", n: 49, caught: 45, rate: 91.84 }] },
      provenance: { suiteHash: "abc", note: "scoringHash=def" },
    };
    const md = reportToMarkdown(r);
    assert.match(md, /Consolidated Report/);
    assert.match(md, /Mean overall/);
    assert.match(md, /Contamination scan/);
    assert.match(md, /Judge calibration/);
    assert.match(md, /Discrimination/);
    assert.match(md, /Adversarial perturbation/);
    assert.match(md, /Provenance/);
  });
});
