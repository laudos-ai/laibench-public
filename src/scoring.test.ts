import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreDimensions, combineScores, scoreDimensionsWithEvaluators, judgeScoresAreLikert, DIMS, WEIGHTS } from "./scoring.js";
import { parseJudgeResponse } from "./judge.js";
import { extractFindings, extractClassifications, extractRecommendations, extractCriticalMentions, normalizeClassificationValue, isNegated } from "./extract.js";
import { evaluateGuidelines } from "./evaluators/guide.js";
import { evaluateQuality } from "./evaluators/qual.js";
import { evaluateCritical } from "./evaluators/crit.js";
import { evaluateRetrieval } from "./evaluators/rag.js";
import { runStructuralChecks } from "./evaluators/structural.js";
import { benchmarkCase } from "./benchmark.js";
import { bootstrapCI, mcNemarTest, cohensH } from "./stats.js";
import { deriveExamMeta } from "./classify.js";
import type { BenchCase, Check, Dim, DimSummary, EvaluatorResult, ExamMeta } from "./types.js";

// ---- Helper factories ----

function makeCheck(dim: Dim, id: string, passed: boolean, severity: Check["severity"] = "major"): Check {
  return { dim, id, name: `check-${id}`, severity, passed, evidence: passed ? "ok" : "fail" };
}

function makeMeta(overrides: Partial<ExamMeta> = {}): ExamMeta {
  return {
    modality: "CT",
    contrast: false,
    region: "head",
    normalizedExam: "ct head",
    normalizedFindings: "normal",
    abnormalStudy: false,
    expectedTitleTokens: ["computed", "tomography"],
    expectedRegionTokens: ["head"],
    ...overrides,
  };
}

function makeCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: "test-001",
    exam: "ct head non-contrast",
    findings: "normal",
    locale: "en-US",
    ...overrides,
  };
}

// ---- scoreDimensions tests ----

describe("scoreDimensions", () => {
  it("scores empty checks as all UNSCORED", () => {
    const { dims, overall } = scoreDimensions([]);
    for (const dim of DIMS) {
      assert.equal(dims[dim].score, null);
      assert.equal(dims[dim].verdict, "UNSCORED");
    }
    assert.equal(overall, 0);
  });

  it("scores all-passing checks as 100%", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", true),
      makeCheck("QUAL", "Q01", true),
      makeCheck("QUAL", "Q02", true),
    ];
    const { dims, overall } = scoreDimensions(checks);
    assert.equal(dims.CRIT.score, 100);
    assert.equal(dims.CRIT.verdict, "PASS");
    assert.equal(dims.QUAL.score, 100);
    assert.equal(dims.QUAL.verdict, "PASS");
    assert.ok(overall > 0);
  });

  it("caps score with critical failure", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", false, "critical"),
      makeCheck("CRIT", "C03", true),
    ];
    const { dims } = scoreDimensions(checks);
    assert.ok(dims.CRIT.score! <= 60, `expected <= 60, got ${dims.CRIT.score}`);
    assert.equal(dims.CRIT.verdict, "FAIL");
    assert.equal(dims.CRIT.critFails, 1);
  });

  it("caps score at 70 with 3+ major failures", () => {
    const checks: Check[] = [
      makeCheck("TERM", "T01", false, "major"),
      makeCheck("TERM", "T02", false, "major"),
      makeCheck("TERM", "T03", false, "major"),
      makeCheck("TERM", "T04", true),
      makeCheck("TERM", "T05", true),
      makeCheck("TERM", "T06", true),
      makeCheck("TERM", "T07", true),
    ];
    const { dims } = scoreDimensions(checks);
    assert.ok(dims.TERM.score! <= 70, `expected <= 70, got ${dims.TERM.score}`);
  });

  it("distributes weights across scored dimensions only", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("QUAL", "Q01", true),
    ];
    const { dims } = scoreDimensions(checks);
    // Only CRIT and QUAL are scored, so their weights should sum to 1
    const totalWeight = dims.CRIT.appliedWeight + dims.QUAL.appliedWeight;
    assert.ok(Math.abs(totalWeight - 1) < 0.01, `total weight should be ~1, got ${totalWeight}`);
  });

  it("marks PARTIAL for score >= 80 without critical failures", () => {
    const checks: Check[] = [
      makeCheck("GUIDE", "G01", true),
      makeCheck("GUIDE", "G02", true),
      makeCheck("GUIDE", "G03", true),
      makeCheck("GUIDE", "G04", true),
      makeCheck("GUIDE", "G05", false, "minor"),
    ];
    const { dims } = scoreDimensions(checks);
    // 4/5 = 80%, no critical failures, but pass !== total => PARTIAL
    assert.equal(dims.GUIDE.verdict, "PARTIAL");
    assert.equal(dims.GUIDE.score, 80);
  });
});

describe("deriveExamMeta", () => {
  it("treats source enhancement terms as contrast context even when the exam label omits contrast", () => {
    const meta = deriveExamMeta("rm crânio", "Lesão com impregnação homogênea pelo gadolínio.", "pt-BR");
    assert.equal(meta.contrast, true);
  });

  it("treats source contrastacao terms as contrast context for angiography cases", () => {
    const meta = deriveExamMeta(
      "TC ANGIO ARTERIAL INTRACRANIANA",
      "Durante a fase venosa, notam-se falhas de contrastação dos seios transverso e sigmóide.",
      "pt-BR",
    );
    assert.equal(meta.contrast, true);
  });
});

// ---- scoreDimensionsWithEvaluators tests ----

describe("scoreDimensionsWithEvaluators", () => {
  it("overrides dimension scores with evaluator results", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", false, "major"),
      makeCheck("QUAL", "Q01", true),
    ];
    const evaluatorResults: EvaluatorResult[] = [
      { dim: "CRIT", score: 90, checks: [makeCheck("CRIT", "CG01", true)], details: { mode: "gold-critical" } },
    ];
    const { dims } = scoreDimensionsWithEvaluators(checks, evaluatorResults);
    assert.equal(dims.CRIT.score, 90);
  });

  it("skips evaluator results with score < 0 (UNSCORED)", () => {
    const checks: Check[] = [
      makeCheck("RAG", "R01", true),
      makeCheck("RAG", "R02", true),
    ];
    const evaluatorResults: EvaluatorResult[] = [
      { dim: "RAG", score: -1, checks: [], details: { mode: "unscored" } },
    ];
    const { dims } = scoreDimensionsWithEvaluators(checks, evaluatorResults);
    assert.equal(dims.RAG.score, 100);
  });

  it("caps a critically-failing evaluator dimension (parity with scoreDimensions)", () => {
    // An evaluator emits a high numeric score despite a failed critical check.
    // Without the cap, averagePerDim and the conservative-min input would be
    // inflated even though the case is gated to FAIL elsewhere.
    const evaluatorResults: EvaluatorResult[] = [
      { dim: "CRIT", score: 88, checks: [makeCheck("CRIT", "CG01", false, "critical"), makeCheck("CRIT", "CG02", true)], details: { mode: "gold-critical" } },
    ];
    const { dims } = scoreDimensionsWithEvaluators([], evaluatorResults);
    assert.equal(dims.CRIT.verdict, "FAIL");
    assert.ok((dims.CRIT.score ?? 100) <= 60, `critical-failing dim must be capped, got ${dims.CRIT.score}`);
    // Matches the cap scoreDimensions applies for a single critical failure.
    assert.equal(dims.CRIT.score, 60);
  });

  it("does not cap a dimension whose critical checks all pass", () => {
    const evaluatorResults: EvaluatorResult[] = [
      { dim: "CRIT", score: 88, checks: [makeCheck("CRIT", "CG01", true, "critical")], details: { mode: "gold-critical" } },
    ];
    const { dims } = scoreDimensionsWithEvaluators([], evaluatorResults);
    assert.equal(dims.CRIT.score, 88);
  });
});

// ---- combineScores tests ----

describe("combineScores", () => {
  it("returns FAIL verdict for deterministic critical failure", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 9, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const critCheck = makeCheck("CRIT", "C01", false, "critical");
    const result = combineScores(detDims, null, [critCheck]);
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.overall, 59.9);
    assert.ok(result.gateReasons.includes("severity cap: critical failure"));
    assert.ok(result.gateReasons.includes("deterministic critical failure"));
  });

  it("returns degraded phaseStatus without judge", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const result = combineScores(detDims, null, []);
    assert.equal(result.phaseStatus, "degraded");
    assert.equal(result.verdict, "PASS");
    assert.equal(result.confidence, "medium");
    // Judge absence is reported via phaseStatus, never as a gate reason.
    assert.ok(!result.gateReasons.includes("adversarial phase unavailable"));
    assert.deepEqual(result.gateReasons, []);
  });

  it("combines judge scores by taking minimum of det and judge", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 80, pass: 8, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PARTIAL" as const,
      scores: { CRIT: 3 } as Partial<Record<Dim, number>>, // 3 * 20 = 60
      overall: 3,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, []);
    assert.equal(result.combined.CRIT, 60); // min(80, 60)
    assert.equal(result.phaseStatus, "complete");
  });

  it("does not let judge-primary lift deterministic FAIL dimensions into PASS band", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 62, pass: 6, total: 10, critFails: 0, verdict: "FAIL", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PASS" as const,
      scores: { CRIT: 92, QUAL: 88, TERM: 95, GUIDE: 84, RAG: 90 } as Partial<Record<Dim, number>>,
      overall: 90,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, [], undefined, "judge-primary");
    // judge-1 fix: clinical dims (CRIT/QUAL) are clamped to the deterministic
    // floor even in judge-primary mode, so the judge's CRIT=92/QUAL=88 cannot
    // overwrite the deterministic 62/FAIL. Non-clinical dims keep judge-primary
    // values (TERM=95, GUIDE=84, RAG=90).
    assert.equal(result.combined.CRIT, 62, "clinical CRIT clamped to det floor, not lifted by judge");
    assert.equal(result.combined.QUAL, 62, "clinical QUAL clamped to det floor, not lifted by judge");
    assert.equal(result.combined.TERM, 95, "non-clinical TERM keeps judge-primary value");
    assert.equal(result.overall, 74.7);
    assert.equal(result.verdict, "PARTIAL");
    assert.ok(result.overall < 84);
    assert.equal(result.phaseStatus, "complete");
  });

  it("uses judge-primary scores when deterministic dimensions are not failing", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 84, pass: 8, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PASS" as const,
      scores: { CRIT: 92, QUAL: 88, TERM: 95, GUIDE: 84, RAG: 90 } as Partial<Record<Dim, number>>,
      overall: 90,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, [], undefined, "judge-primary");
    // judge-1 fix: clinical dims (CRIT/QUAL) clamp to the deterministic floor
    // (84) — the judge cannot push them above what determinism supports — while
    // non-clinical dims keep judge-primary values. The case still PASSES.
    assert.equal(result.combined.CRIT, 84, "clinical CRIT clamped to det floor 84");
    assert.equal(result.combined.QUAL, 84, "clinical QUAL clamped to det floor 84");
    assert.equal(result.combined.TERM, 95, "non-clinical TERM keeps judge-primary value");
    assert.equal(result.overall, 86.8);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.phaseStatus, "complete");
  });

  it("keeps deterministic critical gates active in judge-primary mode", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 9, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PASS" as const,
      scores: { CRIT: 95, QUAL: 95, TERM: 95, GUIDE: 95, RAG: 95 } as Partial<Record<Dim, number>>,
      overall: 95,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, [makeCheck("CRIT", "unsafe", false, "critical")], undefined, "judge-primary");
    assert.equal(result.overall, 59.9);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.gateReasons.includes("deterministic critical failure"));
  });

  // judge-1: in judge-primary mode the RAW judge score used to overwrite the
  // deterministic clinical dimension, so a judge CRIT=100 buried a deterministic
  // CRIT=40/FAIL on the per-dimension leaderboard column. The clinical dims must
  // be clamped to the deterministic floor even in judge-primary mode.
  it("clamps clinical CRIT/QUAL to the deterministic floor in judge-primary mode (judge cannot bury a det FAIL)", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 9, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    // Deterministic CRIT is a hard FAIL at 40; deterministic QUAL is a weak 55.
    detDims.CRIT = { score: 40, pass: 4, total: 10, critFails: 1, verdict: "FAIL", appliedWeight: WEIGHTS.CRIT };
    detDims.QUAL = { score: 55, pass: 5, total: 10, critFails: 0, verdict: "FAIL", appliedWeight: WEIGHTS.QUAL };
    const judge = {
      verdict: "PASS" as const,
      // Judge tries to rescue the clinical dims to a perfect 100.
      scores: { CRIT: 100, QUAL: 100, TERM: 100, GUIDE: 100, RAG: 100 } as Partial<Record<Dim, number>>,
      overall: 100,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, [], undefined, "judge-primary");
    // Escape closed: clinical dims clamped to det floor, NOT the raw judge 100.
    assert.equal(result.combined.CRIT, 40, "CRIT must clamp to det floor 40, never the judge's 100");
    assert.equal(result.combined.QUAL, 55, "QUAL must clamp to det floor 55, never the judge's 100");
    // Backward compat: non-clinical dims still take the judge-primary value.
    assert.equal(result.combined.TERM, 100, "TERM keeps judge-primary value (backward compat)");
    assert.equal(result.combined.GUIDE, 100, "GUIDE keeps judge-primary value (backward compat)");
    assert.equal(result.combined.RAG, 100, "RAG keeps judge-primary value (backward compat)");
  });

  it("caps multiple major failures below PASS band using severe-failure weight", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 96, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const checks = [
      makeCheck("QUAL", "QG01", false, "major"),
      makeCheck("GUIDE", "GE01", false, "major"),
    ];

    const result = combineScores(detDims, null, checks);

    assert.equal(result.overall, 83.9);
    assert.equal(result.verdict, "PARTIAL");
    assert.ok(result.gateReasons.includes("severity cap: severe failure weight 4"));
  });

  it("caps adversarial critical failures below PARTIAL band", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "FAIL" as const,
      scores: { CRIT: 100, QUAL: 100, TERM: 100, GUIDE: 100, RAG: 100 } as Partial<Record<Dim, number>>,
      overall: 100,
      critical_failures: [{ dim: "CRIT" as Dim, issue: "missed critical", evidence: "judge" }],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };

    const result = combineScores(detDims, judge, []);

    assert.equal(result.overall, 59.9);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.gateReasons.includes("severity cap: critical failure"));
    assert.ok(result.gateReasons.includes("adversarial critical failure"));
  });

  it("does not let isolated formatting style failures become clinical gates", () => {
    const meta = makeMeta({
      modality: "CT",
      contrast: false,
      region: "unknown",
      normalizedExam: "ct synthetic",
      normalizedFindings: "synthetic observation",
      abnormalStudy: false,
      expectedTitleTokens: ["ct"],
      expectedRegionTokens: [],
    });
    const html = "<center><b>CT SYNTHETIC</b></center><br><br><b>Findings</b><br>Synthetic observation is unchanged with no additional abnormality in this controlled formatting fixture.<br><br><br>Additional descriptive sentence provides enough substantive content for the section.<br><br><b>Impression</b><br>Synthetic observation is unchanged.";
    const checks = runStructuralChecks(html, meta, "synthetic observation", "en-US");
    const styleChecks = checks.filter((check) => check.id === "Q03" || check.id === "Q04");
    assert.ok(styleChecks.length > 0);
    assert.ok(styleChecks.every((check) => check.severity === "minor"));
    assert.equal(styleChecks.some((check) => !check.passed), true);

    const det = scoreDimensions(checks);
    const combined = combineScores(det.dims, null, checks);
    assert.equal(combined.gateReasons.includes("deterministic critical failure"), false);
  });
});

describe("judge score scale (anti-inflation boundary)", () => {
  function dets(score: number): Record<Dim, DimSummary> {
    const d = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) d[dim] = { score, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    return d;
  }
  function judgeWith(scores: Partial<Record<Dim, number>>) {
    return { verdict: "PARTIAL" as const, scores, overall: 0, critical_failures: [], missing: [], hallucinated: [], spot_checks: [], fix: "" };
  }

  it("judgeScoresAreLikert is true only when every emitted dim is <= 5", () => {
    assert.equal(judgeScoresAreLikert([3, 4, 5]), true);
    assert.equal(judgeScoresAreLikert([3, 88]), false, "mixed magnitudes are not Likert");
    assert.equal(judgeScoresAreLikert([6]), false);
    assert.equal(judgeScoresAreLikert([]), false, "no scores is not Likert");
    assert.equal(judgeScoresAreLikert([undefined, null, 4]), true);
  });

  it("does NOT inflate a catastrophic 0-100 dimension when other dims are high", () => {
    // CRIT=3 is 3/100 (catastrophic), not 3/5. The old rule turned it into 60.
    const result = combineScores(dets(100), judgeWith({ CRIT: 3, QUAL: 88, TERM: 90, GUIDE: 85, RAG: 80 }), []);
    assert.equal(result.combined.CRIT, 3, "min(det=100, judge=3) must stay 3, never 60");
  });

  it("preserves the 0-5 Likert convention when every dim is <= 5", () => {
    const result = combineScores(dets(100), judgeWith({ CRIT: 4, QUAL: 4, TERM: 4, GUIDE: 4, RAG: 4 }), []);
    assert.equal(result.combined.CRIT, 80, "4/5 Likert -> 80 on a 0-100 scale");
  });

  it("holds the scale at the 0/1/5/6/100 boundaries", () => {
    // All-Likert results (every dim <= 5) scale by 20.
    assert.equal(combineScores(dets(100), judgeWith({ CRIT: 0, QUAL: 0, TERM: 0, GUIDE: 0, RAG: 0 }), []).combined.CRIT, 0);
    assert.equal(combineScores(dets(100), judgeWith({ CRIT: 1, QUAL: 1, TERM: 1, GUIDE: 1, RAG: 1 }), []).combined.CRIT, 20);
    assert.equal(combineScores(dets(100), judgeWith({ CRIT: 5, QUAL: 5, TERM: 5, GUIDE: 5, RAG: 5 }), []).combined.CRIT, 100);
    // Any dim > 5 means the result is read as a genuine 0-100 result.
    assert.equal(combineScores(dets(100), judgeWith({ CRIT: 6, QUAL: 6, TERM: 6, GUIDE: 6, RAG: 6 }), []).combined.CRIT, 6);
    assert.equal(combineScores(dets(100), judgeWith({ CRIT: 5, QUAL: 100, TERM: 100, GUIDE: 100, RAG: 100 }), []).combined.CRIT, 5);
    assert.equal(combineScores(dets(100), judgeWith({ CRIT: 100, QUAL: 100, TERM: 100, GUIDE: 100, RAG: 100 }), []).combined.CRIT, 100);
  });
});

// ---- Anti-HealthBench invariants ----
// These lock the properties that separate a gate-based safety benchmark from a
// weighted-mean rubric benchmark (HealthBench style): there is no prose or
// "communication quality" axis, substance failures are not compensable by form,
// and a single critical failure gates the case rather than being averaged away.

describe("anti-HealthBench invariants (no aesthetic score)", () => {
  it("exposes no communication/readability/prose scoring dimension", () => {
    assert.deepEqual(DIMS, ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"]);
    const aesthetic = (DIMS as string[]).filter((dim) => /comm|read|style|prose|tone|fluen|format/i.test(dim));
    assert.equal(aesthetic.length, 0, "no prose/communication-quality axis may exist");
  });

  it("a single critical failure gates below PASS even with every dimension at 100 (gate, not weighted mean)", () => {
    const dims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) dims[dim] = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    const result = combineScores(dims, null, [makeCheck("CRIT", "C01", false, "critical")]);
    // A HealthBench-style weighted mean would have returned ~100 here.
    assert.ok(result.overall <= 59.9, `expected gate, got ${result.overall}`);
    assert.equal(result.verdict, "FAIL");
  });

  it("a fluent, well-formatted report that OMITS a critical finding still FAILS (form never rescues substance)", async () => {
    const benchCase = makeCase({
      id: "anti-hb-omits-critical",
      exam: "ct head non-contrast",
      findings: "acute subdural hematoma. midline shift.",
      criticalFindings: ["subdural hematoma", "midline shift"],
    });
    // Long, fluent, perfectly structured prose that never states the critical findings.
    const html = "<center><b>CT OF THE HEAD WITHOUT CONTRAST</b></center><br><br><b>Technique</b><br>Helical non-contrast acquisition through the brain with high quality multiplanar reconstructions.<br><br><b>Findings</b><br>The ventricles and basal cisterns are normal in size and configuration. Gray-white matter differentiation is well preserved throughout both cerebral hemispheres. The visualized paranasal sinuses and mastoid air cells are clear and well aerated.<br><br><b>Impression</b><br>Unremarkable study of the brain with no acute intracranial abnormality.";
    const result = await benchmarkCase({ case: benchCase, locale: "en-US", providedHtml: html, providerLabel: "fixture", modelLabel: "fixture" });
    assert.equal(result.verdict, "FAIL", result.gateReasons.join("; "));
    assert.ok(result.gateReasons.some((reason) => /critical/i.test(reason)), result.gateReasons.join("; "));
  });

  it("a terse, ugly, telegraphic report that is clinically complete is NOT failed for its form (ugliness never punishes)", async () => {
    const benchCase = makeCase({
      id: "anti-hb-ugly-but-complete",
      exam: "ct head non-contrast",
      findings: "acute subdural hematoma. midline shift.",
      criticalFindings: ["subdural hematoma", "midline shift"],
    });
    // Ugly: no centering, no technique section, no fluent prose. Just the
    // required title, the findings, and the impression. Form is bare; substance
    // is complete.
    const html = "<b>CT HEAD NON-CONTRAST</b><br><b>Findings</b><br>acute subdural hematoma. midline shift 8mm.<br><b>Impression</b><br>acute subdural hematoma with midline shift.";
    const result = await benchmarkCase({ case: benchCase, locale: "en-US", providedHtml: html, providerLabel: "fixture", modelLabel: "fixture" });
    assert.notEqual(result.verdict, "FAIL", result.gateReasons.join("; "));
    assert.equal(result.gateReasons.some((reason) => /critical/i.test(reason)), false, result.gateReasons.join("; "));
  });
});

describe("structural-fallback severity weighting (no-gold path)", () => {
  it("ranks a lone minor aesthetic miss far above a critical content miss", () => {
    const benchCase = makeCase(); // no gold, no reference -> structural fallback
    const meta = makeMeta();
    const minorOnly = [makeCheck("QUAL", "Q03", false, "minor"), makeCheck("QUAL", "Q08", true, "critical"), makeCheck("QUAL", "Q11", true, "critical")];
    const critMiss = [makeCheck("QUAL", "Q03", true, "minor"), makeCheck("QUAL", "Q08", false, "critical"), makeCheck("QUAL", "Q11", true, "critical")];
    const minorScore = evaluateQuality("<b>Findings</b><br>Normal.", benchCase, "en-US", meta, minorOnly).score;
    const critScore = evaluateQuality("<b>Findings</b><br>Normal.", benchCase, "en-US", meta, critMiss).score;
    assert.ok(minorScore > critScore, `minor-only ${minorScore} must beat critical-miss ${critScore}`);
    assert.ok(minorScore >= 85, `a lone aesthetic miss should barely dent the score, got ${minorScore}`);
    assert.ok(critScore <= 60, `a critical content miss should tank the score, got ${critScore}`);
  });
});

describe("anti-compensation (form never rescues substance)", () => {
  function dimsAll(score: number): Record<Dim, DimSummary> {
    const d = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) d[dim] = { score, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    return d;
  }

  it("does not let perfect TERM/GUIDE lift a weak clinical dimension into PASS", () => {
    const dims = dimsAll(100);
    // QUAL is clinically weak (below PASS) but not a hard FAIL; every form/
    // coverage dimension is perfect. A weighted mean would clear PASS (~92).
    dims.QUAL = { score: 70, pass: 7, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS.QUAL };
    const r = combineScores(dims, null, []);
    assert.ok(r.overall < 84, `form must not lift weak QUAL into PASS, got ${r.overall}`);
    assert.equal(r.verdict, "PARTIAL");
    assert.ok(r.gateReasons.some((x) => /anti-compensation/.test(x)), r.gateReasons.join("; "));
  });

  it("caps when CRIT is below PASS even with everything else perfect", () => {
    const dims = dimsAll(100);
    dims.CRIT = { score: 80, pass: 8, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS.CRIT };
    const r = combineScores(dims, null, []);
    assert.ok(r.overall < 84, `got ${r.overall}`);
    assert.ok(r.gateReasons.some((x) => /anti-compensation: CRIT/.test(x)), r.gateReasons.join("; "));
  });

  it("still PASSES a clinically strong report when only a FORM dimension is weaker", () => {
    // CRIT and QUAL are both at/above PASS; TERM is the weak one. Form weakness
    // may lower the score but clinical strength is allowed to carry a PASS.
    const dims = dimsAll(95);
    dims.TERM = { score: 78, pass: 7, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS.TERM };
    const r = combineScores(dims, null, []);
    assert.equal(r.verdict, "PASS", `clinical strength should carry PASS; overall=${r.overall} reasons=${r.gateReasons.join("; ")}`);
    assert.equal(r.gateReasons.some((x) => /anti-compensation/.test(x)), false);
  });

  // scoring-core-4: an UNSCORED clinical dimension (score === null) is the
  // ABSENCE of clinical evidence, NOT proof of clinical adequacy. The old guard
  // (combined[dim] !== null) treated a null CRIT/QUAL as "not weak", so a report
  // with NO scored clinical signal reached PASS at 100 purely on form/coverage.
  function unscored(): DimSummary {
    return { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 };
  }

  it("does NOT grant PASS when BOTH clinical dims (CRIT and QUAL) are UNSCORED (form/coverage alone)", () => {
    // Form/coverage dims are perfect; both clinical dims are UNSCORED. Old
    // behavior: overall=100, PASS, no gate reason. New: capped below PASS.
    const dims = dimsAll(100);
    dims.CRIT = unscored();
    dims.QUAL = unscored();
    const r = combineScores(dims, null, []);
    assert.ok(r.overall < 84, `form/coverage alone must not reach PASS, got ${r.overall}`);
    assert.notEqual(r.verdict, "PASS");
    assert.ok(
      r.gateReasons.some((x) => /no scored clinical dimension/.test(x)),
      `expected the no-scored-clinical gate reason, got: ${r.gateReasons.join("; ")}`,
    );
  });

  it("does NOT grant PASS when both clinical dims are UNSCORED but other dims are 100 (the proven repro)", () => {
    // Mirror the audit repro: CRIT UNSCORED + TERM/GUIDE/RAG=100. With QUAL also
    // UNSCORED there is zero scored clinical evidence, so PASS is impossible.
    const dims = {} as Record<Dim, DimSummary>;
    dims.CRIT = unscored();
    dims.QUAL = unscored();
    dims.TERM = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS.TERM };
    dims.GUIDE = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS.GUIDE };
    dims.RAG = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS.RAG };
    const r = combineScores(dims, null, []);
    assert.ok(r.overall < 84, `got ${r.overall}`);
    assert.notEqual(r.verdict, "PASS");
    assert.ok(r.gateReasons.some((x) => /no scored clinical dimension/.test(x)), r.gateReasons.join("; "));
  });

  it("STILL grants PASS when at least ONE clinical dim is scored and strong (CRIT scored, QUAL UNSCORED)", () => {
    // A single scored clinical dimension that is strong is sufficient clinical
    // evidence: the no-scored-clinical gate must NOT fire, and the case PASSES.
    const dims = dimsAll(95);
    dims.CRIT = { score: 95, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS.CRIT };
    dims.QUAL = unscored();
    const r = combineScores(dims, null, []);
    assert.equal(r.verdict, "PASS", `one scored strong clinical dim should carry PASS; overall=${r.overall} reasons=${r.gateReasons.join("; ")}`);
    assert.equal(r.gateReasons.some((x) => /no scored clinical dimension/.test(x)), false);
  });

  it("STILL grants PASS when QUAL is scored and strong while CRIT is UNSCORED", () => {
    const dims = dimsAll(95);
    dims.CRIT = unscored();
    dims.QUAL = { score: 95, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS.QUAL };
    const r = combineScores(dims, null, []);
    assert.equal(r.verdict, "PASS", `overall=${r.overall} reasons=${r.gateReasons.join("; ")}`);
    assert.equal(r.gateReasons.some((x) => /no scored clinical dimension/.test(x)), false);
  });

  it("a single scored clinical dim that is WEAK still caps via anti-compensation (not the new gate)", () => {
    // CRIT scored but weak (below PASS), QUAL UNSCORED. There IS a scored clinical
    // dim, so the no-scored-clinical gate does not apply; the existing
    // anti-compensation cap handles the weak clinical dim instead.
    const dims = dimsAll(100);
    dims.CRIT = { score: 70, pass: 7, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS.CRIT };
    dims.QUAL = unscored();
    const r = combineScores(dims, null, []);
    assert.ok(r.overall < 84, `got ${r.overall}`);
    assert.ok(r.gateReasons.some((x) => /anti-compensation: CRIT/.test(x)), r.gateReasons.join("; "));
    assert.equal(r.gateReasons.some((x) => /no scored clinical dimension/.test(x)), false, "a scored clinical dim exists, so the new gate must not fire");
  });
});

describe("parseJudgeResponse", () => {
  it("accepts fine-grained 0-100 judge scores", () => {
    const result = parseJudgeResponse(JSON.stringify({
      verdict: "PASS",
      scores: { CRIT: 91, QUAL: 87, TERM: 96, GUIDE: 83, RAG: 89 },
      overall: 90,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    }));
    assert.equal(result?.scores.CRIT, 91);
    assert.equal(result?.scores.QUAL, 87);
    assert.equal(result?.overall, 90);
  });

  // FIX 1 (scoring-core-3): the parser must preserve RAW [0,100] values with NO
  // floor at 1 and NO per-value Likert rescale. The old branch routed any dim
  // <= 5 through clampScore (Math.max(1, Math.min(5, ...))), so a genuine 0 was
  // floored to 1 and a 0-5 value was kept on the Likert scale per-value, the
  // exact inflation scoring.ts rejected in favour of one per-RESULT decision.
  describe("FIX 1: raw value preservation (no per-value Likert / floor)", () => {
    it("preserves a genuine CRIT=0 (old behavior floored it to 1)", () => {
      const result = parseJudgeResponse(JSON.stringify({
        verdict: "FAIL",
        scores: { CRIT: 0, QUAL: 50, TERM: 60, GUIDE: 70, RAG: 80 },
        overall: 0,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      // Old per-value path: clampScore(0) => Math.max(1, 0) => 1. New: stays 0.
      assert.equal(result?.scores.CRIT, 0, "genuine 0 must NOT be floored to 1");
      assert.equal(result?.overall, 0, "genuine overall 0 must stay 0, not 1");
    });

    it("preserves a small raw 0-100 value (no per-value *20 or floor)", () => {
      const result = parseJudgeResponse(JSON.stringify({
        verdict: "FAIL",
        scores: { CRIT: 3, QUAL: 88, TERM: 90, GUIDE: 85, RAG: 80 },
        overall: 40,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      // The parser only validates; it must return the raw 3, never 60 (3*20) or 1.
      assert.equal(result?.scores.CRIT, 3, "raw 3 preserved verbatim by the parser");
    });

    it("combineScores owns scale: a parsed catastrophic CRIT=3 stays catastrophic", () => {
      const judge = parseJudgeResponse(JSON.stringify({
        verdict: "FAIL",
        scores: { CRIT: 3, QUAL: 88, TERM: 90, GUIDE: 85, RAG: 80 },
        overall: 40,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      const detDims = {} as Record<Dim, DimSummary>;
      for (const dim of DIMS) detDims[dim] = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
      const result = combineScores(detDims, judge, []);
      // Mixed magnitudes => NOT Likert => CRIT=3 is min(100, 3) = 3, never 60.
      assert.equal(result.combined.CRIT, 3, "parser+combineScores keep CRIT=3 catastrophic");
    });

    it("a genuine 1-5 Likert result parsed end-to-end still rescales by 20", () => {
      // The judge emits an all-<=5 Likert result. The parser preserves raw 1..4
      // and combineScores' judgeScoresAreLikert detects and rescales them.
      const judge = parseJudgeResponse(JSON.stringify({
        verdict: "PARTIAL",
        scores: { CRIT: 1, QUAL: 2, TERM: 3, GUIDE: 4, RAG: 5 },
        overall: 3,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      assert.equal(judge?.scores.CRIT, 1, "raw Likert 1 preserved (not floored, not rescaled in parser)");
      assert.equal(judgeScoresAreLikert(DIMS.map((dim) => judge?.scores?.[dim])), true, "all <=5 => Likert");
      const detDims = {} as Record<Dim, DimSummary>;
      for (const dim of DIMS) detDims[dim] = { score: 100, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
      const result = combineScores(detDims, judge, []);
      assert.equal(result.combined.CRIT, 20, "Likert 1 -> 20 via the single per-result decision");
      assert.equal(result.combined.RAG, 100, "Likert 5 -> 100");
    });
  });

  // FIX 2 (judge-2): JSON extraction must tolerate leading AND trailing prose by
  // brace-balance. The old /\{[\s\S]*\}$/ regex anchored the closing brace to
  // end-of-string, so any trailing text returned null and the judge was silently
  // dropped.
  describe("FIX 2: brace-balanced JSON extraction (trailing prose tolerant)", () => {
    const payload = {
      verdict: "PASS",
      scores: { CRIT: 91, QUAL: 87, TERM: 96, GUIDE: 83, RAG: 89 },
      overall: 90,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };

    it("parses an object followed by a trailing period (old regex returned null)", () => {
      const result = parseJudgeResponse(JSON.stringify(payload) + ".");
      assert.equal(result?.scores.CRIT, 91);
      assert.equal(result?.verdict, "PASS");
    });

    it("parses an object followed by a trailing note (old regex returned null)", () => {
      const result = parseJudgeResponse(JSON.stringify(payload) + "\n\nNote: evaluated against gold.");
      assert.equal(result?.scores.QUAL, 87);
    });

    it("parses a fenced block followed by trailing text (old regex returned null)", () => {
      const result = parseJudgeResponse("```json\n" + JSON.stringify(payload) + "\n```\nDone, see above.");
      assert.equal(result?.overall, 90);
      assert.equal(result?.scores.RAG, 89);
    });

    it("parses an object with leading prose before the first brace", () => {
      const result = parseJudgeResponse("Here is my verdict: " + JSON.stringify(payload));
      assert.equal(result?.scores.TERM, 96);
    });

    it("ignores braces inside string literals when balancing", () => {
      const result = parseJudgeResponse(JSON.stringify({ ...payload, fix: "add } and { to the report" }) + " end.");
      assert.equal(result?.scores.CRIT, 91);
      assert.equal(result?.fix, "add } and { to the report");
    });
  });

  // FIX 3 (judge-3): clearly out-of-range dimension values must be treated as
  // INVALID (dropped to null), never clamped into the favourable band. The old
  // clampScore100 turned 500 -> 100 and -50 -> 1, silently converting a
  // malformed/hallucinated value into a (near-)maximum score.
  describe("FIX 3: out-of-range values are dropped, not clamped to max", () => {
    it("drops CRIT=500 instead of clamping to 100", () => {
      const result = parseJudgeResponse(JSON.stringify({
        verdict: "PASS",
        scores: { CRIT: 500, QUAL: 87, TERM: 96, GUIDE: 83, RAG: 89 },
        overall: 90,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      assert.equal(result?.scores.CRIT, undefined, "out-of-range 500 must be dropped, never become 100");
      assert.equal(result?.scores.QUAL, 87, "valid dims are unaffected");
    });

    it("drops CRIT=-50 instead of clamping to 1/0", () => {
      const result = parseJudgeResponse(JSON.stringify({
        verdict: "FAIL",
        scores: { CRIT: -50, QUAL: 40, TERM: 50, GUIDE: 60, RAG: 70 },
        overall: 40,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      assert.equal(result?.scores.CRIT, undefined, "out-of-range -50 must be dropped, not clamped");
    });

    it("drops an out-of-range overall instead of clamping to 100", () => {
      const result = parseJudgeResponse(JSON.stringify({
        verdict: "PASS",
        scores: { CRIT: 91, QUAL: 87, TERM: 96, GUIDE: 83, RAG: 89 },
        overall: 250,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      assert.equal(result?.overall, null, "out-of-range overall must be dropped, never become 100");
    });

    it("keeps the boundary values 0 and 100 (inclusive range)", () => {
      const result = parseJudgeResponse(JSON.stringify({
        verdict: "PARTIAL",
        scores: { CRIT: 0, QUAL: 100, TERM: 50, GUIDE: 50, RAG: 50 },
        overall: 50,
        critical_failures: [],
        missing: [],
        hallucinated: [],
        spot_checks: [],
        fix: "",
      }));
      assert.equal(result?.scores.CRIT, 0, "0 is in range");
      assert.equal(result?.scores.QUAL, 100, "100 is in range");
    });
  });
});

// ---- Extraction tests ----

describe("extractFindings", () => {
  it("extracts findings from simple HTML", () => {
    const html = "<b>Findings</b><br>Moderate hepatic steatosis.<br>12mm gallbladder stone.<br>Right simple renal cyst 25mm.";
    const findings = extractFindings(html, "en-US");
    assert.ok(findings.length >= 2, `expected at least 2 findings, got ${findings.length}`);
  });

  it("detects laterality in findings", () => {
    const html = "<b>Findings</b><br>Left frontoparietal acute subdural hematoma measuring 15mm thickness.";
    const findings = extractFindings(html, "en-US");
    const hematomaFinding = findings.find((f) => /hematoma/i.test(f.text));
    assert.ok(hematomaFinding, "should find hematoma");
    assert.equal(hematomaFinding!.laterality, "left");
  });

  it("extracts measurements", () => {
    const html = "<b>Findings</b><br>Nodule measuring 18x12x15mm in right thyroid lobe.";
    const findings = extractFindings(html, "en-US");
    const nodule = findings.find((f) => /nodule/i.test(f.text));
    assert.ok(nodule, "should find nodule");
    assert.ok(nodule!.measurements.length > 0, "should have measurements");
  });

  it("classifies critical severity", () => {
    const html = "<b>Findings</b><br>Large left frontoparietal acute subdural hematoma with midline shift.";
    const findings = extractFindings(html, "en-US");
    const criticalFinding = findings.find((f) => /hematoma/i.test(f.text));
    assert.ok(criticalFinding, "should find hematoma");
    assert.equal(criticalFinding!.severity, "critical");
  });

  it("classifies minor severity", () => {
    const html = "<b>Findings</b><br>Simple renal cyst in the right kidney.";
    const findings = extractFindings(html, "en-US");
    const cystFinding = findings.find((f) => /cyst/i.test(f.text));
    assert.ok(cystFinding, "should find cyst");
    assert.equal(cystFinding!.severity, "minor");
  });

  it("sets negated field on negated findings (BUG G)", () => {
    const html = "<b>Findings</b><br>No evidence of pulmonary embolism.<br>Acute subdural hematoma.";
    const findings = extractFindings(html, "en-US");
    const negatedFinding = findings.find((f) => /embolism/i.test(f.text));
    assert.ok(negatedFinding, "should find embolism finding");
    assert.equal(negatedFinding!.negated, true, "negated finding should have negated=true");
    const affirmedFinding = findings.find((f) => /hematoma/i.test(f.text));
    assert.ok(affirmedFinding, "should find hematoma finding");
    assert.ok(!affirmedFinding!.negated, "affirmed finding should not have negated=true");
  });
});

describe("extractClassifications", () => {
  it("extracts BI-RADS classification", () => {
    const html = "Solid nodule BI-RADS 4A";
    const cls = extractClassifications(html);
    const birads = cls.find((c) => c.system === "birads");
    assert.ok(birads, "should find BI-RADS");
    assert.equal(birads!.normalizedValue, "4A");
  });

  it("extracts ACR BI-RADS with registered mark", () => {
    const html = "ACR BI-RADS®: 4";
    const cls = extractClassifications(html);
    const birads = cls.find((c) => c.system === "birads");
    assert.ok(birads, "should find BI-RADS with registered mark");
    assert.equal(birads!.normalizedValue, "4");
  });

  it("extracts TI-RADS classification", () => {
    const html = "ACR TI-RADS 5";
    const cls = extractClassifications(html);
    const tirads = cls.find((c) => c.system === "tirads");
    assert.ok(tirads, "should find TI-RADS");
    assert.equal(tirads!.normalizedValue, "5");
  });

  it("extracts PI-RADS classification", () => {
    const html = "Lesion classified as PI-RADS 4";
    const cls = extractClassifications(html);
    const pirads = cls.find((c) => c.system === "pirads");
    assert.ok(pirads, "should find PI-RADS");
    assert.equal(pirads!.normalizedValue, "4");
  });

  it("extracts Bosniak classification", () => {
    const html = "Complex cyst Bosniak IIF";
    const cls = extractClassifications(html);
    const bosniak = cls.find((c) => c.system === "bosniak");
    assert.ok(bosniak, "should find Bosniak");
  });

  it("extracts Lung-RADS classification", () => {
    const html = "Categorized as Lung-RADS 4B";
    const cls = extractClassifications(html);
    const lungrads = cls.find((c) => c.system === "lungrads");
    assert.ok(lungrads, "should find Lung-RADS");
    assert.equal(lungrads!.normalizedValue, "4B");
  });

  it("deduplicates by system+value", () => {
    const html = "BI-RADS 4A was confirmed. The finding is BI-RADS 4A.";
    const cls = extractClassifications(html);
    const birads = cls.filter((c) => c.system === "birads");
    assert.equal(birads.length, 1);
  });
});

describe("extractRecommendations", () => {
  it("detects follow-up recommendations", () => {
    const html = "Recommend follow-up in 6 months with ultrasound.";
    const recs = extractRecommendations(html, "en-US");
    assert.ok(recs.length > 0, "should find recommendation");
    assert.equal(recs[0].type, "follow-up");
    assert.ok(recs[0].timeframe, "should extract timeframe");
  });

  it("detects biopsy recommendations", () => {
    const html = "Biopsy recommended for further evaluation.";
    const recs = extractRecommendations(html, "en-US");
    assert.ok(recs.length > 0, "should find recommendation");
    assert.equal(recs[0].type, "biopsy");
  });

  it("detects Portuguese recommendations", () => {
    const html = "Sugerimos controle em 6 meses com ultrassonografia.";
    const recs = extractRecommendations(html, "pt-BR");
    assert.ok(recs.length > 0, "should find recommendation");
    assert.equal(recs[0].type, "follow-up");
  });
});

describe("extractCriticalMentions", () => {
  it("detects acute hemorrhage", () => {
    const html = "Acute subdural hematoma with midline shift.";
    const mentions = extractCriticalMentions(html, "en-US");
    assert.ok(mentions.length > 0, "should find critical mention");
    assert.ok(mentions.some((m) => m.category === "acute-bleed"), "should categorize as acute-bleed");
  });

  it("detects pulmonary embolism", () => {
    const html = "Filling defects consistent with acute pulmonary embolism.";
    const mentions = extractCriticalMentions(html, "en-US");
    assert.ok(mentions.some((m) => m.category === "pulmonary-embolism"), "should find PE");
  });

  it("detects pneumothorax", () => {
    const html = "Large left pneumothorax with mediastinal shift.";
    const mentions = extractCriticalMentions(html, "en-US");
    assert.ok(mentions.some((m) => m.category === "pneumothorax"), "should find pneumothorax");
  });

  it("deduplicates by category", () => {
    const html = "Subdural hematoma seen. Another hemorrhage noted.";
    const mentions = extractCriticalMentions(html, "en-US");
    const bleedCategories = mentions.filter((m) => m.category === "acute-bleed");
    assert.equal(bleedCategories.length, 1, "should deduplicate");
  });
});

describe("normalizeClassificationValue", () => {
  it("strips BI-RADS prefix", () => {
    assert.equal(normalizeClassificationValue("BI-RADS 4A"), "4A");
  });

  it("strips TI-RADS prefix", () => {
    assert.equal(normalizeClassificationValue("TI-RADS 5"), "5");
  });

  it("strips LI-RADS variants with spaces or compact prefixes", () => {
    assert.equal(normalizeClassificationValue("LI-RADS 3"), "3");
    assert.equal(normalizeClassificationValue("LIRADS-3"), "3");
  });

  it("normalizes case", () => {
    assert.equal(normalizeClassificationValue("bi-rads 4a"), "4A");
  });
});

// ---- Guideline evaluator tests ----

describe("evaluateGuidelines", () => {
  it("detects applicable guidelines from context", () => {
    const benchCase = makeCase({
      exam: "us thyroid",
      findings: "hypoechoic solid nodule in right thyroid lobe measuring 18x12x15mm",
    });
    const meta = makeMeta({ modality: "US", region: "unknown" });
    const html = "<b>Findings</b><br>Hypoechoic solid nodule in right thyroid lobe. ACR TI-RADS 5.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, []);
    assert.equal(result.dim, "GUIDE");
    assert.ok(result.score > 0 || result.checks.length > 0, "should have evaluated something");
  });

  it("validates gold guideline expectations", () => {
    const benchCase = makeCase({
      exam: "us thyroid",
      findings: "thyroid nodule",
      guidelineExpectations: [
        { guidelineId: "tirads", expectedClassification: "TI-RADS 5", recommendationRequired: true },
      ],
    });
    const meta = makeMeta({ modality: "US" });
    const html = "<b>Findings</b><br>Thyroid nodule ACR TI-RADS 5. Biopsy recommended.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, []);
    assert.ok(result.checks.some((c) => c.id.includes("tirads")), "should check TI-RADS");
  });

  it("fails omitted BI-RADS when breast context makes classification mandatory", () => {
    const benchCase = makeCase({
      exam: "MMG MAMOGRAFIA BILATERAL",
      findings: "Nódulo irregular espiculado na mama direita.",
      locale: "pt-BR",
    });
    const meta = makeMeta({ modality: "MG", region: "breast" });
    const html = "<b>Achados</b><br>Nódulo irregular espiculado na mama direita.<br><b>Conclusão</b><br>Nódulo suspeito na mama direita.";

    const result = evaluateGuidelines(html, benchCase, "pt-BR", meta, []);
    const presence = result.checks.find((c) => c.id === "GE-birads-presence");

    assert.equal(result.details.mode, "expected-guidelines");
    assert.equal(presence?.passed, false, "omitting mandatory BI-RADS should fail");
  });

  it("derives BI-RADS expectation from reference report", () => {
    const benchCase = makeCase({
      exam: "MMG MAMOGRAFIA BILATERAL",
      findings: "Nódulo irregular espiculado na mama direita.",
      locale: "pt-BR",
      referenceReport: "<b>Achados</b><br>Nódulo irregular espiculado na mama direita.<br><b>Conclusao</b><br>ACR BI-RADS®: 4",
    });
    const meta = makeMeta({ modality: "MG", region: "breast" });
    const html = "<b>Achados</b><br>Nódulo irregular espiculado na mama direita.<br><b>Conclusão</b><br>Nódulo suspeito na mama direita.";

    const result = evaluateGuidelines(html, benchCase, "pt-BR", meta, []);
    const presence = result.checks.find((c) => c.id === "GE-birads-presence");

    assert.equal((result.details.expectationSources as Record<string, string>).birads, "referenceReport");
    assert.equal(presence?.passed, false, "reference BI-RADS expectation should be enforced");
  });

  // qual-structural-guide-rag-1: naming the guideline acronym WITHOUT supplying
  // an actionable category ("classificação BI-RADS" with no number) used to leak
  // free points — presence passed and the correctness gate was silently dodged
  // because the module left result.correct null. A present-without-value report
  // must FAIL the correctness check, not pass silently.
  it("fails GE-correct when the guideline is named but no actionable category is supplied (present-without-value)", () => {
    const benchCase = makeCase({
      exam: "MMG MAMOGRAFIA BILATERAL",
      findings: "Nódulo irregular espiculado na mama direita.",
      locale: "pt-BR",
      guidelineExpectations: [
        { guidelineId: "birads", expectedClassification: "BI-RADS 4" },
      ],
    });
    const meta = makeMeta({ modality: "MG", region: "breast" });
    // The acronym is named but NO category/number is given.
    const html = "<b>Achados</b><br>Nódulo irregular espiculado na mama direita.<br><b>Conclusão</b><br>Recomenda-se classificação BI-RADS para o nódulo descrito.";

    const result = evaluateGuidelines(html, benchCase, "pt-BR", meta, []);
    const presence = result.checks.find((c) => c.id === "GE-birads-presence");
    const correct = result.checks.find((c) => c.id === "GE-birads-correct");

    // Presence may register (the acronym is named)...
    assert.equal(presence?.passed, true, "acronym is named so presence registers");
    // ...but the correctness gate must NOT be silently skipped — it must FAIL.
    assert.ok(correct, "GE-birads-correct must be emitted, not silently skipped");
    assert.equal(correct!.passed, false, "naming BI-RADS without a value must fail correctness");
    assert.equal(correct!.severity, "critical", "missing actionable category is a critical miss");
    assert.match(correct!.evidence, /no actionable category/i);
  });

  it("falls back to anatomy coverage when no guidelines apply", () => {
    const benchCase = makeCase({
      exam: "ct head non-contrast",
      findings: "normal",
    });
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("GUIDE", "G01", true),
      makeCheck("GUIDE", "G02", false),
    ];
    const html = "<b>Findings</b><br>Normal CT head.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, structuralChecks);
    assert.ok(result.details.mode === "anatomical-coverage-fallback" || result.details.mode === "auto-detect");
  });

  it("scopes anatomy coverage fallback to source/gold/reference context", () => {
    const benchCase = makeCase({
      exam: "tc cranio",
      locale: "pt-BR",
      findings: "Cisternas basais preservadas. Sem desvio da linha media.",
      referenceReport: "TC DE CRANIO. Cisternas basais preservadas. Sem desvio da linha media.",
    });
    const meta = makeMeta({ modality: "CT", region: "head", normalizedExam: "tc cranio" });
    const structuralChecks = [
      { dim: "GUIDE", id: "G01", name: "Anatomical coverage: ventricul", severity: "major", passed: false, evidence: "missing: ventricul" },
      { dim: "GUIDE", id: "G02", name: "Anatomical coverage: cisternas", severity: "major", passed: true, evidence: "ok" },
      { dim: "GUIDE", id: "G03", name: "Anatomical coverage: orbit", severity: "major", passed: false, evidence: "missing: orbit" },
    ] satisfies Check[];

    const result = evaluateGuidelines("<b>Achados</b><br>Cisternas basais preservadas.", benchCase, "pt-BR", meta, structuralChecks);

    assert.deepEqual(result.checks.map((c) => c.id), ["G02"]);
    assert.equal(result.score, 100);
    assert.deepEqual(result.details.scopedCoverage, { retained: 1, total: 3 });
  });

  it("scores anatomy coverage fallback with weighted checks and no artificial floor", () => {
    const benchCase = makeCase({
      exam: "tc torax",
      locale: "pt-BR",
      findings: "Mediastino, hilos pulmonares, pleuras e parenquima pulmonar descritos.",
      referenceReport: "Mediastino, hilos pulmonares, pleuras e parenquima pulmonar descritos.",
    });
    const meta = makeMeta({ modality: "CT", region: "chest", normalizedExam: "tc torax" });
    const structuralChecks = [
      { dim: "GUIDE", id: "G01", name: "Anatomical coverage: mediastino", severity: "major", passed: false, evidence: "missing: mediastino" },
      { dim: "GUIDE", id: "G02", name: "Anatomical coverage: hilos", severity: "major", passed: false, evidence: "missing: hilos" },
      { dim: "GUIDE", id: "G03", name: "Anatomical coverage: pleuras", severity: "major", passed: false, evidence: "missing: pleuras" },
      { dim: "GUIDE", id: "G04", name: "Anatomical coverage: parenquima", severity: "major", passed: true, evidence: "ok" },
    ] satisfies Check[];

    const result = evaluateGuidelines("<b>Achados</b><br>Parenquima pulmonar sem opacidades.", benchCase, "pt-BR", meta, structuralChecks);

    assert.equal(result.details.mode, "anatomical-coverage-fallback");
    assert.equal(result.score, 25);
  });

  it("does not require PI-RADS for a rectal pelvis MRI just because the generated report mentions prostate", () => {
    const benchCase = makeCase({
      exam: "rm pelve",
      locale: "pt-BR",
      findings: "Lesão expansiva anular no reto, distando 5,5cm da borda anal, para estadiamento de câncer de reto.",
    });
    const meta = makeMeta({ modality: "MRI", region: "pelvis", normalizedExam: "rm pelve" });
    const html = "<b>Análise</b><br>Lesão anular no reto. Próstata e demais estruturas pélvicas sem invasão.";

    const result = evaluateGuidelines(html, benchCase, "pt-BR", meta, []);
    assert.equal(result.checks.some((c) => c.id.includes("pirads")), false, "rectal MRI should not trigger PI-RADS");

    const structural = runStructuralChecks(html, meta, benchCase.findings, "pt-BR");
    assert.equal(structural.some((c) => c.id === "TC06"), false, "TERM should not require PI-RADS from output-only prostate text");
  });

  it("does not require inferred guideline classification without a mandatory clinical trigger", () => {
    const benchCase = makeCase({
      exam: "RM PELVE",
      locale: "pt-BR",
      findings: "Próstata de contornos regulares. Pequeno hemangioma hepático típico.",
    });
    const meta = makeMeta({ modality: "MRI", region: "pelvis", normalizedExam: "rm pelve" });
    const html = "<b>Achados</b><br>Próstata de contornos regulares. Pequeno hemangioma hepático típico.<br><b>Conclusao</b><br>Hemangioma hepático.";

    const result = evaluateGuidelines(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.checks.some((c) => /pirads|lirads|bosniak/i.test(c.id)), false);
    assert.equal(result.score, 100);
  });

  it("accepts defecografia as the title for an RX defecograma case", () => {
    const meta = deriveExamMeta("rx defecograma", "Incontinência às manobras de Valsalva.", "pt-BR");
    const html = "<center><b>DEFECOGRAFIA</b></center><br><br><b>Técnica:</b><br>Estudo radiográfico dinâmico.<br><br><b>Análise:</b><br>Incontinência às manobras de Valsalva.<br><br><b>Conclusão:</b><br>Incontinência às manobras de Valsalva.";

    const structural = runStructuralChecks(html, meta, "Incontinência às manobras de Valsalva.", "pt-BR");
    const titleCheck = structural.find((c) => c.id === "R01");
    assert.equal(titleCheck?.passed, true, titleCheck?.evidence);
  });

  it("accepts intracraniana as a head-region title token", () => {
    const findings = "Artérias intracranianas com calibre preservado. Área hemorrágica no lobo temporal direito.";
    const meta = deriveExamMeta("TC ANGIO ARTERIAL INTRACRANIANA", findings, "pt-BR");
    const html = "<center><b>TC ANGIO ARTERIAL INTRACRANIANA</b></center><br><br><b>Achados</b><br>Artérias intracranianas com calibre preservado.<br><br><b>Conclusao</b><br>Achados intracranianos descritos.";

    const structural = runStructuralChecks(html, meta, findings, "pt-BR");
    const titleCheck = structural.find((c) => c.id === "R01");
    assert.equal(titleCheck?.passed, true, titleCheck?.evidence);
  });

  it("accepts a plain text leading title before the first section label", () => {
    const findings = "Rins com sinais de nefropatia cronica bilateral.";
    const meta = deriveExamMeta("USG ABDOME TOTAL", findings, "pt-BR");
    const html = "ULTRASSONOGRAFIA DO ABDOME TOTAL<br><b>Análise:</b><br>Rins com sinais de nefropatia cronica bilateral.<br><b>Conclusão:</b><br>Nefropatia cronica bilateral.";

    const structural = runStructuralChecks(html, meta, findings, "pt-BR");
    const titleCheck = structural.find((c) => c.id === "R01");
    assert.equal(titleCheck?.passed, true, titleCheck?.evidence);
  });

  it("does not penalize valid ultrasound acoustic attenuation terminology", () => {
    const findings = "Esteatose hepatica com atenuação do feixe acústico.";
    const meta = deriveExamMeta("USG ABDOME TOTAL", findings, "pt-BR");
    const html = "<center><b>ULTRASSONOGRAFIA DO ABDOME TOTAL</b></center><br><b>Análise:</b><br>Parênquima hepático com ecogenicidade aumentada e atenuação do feixe acústico.<br><b>Conclusão:</b><br>Esteatose hepática.";

    const structural = runStructuralChecks(html, meta, findings, "pt-BR");
    const modalityCheck = structural.find((c) => c.id === "TM1");
    assert.equal(modalityCheck?.passed, true, modalityCheck?.evidence);
  });
});

// ---- Quality evaluator tests ----

describe("evaluateQuality", () => {
  it("uses gold findings when available", () => {
    const benchCase = makeCase({
      findings: "moderate hepatic steatosis. 12mm gallbladder stone",
      goldFindings: [
        { finding: "hepatic steatosis", severity: "minor" },
        { finding: "gallbladder stone", severity: "minor", measurements: ["12mm"] },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    const html = "<b>Findings</b><br>Moderate hepatic steatosis. Gallbladder stone measuring 12mm.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-findings");
    assert.ok(result.score >= 50, `expected >= 50, got ${result.score}`);
  });

  it("uses reference report when available", () => {
    const benchCase = makeCase({
      findings: "normal",
      referenceReport: "<b>Findings</b><br>Normal head CT. No acute abnormality.<br><b>Impression</b><br>Normal.",
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Normal head CT. No acute abnormality.<br><b>Impression</b><br>Normal.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "reference-comparison");
    assert.ok(result.score > 0);
  });

  it("falls back to structural checks", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("QUAL", "Q01", true),
      makeCheck("QUAL", "Q02", true),
    ];
    const html = "<b>Findings</b><br>Normal.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
  });

  it("matches Portuguese laterality inflections for transplant-kidney context", () => {
    const benchCase = makeCase({
      locale: "pt-BR",
      findings: "Rim transplantado na esquerda, com dimensões normais e contornos regulares. Parênquima de espessura normal.",
      goldFindings: [
        { finding: "Rim transplantado na esquerda", location: "rim", laterality: "left", severity: "incidental" },
        { finding: "dimensões normais", location: "rim transplantado", laterality: "left", severity: "incidental" },
        { finding: "Parênquima de espessura normal", location: "parênquima do rim transplantado", laterality: "left", severity: "incidental" },
      ],
    });
    const meta = makeMeta({ modality: "US", region: "urinary" });
    const html = "<b>Análise</b><br>Rim transplantado em fossa ilíaca esquerda, com dimensões preservadas.<br>Parênquima renal de espessura preservada.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const laterality = result.checks.find((c) => c.id === "QG05");
    assert.equal(laterality?.passed, true, laterality?.evidence);
    assert.equal(laterality?.severity, "major", "incidental laterality checks should not force a critical failure");
  });

  it("matches right and left Portuguese renal measurements", () => {
    const benchCase = makeCase({
      locale: "pt-BR",
      findings: "Rim direito mede 12,42 cm. Rim esquerdo mede 12,44 cm.",
      goldFindings: [
        { finding: "Rim direito mede 12,42 cm", location: "rim", laterality: "right", severity: "incidental", measurements: ["12,42 cm"] },
        { finding: "Rim esquerdo mede 12,44 cm", location: "rim", laterality: "left", severity: "incidental", measurements: ["12,44 cm"] },
      ],
    });
    const meta = makeMeta({ modality: "US", region: "urinary" });
    const html = "<b>Análise</b><br>Rim direito medindo 12,42 cm.<br>Rim esquerdo medindo 12,44 cm.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const laterality = result.checks.find((c) => c.id === "QG05");
    assert.equal(laterality?.passed, true, laterality?.evidence);
  });

  it("does not gate expected-report recommendations as mandatory findings", () => {
    const benchCase = makeCase({
      id: "MERGED-PTBR-041",
      locale: "pt-BR",
      findings: "Espessamento e realce do revestimento das paredes do seio piriforme e da prega ariepiglótica à esquerda, com obliteração parcial da valécula esquerda. Linfonodomegalia no nível III esquerdo medindo 1,2 x 1,1 cm. Pólipo / cisto de retenção no seio esfenoidal esquerdo. Sinais de apicopatia do 2º molar inferior esquerdo.",
      goldFindings: [
        { finding: "Espessamento com realce na laringe supraglótica e hipofaringe, à esquerda", severity: "major", laterality: "left" },
        { finding: "Linfonodomegalia à esquerda", severity: "minor", laterality: "left" },
        { finding: "Sugere-se correlação endoscópica ( faringo e laringoscopia)", severity: "minor" },
        { finding: "Deve-se considerar a hipótese de processo granulomatoso faringolaríngeo, não se podendo afastar lesão neoplasica", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "neck", normalizedExam: "tc pescoco" });
    const html = "<b>Análise</b><br>Espessamento e realce supraglótico/hipofaríngeo à esquerda. Linfonodomegalia cervical esquerda. Pólipo/cisto de retenção esfenoidal esquerdo.<br><b>Conclusão</b><br>Espessamento mucoso supraglótico/hipofaríngeo, predominante à esquerda. Linfonodomegalia cervical esquerda.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg01 = result.checks.find((c) => c.id === "QG01");
    const qg02 = result.checks.find((c) => c.id === "QG02");

    assert.equal(qg01?.passed, true, qg01?.evidence);
    assert.equal(qg02, undefined, "optional recommendations/differentials must not create a critical miss");
    assert.deepEqual(result.details.unscoredGoldFindings, [
      "Sugere-se correlação endoscópica ( faringo e laringoscopia)",
      "Deve-se considerar a hipótese de processo granulomatoso faringolaríngeo, não se podendo afastar lesão neoplasica",
    ]);
  });

  it("credits clinically preserved critical impressions without exact gold phrasing", () => {
    const benchCase = makeCase({
      id: "MERGED-PTBR-044",
      locale: "pt-BR",
      findings: "Coleção de conteúdo hipoatenuante, com paredes espessas e com realce periférico ao meio de contraste, localizada no subcutâneo da região glútea direita.",
      goldFindings: [
        { finding: "Esses achados de imagem sugerem abscesso glúteo à direita", severity: "critical", laterality: "right" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "pelvis", normalizedExam: "tc bacia" });
    const html = "<b>Análise</b><br>Coleção subcutânea na região glútea direita, com paredes espessas e realce periférico.<br><b>Conclusão</b><br>Coleção subcutânea na região glútea direita, com aspecto tomográfico compatível com abscesso.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg01 = result.checks.find((c) => c.id === "QG01");
    const qg02 = result.checks.find((c) => c.id === "QG02");

    assert.equal(qg01?.passed, true, qg01?.evidence);
    assert.equal(qg02, undefined, "abscess is clinically present and should not be a critical miss");
  });

  it("credits comparison/evolution findings when the expected trend is preserved", () => {
    const benchCase = makeCase({
      id: "MERGED-PTBR-013",
      locale: "pt-BR",
      findings: "Lesão cística multiloculada com calcificações periféricas no espaço hepatorrenal, compatível com implante peritoneal, medindo 7,0cm, estável em relação ao exame de 18/05/2016 e maior quando comparado ao estudo de janeiro/2012, em que media 5,0cm.",
      goldFindings: [
        { finding: "Em relação ao estudo de 18/05/2016, não se observam alterações evolutivas significativas", severity: "minor" },
        { finding: "Em relação aos estudos mais antigos, torna-se perceptível aumento das dimensões da lesão no espaço hepatorrenal, o que sugere crescimento lento, compatível com implante peritoneal", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "pelvis", normalizedExam: "tc pelve" });
    const html = "<b>Análise</b><br>Lesão cística multiloculada com calcificações periféricas no espaço hepatorrenal, compatível com implante peritoneal, medindo 7,0 cm, estável em relação ao exame de 18/05/2016 e maior quando comparada ao estudo de janeiro de 2012, quando media 5,0 cm.<br><b>Conclusão</b><br>Implante peritoneal cístico multiloculado no espaço hepatorrenal, estável em relação ao controle de 18/05/2016 e maior em comparação a janeiro de 2012.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg01 = result.checks.find((c) => c.id === "QG01");
    const qg06 = result.checks.find((c) => c.id === "QG06");

    assert.equal(qg01?.passed, true, qg01?.evidence);
    assert.equal(qg06?.passed, true, qg06?.evidence);
  });

  // negation-matching-2: an affirmed compound critical gold that embeds an
  // unrelated pertinent negative ("acute subdural hematoma, no midline shift")
  // must keep gold polarity = AFFIRMED. The OLD whole-text hasNegationCue on the
  // gold finding wrongly set goldNegated=true (because of "no midline shift"),
  // which let a report that NEGATES the critical concord/match it — a dangerous
  // negation slipping through as a detected critical. With clause-scoped gold
  // polarity, a report negating the critical is now correctly a MISS (QG02 fails).
  it("does not let a report negating a compound affirmed critical match it (embedded pertinent negative)", () => {
    const benchCase = makeCase({
      findings: "Acute subdural hematoma along the left convexity, no midline shift.",
      goldFindings: [
        { finding: "acute subdural hematoma, no midline shift", severity: "critical" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "head", abnormalStudy: true });
    // Report DENIES the critical.
    const html = "<b>Findings</b><br>No acute subdural hematoma. No midline shift.<br><b>Impression</b><br>No acute intracranial abnormality.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    const qg02 = result.checks.find((c) => c.id === "QG02");
    assert.ok(qg02, "QG02 must be emitted: a critical was missed (negated by the report)");
    assert.equal(qg02!.passed, false, JSON.stringify(result.details.findingMatches));
    assert.equal(result.score, 0, "negating an affirmed critical must floor QUAL to 0");
  });

  // qual-compound-polarity (re-verify, OPEN -> closed): the embedded-pertinent-
  // negative fix to polarityConcordant was necessary but NOT sufficient. The
  // residual escape was upstream in matchFindings: when the compound gold's
  // negative tokens ("...no midline shift") diluted the FULL-gold token ratio
  // below 0.5, bestSentenceForTokens returned null and the code fell back to
  // `?? gold.finding`, so polarityConcordant compared the affirmed gold to
  // ITSELF and a NEGATING report was scored as a concordant exact match. This
  // report omits "acute" and scatters the negatives across sentences so that no
  // single sentence clears 0.5 on the full gold tokens. reportPolarityCandidate
  // now scopes selection to the gold's PRIMARY-clause tokens (so "No subdural
  // hematoma" -> 0.667) and never falls back to the gold text.
  it("catches a multi-sentence negation that diluted the full-gold token ratio below threshold (no gold-text fallback)", () => {
    const benchCase = makeCase({
      findings: "Acute subdural hematoma along the left convexity, no midline shift.",
      goldFindings: [
        { finding: "acute subdural hematoma, no midline shift", severity: "critical" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "head", abnormalStudy: true });
    // Report DENIES the critical, WITHOUT the word "acute", negatives split across
    // sentences -> full-gold token ratio in any single sentence is < 0.5 (the old
    // null -> `?? gold.finding` fallback path).
    const html = "<b>Findings</b><br>No subdural hematoma; no midline shift.<br><b>Impression</b><br>No acute intracranial abnormality.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    const qg02 = result.checks.find((c) => c.id === "QG02");
    assert.ok(qg02, "QG02 must be emitted: the affirmed critical was denied by the report");
    assert.equal(qg02!.passed, false, JSON.stringify(result.details.findingMatches));
    assert.equal(result.score, 0, "a report denying the affirmed critical must floor QUAL to 0, not score a concordant match");
  });

  it("still treats a genuinely negated critical gold as negated (no opposite-direction regression)", () => {
    // Gold whose PRIMARY clause is the negation: report must also negate to match.
    const benchCase = makeCase({
      findings: "No acute hemorrhage. Old lacunar infarcts.",
      goldFindings: [
        { finding: "No acute hemorrhage", severity: "critical", negated: true },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "head" });
    const html = "<b>Findings</b><br>No acute intracranial hemorrhage. Chronic lacunar infarcts.<br><b>Impression</b><br>No acute hemorrhage.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    const matches = result.details.findingMatches as Array<{ matchType: string }>;
    assert.ok(matches.length > 0, "the negated gold should still be scored as a finding match");
    assert.ok(matches.every((m) => m.matchType !== "missed"), "report concordantly negates the gold -> not a miss");
  });
});

// ---- Critical evaluator tests ----

describe("evaluateCritical", () => {
  it("computes recall/precision with gold labels", () => {
    const benchCase = makeCase({
      findings: "acute subdural hematoma. midline shift",
      criticalFindings: ["subdural hematoma", "midline shift"],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Left frontoparietal acute subdural hematoma. 8mm midline shift.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");
    assert.ok(typeof result.details.recall === "number");
    assert.ok(typeof result.details.precision === "number");
  });

  it("penalizes missed critical findings", () => {
    const benchCase = makeCase({
      findings: "acute subdural hematoma. midline shift. pneumothorax",
      criticalFindings: ["subdural hematoma", "midline shift", "pneumothorax"],
    });
    const meta = makeMeta();
    // Report only mentions hematoma, missing midline shift and pneumothorax
    const html = "<b>Findings</b><br>Left subdural hematoma.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    const recall = result.details.recall as number;
    assert.ok(recall < 1, `recall should be < 1 when findings are missed, got ${recall}`);
  });

  it("falls back to structural checks without gold", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", true),
    ];
    const html = "<b>Findings</b><br>Normal.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
  });

  it("derives critical labels from goldFindings when criticalFindings is absent", () => {
    const benchCase = makeCase({
      findings: "segmental pulmonary embolism",
      goldFindings: [
        { finding: "pulmonary embolism", severity: "critical" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "chest" });
    const html = "<b>Findings</b><br>Acute pulmonary embolism in a segmental artery.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");
    assert.equal(result.details.source, "goldFindings");
    assert.equal(result.checks.find((check) => check.id === "CG01")?.passed, true);
  });

  it("does not fall back to structural CRIT when goldFindings contain no critical severity", () => {
    const benchCase = makeCase({
      findings: "12 mm gallstone",
      goldFindings: [
        { finding: "gallstone", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    const structuralChecks = [
      makeCheck("CRIT", "C07", false, "critical"),
    ];
    const html = "<b>Findings</b><br>Gallstone.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "gold-critical-none");
    assert.equal(result.score, 100);
    assert.equal(result.checks.some((check) => check.id === "C07"), false);
  });

  it("credits venous thrombosis/hemorrhagic venous infarct without boilerplate gold wording", () => {
    const benchCase = makeCase({
      id: "MERGED-PTBR-043",
      locale: "pt-BR",
      criticalFindings: [
        "Esses achados de imagem sugerem infarto venoso hemorrágico, às custas de trombose venosa cerebral",
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "head", normalizedExam: "tc angio arterial intracraniana" });
    const html = "<b>Conclusão</b><br>Trombose venosa dural direita, envolvendo os seios transverso e sigmoide, com extensão ao segmento superior da veia jugular interna. Hemorragia intraparenquimatosa temporal direita, compatível com infarto venoso hemorrágico.";

    const result = evaluateCritical(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.details.recall, 1);
    assert.equal(result.checks.some((c) => c.id.startsWith("CG02-")), false);
  });

  it("credits a source-backed cervical mass with cord compression even if etiology wording differs", () => {
    const benchCase = makeCase({
      id: "MERGED-PTBR-049",
      locale: "pt-BR",
      criticalFindings: [
        "Processo expansivo vértebro-cervical, cujas características sugerem natureza relacionada à bainha neural",
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "neck", normalizedExam: "tc pescoco" });
    const html = "<b>Conclusão</b><br>Volumosa massa sólida cervical esquerda, centrada no nível III, com extensão foraminal e intracanal vertebral, determinando compressão e desvio medular. Remodelamento ósseo associado em C5 e C6, com expansão dos forames neural e vertebral esquerdos.";

    const result = evaluateCritical(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.details.recall, 1);
    assert.equal(result.checks.some((c) => c.id.startsWith("CG02-")), false);
  });
});

// ---- Retrieval evaluator tests ----

describe("evaluateRetrieval", () => {
  it("computes IR metrics with gold and retrieved docs", () => {
    const benchCase = makeCase({
      retrievalGold: [
        { documentId: "doc1", relevance: 3 },
        { documentId: "doc2", relevance: 2 },
        { documentId: "doc3", relevance: 1 },
        { documentId: "doc4", relevance: 0 },
      ],
    });
    const meta = makeMeta();
    const html = "";
    const retrievedDocIds = ["doc1", "doc3", "doc4", "doc2"];

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, [], retrievedDocIds);
    assert.equal(result.details.mode, "retrieval-evaluation");
    assert.ok(typeof result.details.mrr === "number");
    assert.ok(typeof result.details.ndcg === "number");
    assert.ok(result.score > 0);
  });

  it("returns UNSCORED without gold data and structural checks", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const html = "";

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, []);
    assert.equal(result.score, -1);
  });

  it("falls back to structural RAG checks without gold data", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("RAG", "R01", true),
      makeCheck("RAG", "R02", true),
    ];
    const html = "";

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
    assert.equal(result.score, 100);
  });

  it("excludes hardcoded preservation R05 from structural RAG fallback", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("RAG", "R01", true),
      makeCheck("RAG", "R05", false, "critical"),
      makeCheck("RAG", "R06", true),
    ];
    const html = "";

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
    assert.equal(result.checks.some((check) => check.id === "R05"), false);
    assert.equal(result.score, 100);
  });
});

describe("Gold scoring ignores locale preservation-pattern gates", () => {
  it("does not fail a rich-gold case solely because C07 misses a non-listed synonym", async () => {
    const benchCase = makeCase({
      id: "pt-gold-synonym",
      locale: "pt-BR",
      exam: "US ABDOMEN",
      findings: "Cálculo na vesícula.",
      goldFindings: [
        { finding: "Colelitíase", severity: "major" },
      ],
    });
    const html = "<center><b>ULTRASSONOGRAFIA ABDOMEN</b></center><br><br><b>Análise</b><br>Colelitíase.<br><br><b>Conclusão</b><br>Colelitíase.";

    const result = await benchmarkCase({
      case: benchCase,
      locale: "pt-BR",
      providedHtml: html,
      providerLabel: "fixture",
      modelLabel: "fixture",
    });

    assert.equal(result.checks.some((check) => check.id === "C07"), false);
    assert.equal(
      result.gateReasons.some((reason) => /deterministic critical failure/i.test(reason)),
      false,
      result.gateReasons.join("; "),
    );
    assert.notEqual(result.verdict, "FAIL");
  });
});

// ---- BUG FIX REGRESSION TESTS ----

describe("BUG 1: Negated critical findings not counted as detected", () => {
  it("does NOT detect PE when negated in English", () => {
    const html = "No evidence of pulmonary embolism. Normal chest CT.";
    const mentions = extractCriticalMentions(html, "en-US");
    const pe = mentions.find((m) => m.category === "pulmonary-embolism");
    assert.equal(pe, undefined, "negated PE should NOT be detected");
  });

  it("does NOT detect PE when negated in Portuguese", () => {
    const html = "Sem evidencia de tromboembolismo pulmonar. Exame normal.";
    const mentions = extractCriticalMentions(html, "pt-BR");
    const pe = mentions.find((m) => m.category === "pulmonary-embolism");
    assert.equal(pe, undefined, "negated TEP should NOT be detected");
  });

  it("still detects PE when affirmed", () => {
    const html = "Filling defects consistent with acute pulmonary embolism in the right main pulmonary artery.";
    const mentions = extractCriticalMentions(html, "en-US");
    const pe = mentions.find((m) => m.category === "pulmonary-embolism");
    assert.ok(pe, "affirmed PE should be detected");
  });

  it("does NOT detect pneumothorax when ruled out", () => {
    const html = "Pneumothorax has been ruled out based on imaging.";
    const mentions = extractCriticalMentions(html, "en-US");
    const ptx = mentions.find((m) => m.category === "pneumothorax");
    assert.equal(ptx, undefined, "ruled-out pneumothorax should NOT be detected");
  });

  it("does NOT detect hemorrhage with 'without' negation", () => {
    const html = "Brain parenchyma without hemorrhage or mass effect.";
    const mentions = extractCriticalMentions(html, "en-US");
    const bleed = mentions.find((m) => m.category === "acute-bleed");
    assert.equal(bleed, undefined, "negated hemorrhage should NOT be detected");
  });

  it("negated critical findings do not count as TP in evaluateCritical", () => {
    const benchCase = makeCase({
      findings: "rule out PE",
      criticalFindings: ["pulmonary embolism"],
    });
    const meta = makeMeta();
    // Report negates PE
    const html = "<b>Findings</b><br>No evidence of pulmonary embolism. Lungs are clear.";
    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    // The gold label "pulmonary embolism" should still be found via substring match in the report text,
    // but the extractCriticalMentions should NOT return it (important for FP count)
    const mentions = extractCriticalMentions(html, "en-US");
    assert.equal(mentions.length, 0, "no critical mentions should be extracted from negated report");
  });
});

describe("BUG 3: Pertinent negatives NOT flagged as hallucinations", () => {
  it("does not flag 'Lungs are clear' as hallucination", () => {
    const benchCase = makeCase({
      findings: "12mm gallbladder stone",
      goldFindings: [
        { finding: "gallbladder stone", severity: "minor", measurements: ["12mm"] },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    // Report includes pertinent negatives alongside the actual finding
    const html = "<b>Findings</b><br>Gallbladder stone measuring 12mm.<br>No pleural effusion.<br>Lungs are clear.<br>Liver is unremarkable.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    const hallucinations = result.details.hallucinations as Array<{ text: string }>;
    // Pertinent negatives should NOT appear as hallucinations
    const halTexts = hallucinations.map((h) => h.text.toLowerCase());
    assert.ok(
      !halTexts.some((t) => /clear|unremarkable|no pleural/.test(t)),
      `pertinent negatives should not be hallucinations, got: ${JSON.stringify(halTexts)}`,
    );
  });

  it("does not flag 'sem derrame pleural' as hallucination (pt-BR)", () => {
    const benchCase = makeCase({
      findings: "esteatose hepatica moderada",
      locale: "pt-BR",
      goldFindings: [
        { finding: "esteatose hepatica", severity: "minor" },
      ],
    });
    const meta = makeMeta({ modality: "US", region: "abdomen" });
    const html = "<b>Analise</b><br>Esteatose hepatica moderada.<br>Sem derrame pleural.<br>Rins sem alteracoes.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const hallucinations = result.details.hallucinations as Array<{ text: string }>;
    const halTexts = hallucinations.map((h) => h.text.toLowerCase());
    assert.ok(
      !halTexts.some((t) => /sem derrame|sem alterac/.test(t)),
      `pertinent negatives should not be hallucinations, got: ${JSON.stringify(halTexts)}`,
    );
  });

  it("does not flag source-supported findings as hallucinations when gold comes from the impression", () => {
    const benchCase = makeCase({
      exam: "RM PELVE",
      locale: "pt-BR",
      findings: "Fígado com hepatopatia crônica. Nódulo hepático com características de hemangioma. Cistos hepáticos esparsos. Próstata de contornos regulares.",
      goldFindings: [
        { finding: "Lesão focal hepática caracterizada como hemangioma", severity: "major" },
      ],
      referenceReport: "<b>Achados</b><br>Fígado com hepatopatia crônica. Nódulo hepático com características de hemangioma. Cistos hepáticos esparsos. Próstata de contornos regulares.<br><b>Conclusao</b><br>Lesão focal hepática caracterizada como hemangioma.",
    });
    const meta = makeMeta({ modality: "MRI", region: "pelvis", normalizedExam: "rm pelve" });
    const html = benchCase.referenceReport!;

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg03 = result.checks.find((c) => c.id === "QG03");

    assert.equal(qg03?.passed, true);
    assert.deepEqual(result.details.hallucinations, []);
  });

  it("does not fail synthesis when a copied source report has a substantive conclusion", () => {
    const benchCase = makeCase({
      exam: "TC ABDOME",
      locale: "pt-BR",
      findings: "Fígado com dimensões normais. Vesícula biliar murcha. Pâncreas com sinais de lipossubstituição difusa.",
      goldFindings: [
        { finding: "Vesícula biliar murcha", severity: "major" },
        { finding: "Acometimento pancreático por fibrose cística", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen", normalizedExam: "tc abdome" });
    const html = "<b>Achados</b><br>Fígado com dimensões normais. Vesícula biliar murcha. Pâncreas com sinais de lipossubstituição difusa.<br><b>Conclusao</b><br>Vesícula biliar murcha. Acometimento pancreático por fibrose cística.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg07 = result.checks.find((c) => c.id === "QG07");

    assert.equal(qg07?.passed, true);
  });

  it("does not deduct for concise source-faithful reports with a useful conclusion", () => {
    const benchCase = makeCase({
      exam: "TC TORAX",
      locale: "pt-BR",
      findings: "Pequeno nódulo pulmonar subpleural na base esquerda. Pectus excavatum. Ausência de linfonodomegalias mediastinais ou hilares.",
      goldFindings: [
        { finding: "Pequeno nódulo pulmonar subpleural na base esquerda", severity: "minor" },
        { finding: "Pectus excavatum", severity: "minor" },
        { finding: "Ausência de linfonodomegalias mediastinais ou hilares", severity: "minor", negated: true },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "chest" });
    const html = "<b>Análise</b><br>Pequeno nódulo pulmonar subpleural na base esquerda. Pectus excavatum. Ausência de linfonodomegalias mediastinais ou hilares.<br><b>Conclusão</b><br>Pequeno nódulo pulmonar subpleural inespecífico na base esquerda. Pectus excavatum.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg07 = result.checks.find((c) => c.id === "QG07");

    assert.equal(qg07?.passed, true, qg07?.evidence);
  });

  it("fails negated gold findings when the report states the opposite positive finding", () => {
    const benchCase = makeCase({
      findings: "No pneumothorax. No midline shift.",
      goldFindings: [
        { finding: "no pneumothorax", severity: "major", negated: true },
        { finding: "no midline shift", severity: "major", negated: true },
      ],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Pneumothorax is present. Midline shift is present.<br><b>Impression</b><br>Pneumothorax with midline shift.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    const matches = result.details.findingMatches as Array<{ goldFinding: string; matchType: string }>;

    assert.equal(matches.every((m) => m.matchType === "missed"), true);
    assert.ok(result.score < 80, `opposite polarity should not pass quality scoring, got ${result.score}`);
  });

  it("preserves pt-BR uncertainty findings without treating them as negated absences", () => {
    const benchCase = makeCase({
      findings: "Na junção com a veia cava superior, não sendo possível afastar pequeno trombo associado.",
      goldFindings: [
        { finding: "Na junção com a veia cava superior, não sendo possível afastar pequeno trombo associado", severity: "critical" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "chest" });
    const html = "<b>Achados</b><br>Na junção com a veia cava superior, não sendo possível afastar pequeno trombo associado.<br><b>Conclusão</b><br>Possibilidade de pequeno trombo associado.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg02 = result.checks.find((c) => c.id === "QG02");

    assert.equal(qg02, undefined);
    assert.ok(result.score >= 88, `expected preserved critical uncertainty finding, got ${result.score}`);
  });

  it("fails synthesis for generic templated output without a conclusion section", () => {
    const benchCase = makeCase({
      exam: "MMG MAMOGRAFIA BILATERAL",
      locale: "pt-BR",
      findings: "Nódulo irregular espiculado na mama direita.",
      goldFindings: [
        { finding: "Nódulo irregular espiculado na mama direita", severity: "major", laterality: "right" },
      ],
    });
    const meta = makeMeta({ modality: "MG", region: "breast" });
    const html = "Relatório preliminar sem padrão. Não há alterações agudas. Sem lesão suspeita.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const qg07 = result.checks.find((c) => c.id === "QG07");

    assert.equal(qg07?.passed, false, "generic templated output should fail synthesis");
    assert.match(qg07?.evidence ?? "", /missing-conclusion-section/);
  });
});

describe("BUG 4: nDCG with ideal ranking from full gold set", () => {
  it("nDCG is lower when ideal ranking differs from retrieved ranking", () => {
    // Gold: doc1=3, doc2=2, doc3=1, doc4=0, doc5=3
    // Retrieved: [doc4, doc3, doc1] (worst ordering - irrelevant first)
    // Ideal top-3: [doc1=3, doc5=3, doc2=2]
    const benchCase = makeCase({
      retrievalGold: [
        { documentId: "doc1", relevance: 3 },
        { documentId: "doc2", relevance: 2 },
        { documentId: "doc3", relevance: 1 },
        { documentId: "doc4", relevance: 0 },
        { documentId: "doc5", relevance: 3 },
      ],
    });
    const meta = makeMeta();
    const html = "";
    // Retrieved in bad order: irrelevant first
    const retrievedDocIds = ["doc4", "doc3", "doc1"];

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, [], retrievedDocIds);
    const ndcg3 = result.details["ndcg@3"] as number;
    // With correct iDCG from full gold set (top-3 ideal = [3,3,2]),
    // the nDCG should be significantly less than 1 because we retrieved [0,1,3]
    assert.ok(ndcg3 < 0.7, `nDCG@3 should be < 0.7 with bad ordering, got ${ndcg3}`);

    // Now test perfect ordering
    const perfectRetrieved = ["doc1", "doc5", "doc2"];
    const perfectResult = evaluateRetrieval(html, benchCase, "en-US", meta, [], perfectRetrieved);
    const perfectNdcg3 = perfectResult.details["ndcg@3"] as number;
    assert.ok(perfectNdcg3 > ndcg3, `perfect ordering nDCG (${perfectNdcg3}) should be > bad ordering (${ndcg3})`);
  });
});

describe("BUG 5: Hedging regex counts correctly without skipping", () => {
  it("counts all hedging sentences, not every other one", () => {
    const meta = makeMeta({ abnormalStudy: true });
    // Create a report with 4 hedging sentences in the conclusion (use pt-BR section headers)
    const html = [
      "<center><b>Tomografia Computadorizada do Cr\u00e2nio</b></center>",
      "<br><br><b>T\u00e9cnica</b><br>TC sem contraste.",
      "<br><br><b>An\u00e1lise</b><br>Lesao identificada no lobo frontal direito.",
      "<br><br><b>Conclus\u00e3o</b>",
      "<br>A esclarecer a natureza da lesao.",
      "<br>Nao se pode excluir processo expansivo.",
      "<br>Sugerir complementacao com RM.",
      "<br>Convem correlacionar clinicamente.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "lesao frontal direita", "pt-BR");
    const hedgeCheck = checks.find((c) => c.id === "Q14");
    assert.ok(hedgeCheck, "Q14 check should exist");
    // All 4 sentences are hedging out of 4, so ratio=100% > 40% threshold => should FAIL
    assert.equal(hedgeCheck!.passed, false, `all 4 sentences are hedged, should fail. Evidence: ${hedgeCheck!.evidence}`);
    // Verify the evidence shows 4/4 (not 2/4 which would happen with the lastIndex bug)
    assert.ok(hedgeCheck!.evidence.includes("4/4"), `evidence should show 4/4, got: ${hedgeCheck!.evidence}`);
  });
});

describe("BUG 6: C02 does NOT fire on normal studies", () => {
  it("does not penalize umbrella phrase in normal study conclusion", () => {
    const meta = makeMeta({ abnormalStudy: false });
    const html = [
      "<center><b>Tomografia Computadorizada de Abdome</b></center>",
      "<br><br><b>T\u00e9cnica</b><br>Tecnica padrao sem contraste.",
      "<br><br><b>An\u00e1lise</b><br>Figado de dimensoes normais. Vesicula biliar sem calculos.",
      "<br><br><b>Conclus\u00e3o</b><br>Demais estruturas sem altera\u00e7\u00f5es avali\u00e1veis. Exame normal.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "normal", "pt-BR");
    const c02 = checks.find((c) => c.id === "C02");
    // C02 should not exist at all for normal studies
    assert.equal(c02, undefined, "C02 should not fire on normal studies");
  });

  it("still penalizes umbrella phrase in abnormal study conclusion", () => {
    const meta = makeMeta({ abnormalStudy: true });
    const html = [
      "<center><b>Tomografia Computadorizada de Abdome</b></center>",
      "<br><br><b>T\u00e9cnica</b><br>Tecnica padrao sem contraste.",
      "<br><br><b>An\u00e1lise</b><br>Nodulo hepatico de 3cm no segmento VIII.",
      "<br><br><b>Conclus\u00e3o</b><br>Nodulo hepatico. Demais estruturas sem altera\u00e7\u00f5es.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "nodulo hepatico", "pt-BR");
    const c02 = checks.find((c) => c.id === "C02");
    assert.ok(c02, "C02 should exist for abnormal studies");
    assert.equal(c02!.passed, false, "C02 should fail when umbrella phrase in abnormal study conclusion");
  });
});

describe("Q09 ultrasound technique section policy", () => {
  it("does not fail or gate ultrasound reports that include a technique section", () => {
    const meta = makeMeta({ modality: "US", region: "abdomen", abnormalStudy: true });
    const html = [
      "<center><b>Ultrassonografia de Abdome</b></center>",
      "<br><br><b>Tecnica</b><br>Exame realizado com transdutor convexo.",
      "<br><br><b>Analise</b><br>Figado com esteatose leve. Vesicula biliar sem calculos.",
      "<br><br><b>Conclusao</b><br>Esteatose hepatica leve.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "esteatose hepatica leve", "pt-BR");
    const q09 = checks.find((c) => c.id === "Q09");

    assert.ok(q09, "Q09 check should exist for ultrasound reports");
    assert.equal(q09!.severity, "minor");
    assert.equal(q09!.passed, true);
    assert.equal(q09!.evidence, "technique section present");
  });
});

describe("BUG 7: CT reports with 'densidade' do NOT get penalized", () => {
  it("does not flag 'densidade' as forbidden in CT reports (pt-BR)", () => {
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    const html = [
      "<center><b>Tomografia Computadorizada de Abdome</b></center>",
      "<br><br><b>Tecnica</b><br>Tecnica padrao sem contraste.",
      "<br><br><b>Analise</b><br>Figado com atenuacao normal. Lesao de densidade de partes moles no rim direito.",
      "<br><br><b>Conclusao</b><br>Lesao renal direita de densidade de partes moles.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "lesao renal direita", "pt-BR");
    const tm3 = checks.find((c) => c.id === "TM3");
    assert.ok(tm3, "TM3 check should exist");
    assert.equal(tm3!.passed, true, `'densidade' should NOT be flagged as forbidden in CT. Evidence: ${tm3!.evidence}`);
  });
});

describe("BUG 9: Bosniak Roman numeral normalization", () => {
  it("normalizes Bosniak II to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak II");
    assert.equal(result, "II");
  });

  it("normalizes Bosniak IIF to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak IIF");
    assert.equal(result, "IIF");
  });

  it("normalizes Bosniak III to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak III");
    assert.equal(result, "III");
  });

  it("normalizes Bosniak IV to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak IV");
    assert.equal(result, "IV");
  });

  it("normalizes Arabic 2 to same as Roman II", () => {
    const arabic = normalizeClassificationValue("Bosniak 2");
    const roman = normalizeClassificationValue("Bosniak II");
    assert.equal(arabic, roman, `Arabic '2' (${arabic}) should equal Roman 'II' (${roman})`);
  });

  it("normalizes Arabic 2F to same as Roman IIF", () => {
    const arabic = normalizeClassificationValue("Bosniak 2F");
    const roman = normalizeClassificationValue("Bosniak IIF");
    assert.equal(arabic, roman, `Arabic '2F' (${arabic}) should equal Roman 'IIF' (${roman})`);
  });

  it("extracts and normalizes Bosniak Roman numerals from report text", () => {
    const html = "Complex renal cyst classified as Bosniak III.";
    const cls = extractClassifications(html);
    const bosniak = cls.find((c) => c.system === "bosniak");
    assert.ok(bosniak, "should find Bosniak");
    assert.equal(bosniak!.normalizedValue, "III");
  });
});

// ---- BUG F REGRESSION TESTS ----

describe("BUG F.1: compareSections segments by section header and compares independently", () => {
  it("scores higher when both sections match vs only one section matches", () => {
    const benchCase = makeCase({
      findings: "hepatic steatosis",
      referenceReport:
        "<b>Findings</b><br>Moderate hepatic steatosis. No biliary dilatation." +
        "<br><br><b>Impression</b><br>Moderate hepatic steatosis.",
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });

    // Good candidate: matches both sections
    const goodHtml =
      "<b>Findings</b><br>Moderate hepatic steatosis. No biliary dilatation." +
      "<br><br><b>Impression</b><br>Moderate hepatic steatosis.";

    // Bad candidate: completely different impression section
    const badHtml =
      "<b>Findings</b><br>Moderate hepatic steatosis. No biliary dilatation." +
      "<br><br><b>Impression</b><br>Pneumothorax with midline shift.";

    const goodResult = evaluateQuality(goodHtml, benchCase, "en-US", meta, []);
    const badResult = evaluateQuality(badHtml, benchCase, "en-US", meta, []);

    assert.equal(goodResult.details.mode, "reference-comparison");
    assert.equal(badResult.details.mode, "reference-comparison");
    assert.ok(
      goodResult.score > badResult.score,
      `good candidate score (${goodResult.score}) should be higher than bad (${badResult.score})`,
    );
  });

  it("detects section-level mismatch in findings vs impression", () => {
    const benchCase = makeCase({
      findings: "normal",
      referenceReport:
        "<b>Findings</b><br>Normal brain parenchyma. No acute abnormality." +
        "<br><br><b>Impression</b><br>Normal.",
    });
    const meta = makeMeta();

    // Candidate with swapped section content
    const html =
      "<b>Findings</b><br>Normal." +
      "<br><br><b>Impression</b><br>Normal brain parenchyma. No acute abnormality.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "reference-comparison");
    const sectionScores = result.details.sectionScores as Record<string, number>;
    // At least one section should have a lower score due to mismatch
    assert.ok(sectionScores !== undefined, "should have section scores");
  });

  it("does not penalize pt-BR Impressão vs Conclusão label aliases", () => {
    const benchCase = makeCase({
      locale: "pt-BR",
      findings: "esteatose hepática moderada",
      referenceReport:
        "<b>Análise</b><br>Fígado com esteatose moderada." +
        "<br><br><b>Conclusão</b><br>Esteatose hepática moderada.",
    });
    const meta = makeMeta({ normalizedExam: "tc abdome", normalizedFindings: "esteatose", region: "abdomen" });
    const html =
      "<b>Análise</b><br>Fígado com esteatose moderada." +
      "<br><br><b>Impressão</b><br>Esteatose hepática moderada.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.details.mode, "reference-comparison");
    assert.ok(result.score >= 95, `alias-only section label change should not drop score, got ${result.score}`);
  });
});

describe("BUG F.2: Fleischner extraction captures category text", () => {
  it("extracts Fleischner category text, not just 'mentioned'", () => {
    const html = "Pulmonary nodule. Fleischner low-risk: no follow-up needed.";
    const cls = extractClassifications(html);
    const fleischner = cls.find((c) => c.system === "fleischner");
    assert.ok(fleischner, "should find Fleischner");
    // The normalized value should contain the category text, not just 'mentioned'
    assert.ok(
      fleischner!.normalizedValue.length > 0,
      "should have a non-empty normalized value",
    );
    assert.ok(
      fleischner!.normalizedValue.includes("low-risk"),
      `should capture category text, got: '${fleischner!.normalizedValue}'`,
    );
  });

  it("returns 'mentioned' when Fleischner has no trailing text", () => {
    const html = "Recommend per Fleischner.";
    const cls = extractClassifications(html);
    const fleischner = cls.find((c) => c.system === "fleischner");
    assert.ok(fleischner, "should find Fleischner");
    assert.equal(fleischner!.normalizedValue, "mentioned");
  });
});

describe("BUG F.3: Negated gold critical findings NOT counted as TP in evaluateCritical", () => {
  it("counts negated gold-label match as FN, not TP", () => {
    const benchCase = makeCase({
      findings: "rule out PE",
      criticalFindings: ["pulmonary embolism"],
    });
    const meta = makeMeta();
    // Report says "no evidence of pulmonary embolism" — substring matches gold label
    // but should be counted as miss because it's negated
    const html = "<b>Findings</b><br>No evidence of pulmonary embolism. Lungs are clear.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");

    const tps = result.details.truePositives as string[];
    const fns = result.details.falseNegatives as string[];

    assert.ok(
      !tps.includes("pulmonary embolism"),
      "negated match should NOT be a true positive",
    );
    assert.ok(
      fns.includes("pulmonary embolism"),
      "negated match should be counted as false negative (miss)",
    );
  });

  it("still counts affirmed gold-label match as TP", () => {
    const benchCase = makeCase({
      findings: "acute PE",
      criticalFindings: ["pulmonary embolism"],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Filling defects consistent with acute pulmonary embolism.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");

    const tps = result.details.truePositives as string[];
    assert.ok(
      tps.includes("pulmonary embolism"),
      "affirmed match should be a true positive",
    );
  });

  it("handles mixed negated and affirmed critical findings", () => {
    const benchCase = makeCase({
      findings: "midline shift. rule out PE",
      criticalFindings: ["midline shift", "pulmonary embolism"],
    });
    const meta = makeMeta();
    // Report affirms midline shift but negates PE
    const html = "<b>Findings</b><br>5mm midline shift to the left. No evidence of pulmonary embolism.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);

    const tps = result.details.truePositives as string[];
    const fns = result.details.falseNegatives as string[];

    assert.ok(tps.includes("midline shift"), "affirmed midline shift should be TP");
    assert.ok(fns.includes("pulmonary embolism"), "negated PE should be FN");
  });

  it("penalizes hallucinated critical findings when no gold critical is expected", () => {
    const benchCase = makeCase({
      findings: "No acute thoracic abnormality.",
      goldFindings: [
        { finding: "no pneumothorax", severity: "major", negated: true },
      ],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Large pneumothorax is present.<br><b>Impression</b><br>Large pneumothorax.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);

    assert.equal(result.details.mode, "gold-critical-none");
    assert.equal(result.score, 0);
    assert.equal(result.checks[0].passed, false);
    assert.equal(result.checks[0].severity, "critical");
  });

  it("treats invented critical findings as critical failures even when another gold critical is present", () => {
    const benchCase = makeCase({
      criticalFindings: ["midline shift"],
      goldFindings: [
        { finding: "midline shift", severity: "critical" },
      ],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Midline shift is present. Acute pulmonary embolism is present.<br><b>Impression</b><br>Midline shift and acute pulmonary embolism.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    const precision = result.checks.find((c) => c.id === "CG03");

    assert.equal(precision?.passed, false);
    assert.equal(precision?.severity, "critical");
  });

  it("does not count source-backed critical mentions as hallucinated precision failures", () => {
    const benchCase = makeCase({
      findings: "Falhas de enchimento em ramos arteriais lobares, compativeis com tromboembolismo pulmonar.",
      goldFindings: [
        { finding: "Falhas de enchimento em ramos arteriais lobares", severity: "major" },
      ],
    });
    const meta = makeMeta();
    const html = "<b>Achados</b><br>Falhas de enchimento em ramos arteriais lobares, compatíveis com tromboembolismo pulmonar.<br><b>Conclusão</b><br>Tromboembolismo pulmonar.";

    const result = evaluateCritical(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.score, 100);
    assert.equal(result.checks.every((check) => check.passed), true);
    assert.deepEqual(result.details.falsePositives, []);
  });

  it("does not score administrative comparison boilerplate as a critical finding", () => {
    const benchCase = makeCase({
      findings: "A análise deste exame é feita considerando também os dados do exame anterior.",
      criticalFindings: ["DESTE EXAME E FEITA CONSIDERANDO TAMBEM OS DADOS DO EXAME DE [DATE]"],
      goldFindings: [
        { finding: "DESTE EXAME E FEITA CONSIDERANDO TAMBEM OS DADOS DO EXAME DE [DATE]", severity: "critical" },
      ],
    });
    const meta = makeMeta();
    const html = "<b>Achados</b><br>Relatório comparativo com exame anterior.<br><b>Conclusão</b><br>Sem achado crítico novo.";

    const result = evaluateCritical(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.score, 100);
    assert.equal(result.checks.every((check) => check.passed), true);
  });
});

// ---- ADVERSARIAL & BOUNDARY TESTS ----

describe("Boundary: combineScores verdict thresholds", () => {
  function makeDimsAllScored(score: number): Record<Dim, DimSummary> {
    const dims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      dims[dim] = { score, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    return dims;
  }

  function makeJudge(dimScore: number): import("./types.js").JudgeResult {
    const scores: Partial<Record<Dim, number>> = {};
    for (const dim of DIMS) scores[dim] = dimScore;
    return {
      verdict: "PASS",
      scores,
      overall: dimScore,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
  }

  it("score of exactly 84 yields PASS verdict", () => {
    const dims = makeDimsAllScored(84);
    // judge scores must produce combined >= 84: judge dim score 5 => 5*20 = 100, min(84, 100) = 84
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PASS", `overall=${result.overall} should produce PASS`);
  });

  it("score of exactly 83.9 yields PARTIAL verdict", () => {
    const dims = makeDimsAllScored(83.9);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PARTIAL", `overall=${result.overall} should produce PARTIAL`);
  });

  it("score of exactly 60 yields PARTIAL verdict", () => {
    const dims = makeDimsAllScored(60);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PARTIAL", `overall=${result.overall} should produce PARTIAL`);
  });

  it("score of exactly 59.9 yields FAIL verdict", () => {
    const dims = makeDimsAllScored(59.9);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "FAIL", `overall=${result.overall} should produce FAIL`);
  });

  it("score of exactly 0 yields FAIL verdict", () => {
    const dims = makeDimsAllScored(0);
    const judge = makeJudge(0);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.overall, 0);
  });

  it("score of exactly 100 yields PASS verdict", () => {
    const dims = makeDimsAllScored(100);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.overall, 100);
  });
});

describe("Adversarial: extractFindings edge cases", () => {
  it("empty HTML string returns empty array", () => {
    const findings = extractFindings("", "en-US");
    assert.equal(findings.length, 0);
  });

  it("HTML with only tags and no text returns empty array", () => {
    const findings = extractFindings("<b></b><br><div><span></span></div>", "en-US");
    assert.equal(findings.length, 0);
  });

  it("malformed HTML with unclosed tags does not crash", () => {
    const html = "<b>Findings<br>Large hepatic mass measuring 5cm.<div><span>Pleural effusion";
    const findings = extractFindings(html, "en-US");
    // Should not throw, and should still extract what it can
    assert.ok(Array.isArray(findings));
  });

  it("script injection attempt does not crash and strips tags", () => {
    const html = '<script>alert("xss")</script><br><img onerror="hack()" src=x><br>Large hepatic mass measuring 5cm.';
    const findings = extractFindings(html, "en-US");
    // Should not throw, and no finding should contain HTML tag syntax
    assert.ok(Array.isArray(findings));
    for (const f of findings) {
      assert.ok(!/<script|<img|onerror/i.test(f.text), `finding should not contain HTML tags: ${f.text}`);
    }
  });
});

describe("Adversarial: report says opposite of gold findings", () => {
  it("report with completely unrelated findings gets low QUAL score", () => {
    const benchCase = makeCase({
      findings: "large hepatic mass. bilateral pleural effusion",
      goldFindings: [
        { finding: "hepatic mass", severity: "major" },
        { finding: "bilateral pleural effusion", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen", abnormalStudy: true });
    // Report describes entirely unrelated anatomy and findings
    const html = "<b>Findings</b><br>Mild degenerative changes of the lumbar spine. Disc desiccation at L4-L5.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-findings");
    // Completely wrong findings should produce a very low score
    assert.ok(result.score <= 30, `completely wrong report should score low, got ${result.score}`);
  });

  it("report that negates every gold critical finding yields 0% CRIT recall", () => {
    const benchCase = makeCase({
      findings: "subdural hematoma. midline shift. pneumothorax",
      criticalFindings: ["subdural hematoma", "midline shift", "pneumothorax"],
    });
    const meta = makeMeta();
    // Report negates all critical findings using patterns recognized by isNegated
    const html =
      "<b>Findings</b><br>No evidence of subdural hematoma." +
      "<br>Without midline shift." +
      "<br>Negative for pneumothorax.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    const recall = result.details.recall as number;
    assert.equal(recall, 0, `negating every gold critical finding should yield 0% recall, got ${recall}`);
    const fns = result.details.falseNegatives as string[];
    assert.equal(fns.length, 3, "all 3 critical findings should be false negatives");
  });
});

describe("Adversarial: wrong BI-RADS value detected by GUIDE evaluator", () => {
  it("detects mismatch when gold=4 but report=2", () => {
    const benchCase = makeCase({
      exam: "mammography bilateral",
      findings: "irregular spiculated mass in the right breast",
      guidelineExpectations: [
        { guidelineId: "birads", expectedClassification: "BI-RADS 4" },
      ],
    });
    const meta = makeMeta({ modality: "MG", region: "unknown" });
    const html = "<b>Findings</b><br>Irregular spiculated mass in the right breast. BI-RADS 2.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, []);
    // There should be a check that validates the BI-RADS value and it should fail
    const biradsCheck = result.checks.find((c) => c.id.includes("birads"));
    assert.ok(biradsCheck, "should have a BI-RADS check");
    // Either the correctness check fails or the overall score is penalized
    const correctnessCheck = result.checks.find((c) => c.id.includes("birads") && c.id.includes("correct"));
    if (correctnessCheck) {
      assert.equal(correctnessCheck.passed, false, "BI-RADS 2 vs gold 4 should fail correctness");
    } else {
      // If no explicit correctness check, score should be penalized
      assert.ok(result.score < 100, `wrong BI-RADS should reduce score, got ${result.score}`);
    }
  });
});

describe("Finding matching avoids hidden synonym acceptance", () => {
  it("does not auto-pass gold 'consolidacao' on synonym-only 'opacidade alveolar'", () => {
    const benchCase = makeCase({
      findings: "consolidacao no lobo inferior direito",
      locale: "pt-BR",
      goldFindings: [
        { finding: "consolidacao", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "chest" });
    const html = "<b>Analise</b><br>Opacidade alveolar no lobo inferior direito sugestiva de processo infeccioso.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    assert.equal(result.details.mode, "gold-findings");
    const matches = result.details.findingMatches as Array<{ goldFinding: string; matchType: string }>;
    assert.ok(matches, "should have findingMatches in details");
    const goldMatch = matches.find((m) => m.goldFinding === "consolidacao");
    assert.ok(goldMatch, "should have a match entry for consolidacao");
    assert.equal(goldMatch!.matchType, "missed");
  });
});

describe("combineScores confidence tests", () => {
  function makeDimsScored(score: number): Record<Dim, DimSummary> {
    const dims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      dims[dim] = { score, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    return dims;
  }

  it("judge with hallucinations degrades confidence to medium", () => {
    const dims = makeDimsScored(90);
    const judge: import("./types.js").JudgeResult = {
      verdict: "PASS",
      scores: { CRIT: 4.5, QUAL: 4.5, TERM: 4.5, GUIDE: 4.5, RAG: 4.5 },
      overall: 4.5,
      critical_failures: [],
      missing: [],
      hallucinated: ["invented finding about cardiac tamponade"],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(dims, judge, []);
    assert.equal(result.confidence, "medium", "hallucinated findings should degrade confidence to medium");
  });

  it("no judge results in low confidence", () => {
    const dims = makeDimsScored(50);
    const result = combineScores(dims, null, []);
    assert.equal(result.confidence, "low", "absence of judge should yield low confidence");
  });
});

// ---- Stats module tests ----

describe("bootstrapCI", () => {
  it("returns point estimate for single score", () => {
    const result = bootstrapCI([75]);
    assert.equal(result.mean, 75);
    assert.equal(result.lower, 75);
    assert.equal(result.upper, 75);
  });

  it("returns zeros for empty array", () => {
    const result = bootstrapCI([]);
    assert.equal(result.mean, 0);
    assert.equal(result.lower, 0);
    assert.equal(result.upper, 0);
  });

  it("CI contains the true mean for uniform data", () => {
    const scores = Array.from({ length: 50 }, (_, i) => 60 + i);
    const result = bootstrapCI(scores);
    assert.ok(result.lower <= result.mean, `lower (${result.lower}) should be <= mean (${result.mean})`);
    assert.ok(result.upper >= result.mean, `upper (${result.upper}) should be >= mean (${result.mean})`);
    assert.ok(result.lower < result.upper, `lower (${result.lower}) should be < upper (${result.upper})`);
  });

  it("produces narrower CI with more data", () => {
    const small = bootstrapCI([80, 85, 90, 70, 75]);
    const large = bootstrapCI(Array.from({ length: 100 }, () => 80));
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    assert.ok(largeWidth <= smallWidth, `large sample CI width (${largeWidth}) should be <= small (${smallWidth})`);
  });

  it("is deterministic with the same seed", () => {
    const scores = [70, 80, 90, 60, 85, 95, 50, 75];
    const a = bootstrapCI(scores, 5000, 0.05, 123);
    const b = bootstrapCI(scores, 5000, 0.05, 123);
    assert.equal(a.mean, b.mean);
    assert.equal(a.lower, b.lower);
    assert.equal(a.upper, b.upper);
  });

  it("wider CI with higher alpha (narrower confidence level)", () => {
    const scores = [70, 80, 90, 60, 85, 95, 50, 75, 65, 88];
    const ci95 = bootstrapCI(scores, 10000, 0.05);
    const ci80 = bootstrapCI(scores, 10000, 0.20);
    const width95 = ci95.upper - ci95.lower;
    const width80 = ci80.upper - ci80.lower;
    assert.ok(width95 >= width80, `95% CI width (${width95}) should be >= 80% CI width (${width80})`);
  });
});

describe("mcNemarTest", () => {
  it("returns chi2=0 and pValue=1 when models agree perfectly", () => {
    const a = [true, true, false, false, true];
    const b = [true, true, false, false, true];
    const result = mcNemarTest(a, b);
    assert.equal(result.chi2, 0);
    assert.equal(result.pValue, 1);
  });

  it("throws on mismatched array lengths", () => {
    assert.throws(() => mcNemarTest([true], [true, false]), /equal length/);
  });

  it("detects significant difference with large discordant pairs", () => {
    // A correct on 20 cases where B is wrong, B correct on 2 cases where A is wrong
    const n = 100;
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < n; i++) {
      if (i < 50) { a.push(true); b.push(true); }      // both correct
      else if (i < 70) { a.push(true); b.push(false); } // A correct, B wrong (20 cases)
      else if (i < 72) { a.push(false); b.push(true); } // B correct, A wrong (2 cases)
      else { a.push(false); b.push(false); }             // both wrong
    }
    const result = mcNemarTest(a, b);
    assert.ok(result.chi2 > 0, `chi2 should be > 0, got ${result.chi2}`);
    assert.ok(result.pValue < 0.05, `pValue should be < 0.05, got ${result.pValue}`);
  });

  it("uses exact binomial p-value for small discordant samples", () => {
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      if (i < 10) { a.push(true); b.push(false); }
      else { a.push(false); b.push(true); }
    }
    const result = mcNemarTest(a, b);
    assert.equal(result.pValue, 0.038574);
  });

  it("returns non-significant for balanced discordant pairs", () => {
    // A correct on 10, B correct on 10 -- symmetric disagreement
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < 50; i++) {
      if (i < 20) { a.push(true); b.push(true); }
      else if (i < 30) { a.push(true); b.push(false); }
      else if (i < 40) { a.push(false); b.push(true); }
      else { a.push(false); b.push(false); }
    }
    const result = mcNemarTest(a, b);
    assert.ok(result.pValue > 0.05, `balanced disagreement should not be significant, pValue=${result.pValue}`);
  });
});

describe("cohensH", () => {
  it("returns 0 for equal proportions", () => {
    assert.equal(cohensH(0.5, 0.5), 0);
  });

  it("returns positive when p1 > p2", () => {
    const h = cohensH(0.9, 0.5);
    assert.ok(h > 0, `cohensH(0.9, 0.5) should be positive, got ${h}`);
  });

  it("returns negative when p1 < p2", () => {
    const h = cohensH(0.3, 0.8);
    assert.ok(h < 0, `cohensH(0.3, 0.8) should be negative, got ${h}`);
  });

  it("is antisymmetric: h(p1,p2) = -h(p2,p1)", () => {
    const h1 = cohensH(0.7, 0.3);
    const h2 = cohensH(0.3, 0.7);
    assert.ok(Math.abs(h1 + h2) < 0.0001, `h(0.7,0.3)=${h1} and h(0.3,0.7)=${h2} should sum to ~0`);
  });

  it("extreme proportions yield large effect size", () => {
    const h = cohensH(1.0, 0.0);
    assert.ok(Math.abs(h) > 2, `h(1.0, 0.0) should be large, got ${h}`);
  });

  it("throws for out-of-range proportions", () => {
    assert.throws(() => cohensH(-0.1, 0.5), /\[0,1\]/);
    assert.throws(() => cohensH(0.5, 1.1), /\[0,1\]/);
  });

  it("classifies small effect size correctly", () => {
    // ~0.2 effect size from close proportions
    const h = cohensH(0.55, 0.50);
    assert.ok(Math.abs(h) < 0.2, `close proportions should give small effect, got |h|=${Math.abs(h)}`);
  });
});
