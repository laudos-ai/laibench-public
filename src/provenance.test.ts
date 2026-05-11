import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { caseHash, suiteHashFromCases, runHash, leaderboardHash } from "./provenance.js";
import type { BenchCase, RunManifest, SuiteRunResult } from "./types.js";

const c1: BenchCase = { id: "A", exam: "tc cranio", findings: "ok", locale: "pt-BR" };
const c2: BenchCase = { id: "B", exam: "tc torax", findings: "ok", locale: "pt-BR" };

describe("caseHash", () => {
  it("returns 64-char hex sha256", () => {
    const h = caseHash(c1);
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
  it("is stable across calls", () => {
    assert.equal(caseHash(c1), caseHash(c1));
  });
  it("differs between cases", () => {
    assert.notEqual(caseHash(c1), caseHash(c2));
  });
  it("differs when findings change", () => {
    const cMod: BenchCase = { ...c1, findings: "different" };
    assert.notEqual(caseHash(c1), caseHash(cMod));
  });
});

describe("suiteHashFromCases", () => {
  it("is order-independent", () => {
    assert.equal(suiteHashFromCases([c1, c2]), suiteHashFromCases([c2, c1]));
  });
  it("changes when a case content changes", () => {
    const cMod: BenchCase = { ...c1, exam: "X" };
    assert.notEqual(suiteHashFromCases([c1, c2]), suiteHashFromCases([cMod, c2]));
  });
});

describe("runHash", () => {
  const manifest: Omit<RunManifest, "validation" | "createdAt"> = {
    benchmarkName: "laibench",
    benchmarkVersion: "2.0.0",
    runName: "test",
    suiteId: "test-suite",
    suiteLabel: "test",
    suiteVisibility: "public",
    suiteHash: "deadbeef",
    locale: "pt-BR",
    track: "model",
    provider: "openrouter",
    modelLabel: "claude-sonnet-4.6",
      entityName: "test",
      entityType: "research",
      systemType: "raw-model",
      comparisonClass: "test",
    scaffoldId: null,
    judgeProvider: "openrouter",
    judgeModel: "claude-opus-4.6",
    evaluationMode: "local",
    submissionMode: "generator",
    comparableKey: "k",
    canaryToken: "TOKEN",
  };

  it("changes when scoring hash changes", () => {
    const h1 = runHash({ suiteHash: "S1", manifest, scoringHash: "X" });
    const h2 = runHash({ suiteHash: "S1", manifest, scoringHash: "Y" });
    assert.notEqual(h1, h2);
  });

  it("changes when suite hash changes", () => {
    const h1 = runHash({ suiteHash: "S1", manifest, scoringHash: "X" });
    const h2 = runHash({ suiteHash: "S2", manifest, scoringHash: "X" });
    assert.notEqual(h1, h2);
  });
});

describe("leaderboardHash", () => {
  const baseRun = (n: string, avg: number): SuiteRunResult => ({
    manifest: {
      benchmarkName: "laibench",
      benchmarkVersion: "2.0.0",
      createdAt: "",
      runName: n,
      suiteId: "s",
      suiteLabel: "",
      suiteVisibility: "public",
      suiteHash: "deadbeef",
      locale: "pt-BR",
      track: "model",
      provider: "x",
      modelLabel: n,
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
    summary: { accuracyRate: 0, averageOverall: avg, passRate: 0, strictPassRate: 0, averageLatencyMs: 0, totalCostUsd: 0, verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 0 }, averagePerDim: {} },
    results: [],
  });

  it("is order-independent", () => {
    const h1 = leaderboardHash([baseRun("a", 80), baseRun("b", 70)]);
    const h2 = leaderboardHash([baseRun("b", 70), baseRun("a", 80)]);
    assert.equal(h1, h2);
  });
  it("changes when a score changes", () => {
    const h1 = leaderboardHash([baseRun("a", 80)]);
    const h2 = leaderboardHash([baseRun("a", 81)]);
    assert.notEqual(h1, h2);
  });
});
