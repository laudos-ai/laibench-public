import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComparableKey } from "./manifests.js";
import { assertSuiteRunIntegrity, buildLeaderboard, leaderboardToMarkdown } from "./leaderboard.js";
import type { CaseRunResult, Dim, DimSummary, SuiteRunResult, SubmissionValidation } from "./types.js";

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

// Build deterministic dimension summaries that are internally consistent with a
// uniform per-dim score. Integrity now requires real DimSummaries (FIX 2): an
// empty {} cannot be re-verified through the gated combiner, so fixtures that
// must PASS integrity supply concrete dims here.
function mkDims(score: number, verdict: "PASS" | "PARTIAL" | "FAIL", critFails = 0): Record<Dim, DimSummary> {
  const dims = {} as Record<Dim, DimSummary>;
  for (const dim of ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"] as Dim[]) {
    dims[dim] = {
      score,
      pass: verdict === "PASS" ? 1 : 0,
      total: 1,
      critFails: dim === "CRIT" ? critFails : 0,
      verdict,
      appliedWeight: 0,
    };
  }
  return dims;
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
    detDims: mkDims(overall, verdict),
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

// A case with a deterministic critical-finding MISS: a failed severity:'critical'
// check drives the gated combiner to overall 59.9 / verdict FAIL. The combined
// dims stay honest (CRIT capped low) so combinedOverall === 59.9 is itself
// truthful — only the verdict can be tampered.
function criticalMissResult(): CaseRunResult {
  const checks = [{
    dim: "CRIT" as Dim,
    id: "crit-missed",
    name: "no missed critical finding",
    severity: "critical" as const,
    passed: false,
    evidence: "missed acute hemorrhage",
  }];
  return {
    case: { id: "R001", exam: "tc cranio", findings: "hemorragia aguda", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: "",
    normalizedHtml: "",
    sanitizedHtml: "",
    meta: {
      modality: "CT",
      contrast: false,
      region: "head",
      normalizedExam: "tc cranio",
      normalizedFindings: "hemorragia aguda",
      abnormalStudy: true,
      expectedTitleTokens: [],
      expectedRegionTokens: [],
    },
    checks,
    detDims: mkDims(59.9, "FAIL", 1),
    detOverall: 59.9,
    judge: null,
    combined: { CRIT: 59.9, QUAL: 59.9, TERM: 59.9, GUIDE: 59.9, RAG: 59.9 },
    combinedOverall: 59.9,
    verdict: "FAIL",
    confidence: "low",
    phaseStatus: "degraded",
    gateReasons: ["deterministic critical failure"],
    costUsd: 0,
    latencyMs: 10,
    trace: [],
  };
}

// Wrap a single result into a complete, integrity-consistent run artifact.
function runWithResult(result: CaseRunResult): SuiteRunResult {
  const artifact = run("critical-miss-agent", true, 0, result.combinedOverall, {
    validation: {
      valid: true,
      expectedIds: [result.case.id],
      receivedIds: [result.case.id],
      missingIds: [],
      duplicateIds: [],
      extraIds: [],
      emptyOutputs: [],
      errors: [],
    },
  });
  artifact.results = [result];
  const nonFail = result.verdict !== "FAIL";
  const isPass = result.verdict === "PASS";
  artifact.summary = {
    accuracyRate: isPass ? 100 : 0,
    averageOverall: result.combinedOverall,
    passRate: nonFail ? 100 : 0,
    strictPassRate: isPass ? 100 : 0,
    averageLatencyMs: result.latencyMs,
    totalCostUsd: 0,
    verdictCounts: { PASS: isPass ? 1 : 0, PARTIAL: result.verdict === "PARTIAL" ? 1 : 0, FAIL: result.verdict === "FAIL" ? 1 : 0 },
    averagePerDim: { CRIT: result.combined.CRIT ?? 0, QUAL: result.combined.QUAL ?? 0, TERM: result.combined.TERM ?? 0, GUIDE: result.combined.GUIDE ?? 0, RAG: result.combined.RAG ?? 0 },
  };
  return artifact;
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

  it("accepts an honest critical-miss run (verdict FAIL, overall 59.9)", () => {
    // Sanity: the untampered critical-miss artifact must PASS integrity, so the
    // tamper test below proves the verdict re-derivation — not some unrelated
    // inconsistency — is what rejects the edited copy.
    const artifact = runWithResult(criticalMissResult());
    assert.doesNotThrow(() => assertSuiteRunIntegrity(artifact, "honest-critical-miss"));
  });

  it("rejects a verdict flipped FAIL->PASS while combinedOverall stays honest", () => {
    // The attacker leaves combinedOverall at the truthful 59.9 (so the overall
    // recompute passes) and edits ONLY the verdict to PASS. Re-deriving the
    // verdict through the gated combiner catches it.
    const artifact = runWithResult(criticalMissResult());
    artifact.results[0].verdict = "PASS";
    // Keep the summary self-consistent with the tampered verdict so the ONLY
    // surviving mismatch is the re-derived per-case verdict, proving FIX 1.
    artifact.summary.verdictCounts = { PASS: 1, PARTIAL: 0, FAIL: 0 };
    artifact.summary.passRate = 100;
    artifact.summary.strictPassRate = 100;
    artifact.summary.accuracyRate = 100;
    assert.throws(
      () => assertSuiteRunIntegrity(artifact, "verdict-tamper"),
      /verdict mismatch: expected FAIL, got PASS|verdict must be FAIL/,
    );
  });

  it("rejects a critical-finding miss whose verdict is anything but FAIL (hard veto)", () => {
    // Even if the gated re-derivation could be bypassed, the absolute critical
    // veto (failed critical check => FAIL) must reject a PARTIAL critical-miss.
    const artifact = runWithResult(criticalMissResult());
    artifact.results[0].verdict = "PARTIAL";
    artifact.summary.verdictCounts = { PASS: 0, PARTIAL: 1, FAIL: 0 };
    artifact.summary.passRate = 100;
    artifact.summary.strictPassRate = 0;
    artifact.summary.accuracyRate = 0;
    assert.throws(
      () => assertSuiteRunIntegrity(artifact, "critical-veto"),
      /verdict must be FAIL|verdict mismatch/,
    );
  });

  it("rejects a public artifact lacking deterministic dimension summaries", () => {
    // FIX 2: without real detDims the gated combiner cannot run, so the run is
    // unverifiable and must be rejected rather than validated against an ungated
    // mean (which would let a capped critical-miss masquerade as passing).
    const artifact = runWithResult(criticalMissResult());
    artifact.results[0].detDims = {} as never;
    assert.throws(
      () => assertSuiteRunIntegrity(artifact, "no-detdims"),
      /missing deterministic dimension summaries/,
    );
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
      /does not ship locked cases|suiteVisibility=private, but local suite .* is public|evaluationMode=cloud-private, but local suite .* is local/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
