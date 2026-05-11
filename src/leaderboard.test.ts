import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComparableKey } from "./manifests.js";
import { assertSuiteRunIntegrity, buildLeaderboard, leaderboardToMarkdown } from "./leaderboard.js";
import type { CaseRunResult, SuiteRunResult, SubmissionValidation } from "./types.js";

function validation(valid: boolean): SubmissionValidation {
  return {
    valid,
    expectedIds: ["R001"],
    receivedIds: valid ? ["R001"] : [],
    missingIds: valid ? [] : ["R001"],
    duplicateIds: [],
    extraIds: [],
    emptyOutputs: [],
    errors: valid ? [] : ["missing cases: R001"],
  };
}

function run(
  name: string,
  valid: boolean,
  accuracyRate: number,
  averageOverall: number,
  overrides: Partial<SuiteRunResult["manifest"]> = {},
): SuiteRunResult {
  const scaffoldId = overrides.scaffoldId ?? null;
  return {
    manifest: {
      benchmarkName: "laibench",
      benchmarkVersion: "1.0.0",
      createdAt: "2026-05-01T00:00:00.000Z",
      runName: name,
      suiteId: "lite-public.pt-BR",
      suiteLabel: "Reference Public pt-BR",
      suiteVisibility: "public",
      suiteHash: "suite-hash",
      locale: "pt-BR",
      track: "agent",
      provider: "predictions",
      modelLabel: name,
      entityName: name,
      entityType: "agent",
      systemType: "custom-agent",
      comparisonClass: "custom-agent",
      scaffoldId,
      judgeProvider: null,
      judgeModel: null,
      evaluationMode: "local",
      submissionMode: "predictions",
      validation: validation(valid),
      comparableKey: `1.0.0::lite-public.pt-BR::pt-BR::agent::custom-agent::${scaffoldId ?? "none"}::none::none::conservative-min`,
      ...overrides,
    },
    summary: {
      accuracyRate,
      averageOverall,
      passRate: accuracyRate,
      strictPassRate: accuracyRate,
      averageLatencyMs: 10,
      totalCostUsd: 0,
      verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 0 },
      averagePerDim: {},
    },
    results: [],
  };
}

function singleResult(overall = 50, verdict: "PASS" | "PARTIAL" | "FAIL" = "FAIL"): CaseRunResult {
  return {
    case: { id: "R001", exam: "tc cranio", findings: "normal", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: "",
    normalizedHtml: "",
    sanitizedHtml: "",
    meta: {
      modality: "CT",
      contrast: false,
      region: "head",
      normalizedExam: "tc cranio",
      normalizedFindings: "normal",
      abnormalStudy: false,
      expectedTitleTokens: [],
      expectedRegionTokens: [],
    },
    checks: [],
    detDims: {} as never,
    detOverall: overall,
    judge: null,
    combined: { CRIT: overall, QUAL: overall, TERM: overall, GUIDE: overall, RAG: overall },
    combinedOverall: overall,
    verdict,
    confidence: "low",
    phaseStatus: "degraded",
    gateReasons: [],
    costUsd: 0,
    latencyMs: 10,
    trace: [],
  };
}

describe("buildLeaderboard", () => {
  it("does not rank invalid submissions even when their score is higher", () => {
    const leaderboard = buildLeaderboard([
      { path: "/private/tmp/runs/valid.json", run: run("valid-agent", true, 70, 75) },
      { path: "/private/tmp/runs/invalid.json", run: run("invalid-agent", false, 100, 100) },
    ], { requireResults: false });

    const entries = leaderboard.groups[0].entries;
    const valid = entries.find((entry) => entry.runName === "valid-agent");
    const invalid = entries.find((entry) => entry.runName === "invalid-agent");

    assert.equal(valid?.eligible, true);
    assert.equal(valid?.rank, 1);
    assert.equal(valid?.provider, "hidden");
    assert.equal(valid?.sourceFile, "valid.json");
    assert.equal(invalid?.eligible, false);
    assert.equal(invalid?.rank, null);
    assert.equal(invalid?.validation.missingCount, 1);
    assert.deepEqual(invalid?.validation.errors, ["missing cases: 1"]);
  });

  it("prints ineligibility reasons in leaderboard markdown", () => {
    const leaderboard = buildLeaderboard([
      { path: "runs/valid.json", run: run("valid-agent", true, 70, 75) },
      { path: "runs/invalid.json", run: run("invalid-agent", false, 100, 100) },
    ], { requireResults: false });

    const markdown = leaderboardToMarkdown(leaderboard);
    assert.match(markdown, /\| Rank \| Eligible \| Validation \|/);
    assert.match(markdown, /missing cases: 1/);
    assert.match(markdown, /\| 1 \| yes \| ok \|/);
    assert.match(markdown, /\| — \| no \| missing cases: 1 \|/);
  });

  it("sanitizes sensitive run labels in public leaderboard artifacts", () => {
    const leaderboard = buildLeaderboard([
      {
        path: "runs/openrouter-internal.json",
        run: run("openrouter internal /api/generate-structured-report", true, 90, 91),
      },
    ], { requireResults: false });

    const entry = leaderboard.groups[0].entries[0];
    assert.equal(entry.runName, "private internal product reporting flow");
    assert.equal(entry.provider, "hidden");
    assert.equal(entry.sourceFile, "private-internal.json");

    const markdown = leaderboardToMarkdown(leaderboard);
    assert.doesNotMatch(markdown, /openrouter|\/api\/generate/i);
    assert.match(markdown, /private internal product reporting flow/);
  });

  it("sanitizes internal scaffold identifiers in public leaderboard artifacts", () => {
    const leaderboard = buildLeaderboard([
      {
        path: "runs/product-agent.json",
        run: run("Laudos product agent", true, 90, 91, {
          modelLabel: "Laudos product agent",
          entityName: "Laudos product agent",
          systemType: "product-agent",
          comparisonClass: "product-agent",
          scaffoldId: "product-pipeline-v1",
          comparableKey: "1.0.0::lite-public.pt-BR::pt-BR::agent::product-agent::product-pipeline-v1::none::none",
        }),
      },
    ], { requireResults: false });

    const group = leaderboard.groups[0];
    const entry = group.entries[0];
    assert.equal(group.scaffoldId, "product-agent");
    assert.equal(entry.scaffoldId, "product-agent");
    assert.equal(entry.comparisonClass, "product-agent");
    assert.doesNotMatch(group.comparableKey, /pipeline/i);
  });

  it("does not expose raw validation id lists in public leaderboard entries", () => {
    const leaderboard = buildLeaderboard([
      {
        path: "runs/private.json",
        run: run("private-agent", false, 60, 60),
      },
    ], { requireResults: false });

    const entry = leaderboard.groups[0].entries[0];
    assert.equal(entry.validation.expectedCount, 1);
    assert.equal(entry.validation.receivedCount, 0);
    assert.equal(entry.validation.missingCount, 1);
    assert.equal("expectedIds" in entry.validation, false);
    assert.equal("missingIds" in entry.validation, false);

    const serialized = JSON.stringify(leaderboard);
    assert.doesNotMatch(serialized, /R001/);
  });
});

describe("assertSuiteRunIntegrity", () => {
  it("makes buildLeaderboard reject unverifiable artifacts by default", () => {
    assert.throws(() => buildLeaderboard([
      { path: "runs/fake.json", run: run("fake-agent", true, 100, 100) },
    ]), /run has no case results/);
  });

  it("rejects edited summary scores", () => {
    const artifact = run("tampered-agent", true, 100, 100, {
      validation: {
        valid: true,
        expectedIds: ["R001"],
        receivedIds: ["R001"],
        missingIds: [],
        duplicateIds: [],
        extraIds: [],
        emptyOutputs: [],
        errors: [],
      },
    });
    artifact.results = [{
      case: { id: "R001", exam: "tc cranio", findings: "normal", locale: "pt-BR" },
      locale: "pt-BR",
      rawHtml: "",
      normalizedHtml: "",
      sanitizedHtml: "",
      meta: {
        modality: "CT",
        contrast: false,
        region: "head",
        normalizedExam: "tc cranio",
        normalizedFindings: "normal",
        abnormalStudy: false,
        expectedTitleTokens: [],
        expectedRegionTokens: [],
      },
      checks: [],
      detDims: {} as never,
      detOverall: 0,
      judge: null,
      combined: { CRIT: 50, QUAL: 50, TERM: 50, GUIDE: 50, RAG: 50 },
      combinedOverall: 50,
      verdict: "FAIL",
      confidence: "low",
      phaseStatus: "degraded",
      gateReasons: [],
      costUsd: 0,
      latencyMs: 10,
      trace: [],
    }];
    artifact.summary.averageOverall = 100;
    artifact.summary.strictPassRate = 100;
    artifact.summary.accuracyRate = 100;
    artifact.summary.passRate = 100;
    artifact.summary.verdictCounts = { PASS: 1, PARTIAL: 0, FAIL: 0 };
    artifact.summary.averagePerDim = { CRIT: 50, QUAL: 50, TERM: 50, GUIDE: 50, RAG: 50 };

    assert.throws(() => assertSuiteRunIntegrity(artifact, "tampered"), /summary\.averageOverall mismatch/);
  });

  it("rejects comparable keys that omit scoring mode", () => {
    const artifact = run("legacy-key-agent", true, 0, 50);
    artifact.results = [{
      case: { id: "R001", exam: "tc cranio", findings: "normal", locale: "pt-BR" },
      locale: "pt-BR",
      rawHtml: "",
      normalizedHtml: "",
      sanitizedHtml: "",
      meta: {
        modality: "CT",
        contrast: false,
        region: "head",
        normalizedExam: "tc cranio",
        normalizedFindings: "normal",
        abnormalStudy: false,
        expectedTitleTokens: [],
        expectedRegionTokens: [],
      },
      checks: [],
      detDims: {} as never,
      detOverall: 0,
      judge: null,
      combined: { CRIT: 50, QUAL: 50, TERM: 50, GUIDE: 50, RAG: 50 },
      combinedOverall: 50,
      verdict: "FAIL",
      confidence: "low",
      phaseStatus: "degraded",
      gateReasons: [],
      costUsd: 0,
      latencyMs: 10,
      trace: [],
    }];
    artifact.summary = {
      accuracyRate: 0,
      averageOverall: 50,
      passRate: 0,
      strictPassRate: 0,
      averageLatencyMs: 10,
      totalCostUsd: 0,
      verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 1 },
      averagePerDim: { CRIT: 50, QUAL: 50, TERM: 50, GUIDE: 50, RAG: 50 },
    };
    artifact.manifest.comparableKey = "1.0.0::lite-public.pt-BR::pt-BR::agent::custom-agent::none::none::none";

    assert.throws(() => assertSuiteRunIntegrity(artifact, "legacy"), /comparableKey mismatch/);
  });

  it("CLI leaderboard rejects private template runs without shipped locked cases", () => {
    const artifact = run("fake-private-template", true, 0, 50, {
      suiteId: "lite-public.pt-BR",
      suiteLabel: "Leaderboard Private (Template)",
      suiteVisibility: "private",
      suiteHash: "fake-hash-not-checked",
      evaluationMode: "cloud-private",
      validation: {
        valid: true,
        expectedIds: ["R001"],
        receivedIds: ["R001"],
        missingIds: [],
        duplicateIds: [],
        extraIds: [],
        emptyOutputs: [],
        errors: [],
      },
    });
    artifact.manifest.comparableKey = buildComparableKey({
      benchmarkVersion: artifact.manifest.benchmarkVersion,
      suiteId: artifact.manifest.suiteId,
      locale: artifact.manifest.locale,
      track: artifact.manifest.track,
      comparisonClass: artifact.manifest.comparisonClass,
      scaffoldId: artifact.manifest.scaffoldId,
      judgeProvider: artifact.manifest.judgeProvider,
      judgeModel: artifact.manifest.judgeModel,
      scoreMode: artifact.manifest.scoreMode,
    });
    artifact.results = [singleResult()];
    artifact.summary = {
      accuracyRate: 0,
      averageOverall: 50,
      passRate: 0,
      strictPassRate: 0,
      averageLatencyMs: 10,
      totalCostUsd: 0,
      verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 1 },
      averagePerDim: { CRIT: 50, QUAL: 50, TERM: 50, GUIDE: 50, RAG: 50 },
    };

    const dir = mkdtempSync(join(tmpdir(), "laibench-private-template-"));
    const input = join(dir, "fake.json");
    const out = join(dir, "leaderboard.json");
    writeFileSync(input, JSON.stringify(artifact, null, 2));
    assert.throws(
      () => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "leaderboard", "--inputs", input, "--out", out], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" }),
      /does not ship locked cases|suiteVisibility=private, but local suite .* is public/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
