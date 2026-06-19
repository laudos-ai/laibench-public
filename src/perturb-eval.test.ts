import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPerturbationCaught } from "./perturb-eval.js";
import { PERTURBATIONS } from "./perturb.js";
import type { CaseRunResult, Dim } from "./types.js";

function fakeResult(args: {
  combined?: Partial<Record<Dim, number>>;
  detFails?: Array<{ dim: Dim; severity: "critical" | "major" | "minor" }>;
  judgeFlags?: Dim[];
}): CaseRunResult {
  const combined: Record<Dim, number | null> = {
    CRIT: args.combined?.CRIT ?? 90,
    QUAL: args.combined?.QUAL ?? 90,
    TERM: args.combined?.TERM ?? 90,
    GUIDE: args.combined?.GUIDE ?? 90,
    RAG: args.combined?.RAG ?? 90,
  };
  return {
    case: { id: "x", exam: "x", findings: "y", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: "",
    normalizedHtml: "",
    sanitizedHtml: "",
    meta: { modality: "CT", contrast: false, region: "head", normalizedExam: "", normalizedFindings: "", abnormalStudy: false, expectedTitleTokens: [], expectedRegionTokens: [] },
    checks: (args.detFails ?? []).map((f, i) => ({
      dim: f.dim,
      id: `c${i}`,
      name: "fail",
      severity: f.severity,
      passed: false,
      evidence: "",
    })),
    detDims: { CRIT: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, QUAL: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, TERM: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, GUIDE: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, RAG: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 } },
    detOverall: 0,
    judge: args.judgeFlags && args.judgeFlags.length > 0 ? {
      verdict: "FAIL",
      scores: {},
      overall: null,
      critical_failures: args.judgeFlags.map((d) => ({ dim: d, issue: "", evidence: "" })),
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    } : null,
    combined,
    combinedOverall: 0,
    verdict: "FAIL",
    confidence: "low",
    phaseStatus: "complete",
    gateReasons: [],
    costUsd: 0,
    latencyMs: 0,
    trace: [],
  };
}

describe("isPerturbationCaught", () => {
  it("catches via deterministic critical check on expected dim", () => {
    const result = fakeResult({ detFails: [{ dim: "CRIT", severity: "critical" }] });
    assert.equal(isPerturbationCaught(PERTURBATIONS.negation_drop, result), true);
  });

  it("catches via judge critical failure", () => {
    const result = fakeResult({ judgeFlags: ["CRIT"] });
    assert.equal(isPerturbationCaught(PERTURBATIONS.critical_invent, result), true);
  });

  it("catches via combined dim below severity floor (critical → <60)", () => {
    const result = fakeResult({ combined: { CRIT: 50 } });
    assert.equal(isPerturbationCaught(PERTURBATIONS.critical_drop, result), true);
  });

  it("misses when scoring is silent across all expected dims", () => {
    const result = fakeResult({ combined: { CRIT: 95, RAG: 95, QUAL: 95, TERM: 95, GUIDE: 95 } });
    assert.equal(isPerturbationCaught(PERTURBATIONS.laterality_flip, result), false);
  });

  it("uses major floor (80) for major perturbations", () => {
    const result = fakeResult({ combined: { RAG: 75, QUAL: 75 } });
    assert.equal(isPerturbationCaught(PERTURBATIONS.measurement_scramble, result), true);
  });

  it("counts a critical deterministic failure when the perturbation expects a major failure", () => {
    const result = fakeResult({ detFails: [{ dim: "QUAL", severity: "critical" }] });
    assert.equal(isPerturbationCaught(PERTURBATIONS.negation_insert, result), true);
  });
});
