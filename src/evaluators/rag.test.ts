import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStructuralChecks } from "./structural.js";
import { evaluateRetrieval } from "./rag.js";
import type { BenchCase, ExamMeta, LocaleKey } from "../types.js";

// Hygiene fix (qual-structural-guide-rag-3): the RAG fabricated-acquisition
// check must NOT reuse id 'R04'. structuralRagFallbackChecks retains the
// structural R04 ("Measurements preserved in body") because it only filters
// R05, so reusing 'R04' produced a single EvaluatorResult containing two
// distinct checks with the same id. These tests pin that no EvaluatorResult
// emits duplicate check ids on the RAG structural-fallback path.

function meta(overrides: Partial<ExamMeta> = {}): ExamMeta {
  return {
    modality: "CT", contrast: false, region: "abdomen",
    normalizedExam: "", normalizedFindings: "", abnormalStudy: true,
    expectedTitleTokens: [], expectedRegionTokens: [], ...overrides,
  };
}

function ragResult(findingsInput: string, html: string, locale: LocaleKey = "pt-BR") {
  const benchCase: BenchCase = {
    id: "r", exam: "tc abdome", findings: findingsInput, locale,
    // no retrievalGold -> evaluateRetrieval takes the structural-fallback path
  };
  const structuralChecks = runStructuralChecks(html, meta(), findingsInput, locale);
  return evaluateRetrieval(html, benchCase, locale, meta(), structuralChecks);
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  return [...dups];
}

describe("RAG EvaluatorResult has no duplicate check ids", () => {
  it("does not emit two checks sharing id 'R04' when both the measurement and acquisition checks fire", () => {
    // Input has a measurement -> structural R04 ("Measurements preserved in body").
    // Report omits that measurement (so R04 is present and failing) AND fabricates
    // an acquisition detail ("axial") that is absent from the source -> the
    // fabricated-acquisition check fires too. Before the fix both were id 'R04'.
    const findingsInput = "massa de 2 cm.";
    const html = "<b>Análise</b><br>massa em corte axial.<br><br><b>Conclusão</b><br>massa.";
    const result = ragResult(findingsInput, html);

    const ids = result.checks.map((c) => c.id);
    assert.deepEqual(duplicateIds(ids), [], `duplicate check ids: ${duplicateIds(ids).join(", ")} (ids=${ids.join(", ")})`);

    // Both checks must still be present, under DISTINCT ids.
    const measurementCheck = result.checks.find((c) => c.name === "Measurements preserved in body");
    const acquisitionCheck = result.checks.find((c) => c.name === "No unsupported acquisition details");
    assert.ok(measurementCheck, "structural measurement check (R04) must be retained");
    assert.ok(acquisitionCheck, "fabricated-acquisition check must be retained");
    assert.notEqual(measurementCheck!.id, acquisitionCheck!.id, "the two checks must have different ids");
    assert.equal(measurementCheck!.id, "R04");
    assert.notEqual(acquisitionCheck!.id, "R04");
  });

  it("holds the no-duplicate-id invariant on the en-US path too", () => {
    const findingsInput = "2 cm mass.";
    const html = "<b>Findings</b><br>mass on axial images.<br><br><b>Impression</b><br>mass.";
    const result = ragResult(findingsInput, html, "en-US");
    const ids = result.checks.map((c) => c.id);
    assert.deepEqual(duplicateIds(ids), [], `duplicate check ids: ${duplicateIds(ids).join(", ")} (ids=${ids.join(", ")})`);
  });
});
