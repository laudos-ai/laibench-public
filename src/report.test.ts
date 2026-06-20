import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConsolidatedReport, reportToMarkdown } from "./report.js";
import { buildComparableKey } from "./manifests.js";
import type { CaseRunResult, Dim, SuiteRunResult } from "./types.js";

function makeRun(name: string, mean: number, ci: [number, number] = [mean - 2, mean + 2]): SuiteRunResult {
  // Keep the fixture internally HONEST: the stored verdict (and the summary rates
  // derived from it) must match what the gated combiner would produce for a run
  // whose every dimension scores `mean`. Otherwise the integrity gate that
  // buildConsolidatedReport now enforces (FIX 3) would (correctly) reject it.
  const verdict: "PASS" | "PARTIAL" | "FAIL" = mean >= 84 ? "PASS" : mean >= 60 ? "PARTIAL" : "FAIL";
  const dimVerdict = verdict;
  const isPass = verdict === "PASS";
  const isNonFail = verdict !== "FAIL";
  const results: CaseRunResult[] = Array.from({ length: 10 }, (_, i) => ({
    case: { id: `c${i}`, exam: "ct head", findings: "ok", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: "<center>ok</center>",
    normalizedHtml: "<center>ok</center>",
    sanitizedHtml: "<center>ok</center>",
    meta: { modality: "CT", contrast: false, region: "head", normalizedExam: "", normalizedFindings: "", abnormalStudy: false, expectedTitleTokens: [], expectedRegionTokens: [] },
    checks: [],
    detDims: { CRIT: { score: mean, pass: isPass ? 1 : 0, total: 1, critFails: 0, verdict: dimVerdict, appliedWeight: 0 }, QUAL: { score: mean, pass: isPass ? 1 : 0, total: 1, critFails: 0, verdict: dimVerdict, appliedWeight: 0 }, TERM: { score: mean, pass: isPass ? 1 : 0, total: 1, critFails: 0, verdict: dimVerdict, appliedWeight: 0 }, GUIDE: { score: mean, pass: isPass ? 1 : 0, total: 1, critFails: 0, verdict: dimVerdict, appliedWeight: 0 }, RAG: { score: mean, pass: isPass ? 1 : 0, total: 1, critFails: 0, verdict: dimVerdict, appliedWeight: 0 } },
    detOverall: mean,
    judge: null,
    combined: { CRIT: mean, QUAL: mean, TERM: mean, GUIDE: mean, RAG: mean } as Record<Dim, number | null>,
    combinedOverall: i % 2 === 0 ? ci[0] + (mean - ci[0]) : ci[1] - (ci[1] - mean),
    verdict,
    confidence: "high",
    phaseStatus: "complete",
    gateReasons: [],
    costUsd: 0,
    latencyMs: 100,
    trace: [],
  }));
  const caseIds = results.map((r) => r.case.id);
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
      validation: { valid: true, expectedIds: caseIds, receivedIds: caseIds, missingIds: [], duplicateIds: [], extraIds: [], emptyOutputs: [], errors: [] },
      comparableKey: buildComparableKey({
        benchmarkVersion: "2.0.0",
        suiteId: "test",
        locale: "pt-BR",
        track: "model",
        comparisonClass: "test",
        scaffoldId: null,
        judgeProvider: null,
        judgeModel: null,
        scoreMode: undefined,
      }),
      canaryToken: "TOKEN",
    },
    summary: {
      accuracyRate: isPass ? 100 : 0,
      averageOverall: mean,
      passRate: isNonFail ? 100 : 0,
      strictPassRate: isPass ? 100 : 0,
      averageLatencyMs: 100,
      // Per-case costUsd is 0 for all 10 cases, so the honest total is 0; the
      // integrity gate (now enforced via FIX 3) recomputes and compares this.
      totalCostUsd: 0,
      verdictCounts: { PASS: isPass ? 10 : 0, PARTIAL: verdict === "PARTIAL" ? 10 : 0, FAIL: verdict === "FAIL" ? 10 : 0 },
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

  it("rejects a tampered run whose critical gate would veto it (FIX 3)", async () => {
    // The consolidated report must route inputs through the same integrity gate
    // as the leaderboard: a run with a failed critical check but a non-FAIL
    // verdict can never be published. This FAILS against the old code, which
    // loaded the primary via bare readJsonFile and never called integrity.
    const dir = mkdtempSync(join(tmpdir(), "lai-report-tamper-"));
    try {
      const tampered = makeRun("tampered", 90); // honest PASS run
      // Inject a deterministic critical-finding miss into one case but leave the
      // verdict at PASS — the critical veto must reject the artifact.
      tampered.results[0].checks = [{
        dim: "CRIT",
        id: "crit-missed",
        name: "no missed critical finding",
        severity: "critical",
        passed: false,
        evidence: "missed acute hemorrhage",
      }];
      // verdict stays "PASS" (the tamper); summary untouched.
      const path = join(dir, "primary.json");
      writeFileSync(path, JSON.stringify(tampered));
      await assert.rejects(
        () => buildConsolidatedReport({ primaryPath: path }),
        /verdict must be FAIL|verdict mismatch|integrity check failed/,
      );
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
        allPassRate: 40,
        criterionPassRate: 92,
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
    assert.match(md, /All-pass completion/);
    assert.match(md, /Criterion pass rate/);
    assert.match(md, /Mean overall/);
    assert.match(md, /Contamination scan/);
    assert.match(md, /Judge calibration/);
    assert.match(md, /Discrimination/);
    assert.match(md, /Adversarial perturbation/);
    assert.match(md, /Provenance/);
  });
});
