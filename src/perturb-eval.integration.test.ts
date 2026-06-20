import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPerturbationDataset, isPerturbationCaught, summarizePerturbationRun } from "./perturb-eval.js";
import { PERTURBATIONS } from "./perturb.js";
import type { BenchCase, CaseRunResult, Dim, SuiteRunResult } from "./types.js";

function makeCase(id: string, criticalFindings: string[], opts: { lang?: "pt-BR" | "en-US" } = {}): BenchCase {
  return {
    id,
    exam: opts.lang === "en-US" ? "ct head" : "tc cranio",
    findings: criticalFindings.join(". ") + ". Sem outras alterações.",
    locale: opts.lang ?? "pt-BR",
    criticalFindings,
    referenceReport: criticalFindings.join(". ") + ". Sem outras alterações.",
  };
}

function makeResult(args: {
  id: string;
  combined: Partial<Record<Dim, number>>;
  detFails?: Array<{ dim: Dim; severity: "critical" | "major" }>;
}): CaseRunResult {
  const combined: Record<Dim, number | null> = {
    CRIT: args.combined.CRIT ?? 90,
    QUAL: args.combined.QUAL ?? 90,
    TERM: args.combined.TERM ?? 90,
    GUIDE: args.combined.GUIDE ?? 90,
    RAG: args.combined.RAG ?? 90,
  };
  return {
    case: { id: args.id, exam: "x", findings: "y", locale: "pt-BR" },
    locale: "pt-BR",
    rawHtml: "",
    normalizedHtml: "",
    sanitizedHtml: "",
    meta: { modality: "CT", contrast: false, region: "head", normalizedExam: "", normalizedFindings: "", abnormalStudy: false, expectedTitleTokens: [], expectedRegionTokens: [] },
    checks: (args.detFails ?? []).map((f, i) => ({ dim: f.dim, id: `c${i}`, name: "fail", severity: f.severity, passed: false, evidence: "" })),
    detDims: { CRIT: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, QUAL: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, TERM: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, GUIDE: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 }, RAG: { score: null, pass: 0, total: 0, critFails: 0, verdict: "UNSCORED", appliedWeight: 0 } },
    detOverall: 0,
    judge: null,
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

function makeSuiteRun(results: CaseRunResult[]): SuiteRunResult {
  return {
    manifest: {
      benchmarkName: "laibench",
      benchmarkVersion: "2.0.0",
      createdAt: "",
      runName: "perturb-test",
      suiteId: "test",
      suiteLabel: "",
      suiteVisibility: "public",
      suiteHash: "",
      locale: "pt-BR",
      track: "agent",
      provider: "perturb",
      modelLabel: "perturb",
      entityName: "test",
      entityType: "research",
      systemType: "raw-model",
      comparisonClass: "test",
      scaffoldId: null,
      judgeProvider: null,
      judgeModel: null,
      evaluationMode: "local",
      submissionMode: "predictions",
      validation: { valid: true, expectedIds: [], receivedIds: [], missingIds: [], duplicateIds: [], extraIds: [], emptyOutputs: [], errors: [] },
      comparableKey: "k",
    },
    summary: { accuracyRate: 0, averageOverall: 0, passRate: 0, strictPassRate: 0, averageLatencyMs: 0, totalCostUsd: 0, verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 0 }, averagePerDim: {} },
    results,
  };
}

describe("perturb-eval integration", () => {
  it("buildPerturbationDataset emits 8 perturbations per case", () => {
    const cases = [
      makeCase("A", ["hematoma agudo"]),
      makeCase("B", ["fratura de costela"]),
    ];
    const { samples, links } = buildPerturbationDataset(cases);
    assert.equal(samples.length, 16);
    assert.equal(links.length, 16);
    assert.equal(new Set(samples.map((s) => s.kind)).size, Object.keys(PERTURBATIONS).length);
  });

  it("applicableOnly skips no-op and non-score-relevant perturbations", () => {
    const cases: BenchCase[] = [{
      id: "NOOP",
      exam: "tc abdome",
      findings: "Fígado sem lesões focais. Sem dilatação biliar.",
      locale: "pt-BR",
      goldFindings: [{ finding: "fígado sem lesões focais", severity: "minor", negated: true }],
      criticalFindings: [],
      referenceReport: "<b>Achados</b><br>Fígado sem lesões focais. Sem dilatação biliar.<br><b>Conclusão</b><br>Sem lesões focais.",
    }];

    const { samples } = buildPerturbationDataset(cases, { applicableOnly: true });
    const kinds = new Set(samples.map((sample) => sample.kind));

    assert.equal(kinds.has("critical_drop"), false);
    assert.equal(kinds.has("laterality_flip"), false);
    assert.equal(kinds.has("negation_drop"), true);
    assert.equal(kinds.has("structure_break"), true);
  });

  it("dataset is deterministic across runs", () => {
    const cases = [makeCase("X", ["pneumotórax direito"])];
    const a = buildPerturbationDataset(cases);
    const b = buildPerturbationDataset(cases);
    assert.deepEqual(a.samples.map((s) => s.text), b.samples.map((s) => s.text));
  });

  it("end-to-end: when bench scores low on perturbed outputs, summarize as caught", () => {
    const cases = [makeCase("E1", ["hematoma agudo"])];
    const { links } = buildPerturbationDataset(cases);

    // Simulate a perfect bench: every dim drops below severity floor for every perturbation
    const failingResults: CaseRunResult[] = links.slice(0, 8).map((l) =>
      makeResult({
        id: l.predictionId,
        combined: { CRIT: 30, QUAL: 50, TERM: 40, GUIDE: 50, RAG: 30 },
      }),
    );
    const run = makeSuiteRun(failingResults);
    const summary = summarizePerturbationRun(run, links);
    assert.equal(summary.overallCatchRate, 100);
    assert.equal(summary.verdict, "robust");
  });

  it("end-to-end: when bench scores perfect on perturbed outputs, summarize as broken", () => {
    const cases = [makeCase("E2", ["pneumotórax direito"])];
    const { links } = buildPerturbationDataset(cases);

    const passingResults: CaseRunResult[] = links.map((l) =>
      makeResult({ id: l.predictionId, combined: { CRIT: 95, QUAL: 95, TERM: 95, GUIDE: 95, RAG: 95 } }),
    );
    const run = makeSuiteRun(passingResults);
    const summary = summarizePerturbationRun(run, links);
    assert.equal(summary.overallCatchRate, 0);
    assert.equal(summary.verdict, "broken");
  });

  it("end-to-end: mixed catch — some kinds caught, some leak (per-kind sub-runs)", () => {
    const cases = [makeCase("E3", ["hematoma agudo direito"]), makeCase("E4", ["pneumotórax direito"])];
    const { links } = buildPerturbationDataset(cases);
    const caughtKinds = new Set(["negation_drop", "negation_insert", "critical_drop", "critical_invent", "laterality_flip"]);

    const allOutcomes: Array<{ kind: string; caught: boolean }> = [];
    for (const kind of new Set(links.map((l) => l.kind))) {
      const subset = links.filter((l) => l.kind === kind);
      const results: CaseRunResult[] = subset.map((l) =>
        makeResult({
          id: l.predictionId,
          combined: caughtKinds.has(kind)
            ? { CRIT: 30, QUAL: 95, TERM: 95, GUIDE: 95, RAG: 30 }
            : { CRIT: 95, QUAL: 95, TERM: 95, GUIDE: 95, RAG: 95 },
        }),
      );
      const run = makeSuiteRun(results);
      const summary = summarizePerturbationRun(run, subset);
      for (const k of summary.perKind) for (let i = 0; i < k.n; i++) allOutcomes.push({ kind: k.kind, caught: i < k.caught });
    }

    const total = allOutcomes.length;
    const caught = allOutcomes.filter((o) => o.caught).length;
    const rate = (caught / total) * 100;
    // 5 of 8 kinds × 2 cases = 10 caught of 16 → 62.5%
    assert.ok(rate > 0 && rate < 100);
    assert.equal(rate, 62.5);
  });

  it("isPerturbationCaught honors severity floor (major → 80)", () => {
    const result = makeResult({ id: "x", combined: { RAG: 75, QUAL: 75 } });
    assert.equal(isPerturbationCaught(PERTURBATIONS.measurement_scramble, result), true);
  });
});
