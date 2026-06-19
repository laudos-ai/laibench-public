import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runStructuralChecks } from "./structural.js";
import { evaluateQuality } from "./qual.js";
import type { BenchCase, ExamMeta, LocaleKey } from "../types.js";

// Measurement preservation must be EXACT, not naive substring containment.
// Before the fix, gold "2 cm" scored as preserved inside a report stating
// "12 cm" (a tenfold size error counted as a correct measurement). These tests
// pin the fix at both call sites: R04 (RAG, structural) and QG04 (QUAL, gold).

function meta(overrides: Partial<ExamMeta> = {}): ExamMeta {
  return {
    modality: "CT", contrast: false, region: "abdomen",
    normalizedExam: "", normalizedFindings: "", abnormalStudy: true,
    expectedTitleTokens: [], expectedRegionTokens: [], ...overrides,
  };
}

function r04(findingsInput: string, html: string, locale: LocaleKey = "pt-BR") {
  return runStructuralChecks(html, meta(), findingsInput, locale).find((c) => c.id === "R04");
}

function qg04(measurement: string, reportHtml: string, locale: LocaleKey = "pt-BR") {
  const benchCase: BenchCase = {
    id: "m", exam: "tc abdome", findings: "massa", locale,
    goldFindings: [{ finding: "massa", severity: "major", measurements: [measurement] }],
  };
  return evaluateQuality(reportHtml, benchCase, locale, meta(), []).checks.find((c) => c.id === "QG04");
}

describe("R04 measurement preservation is exact, not substring", () => {
  it("FAILS a tenfold size error: gold 2 cm vs report 12 cm", () => {
    const c = r04("massa de 2 cm.", "<b>Análise</b><br>massa de 12 cm.<br><br><b>Conclusão</b><br>massa.");
    assert.ok(c, "R04 must be emitted when the input has a measurement");
    assert.equal(c!.passed, false, c!.evidence);
  });

  it("FAILS gold 3 mm vs report 13 mm", () => {
    assert.equal(r04("nódulo de 3 mm.", "<b>Análise</b><br>nódulo de 13 mm.<br><br><b>Conclusão</b><br>x.")?.passed, false);
  });

  it("FAILS the decimal collision gold 1,5 cm vs report 11,5 cm", () => {
    assert.equal(r04("lesão de 1,5 cm.", "<b>Análise</b><br>lesão de 11,5 cm.<br><br><b>Conclusão</b><br>x.")?.passed, false);
  });

  it("PASSES a true match (gold 2 cm vs report 2 cm)", () => {
    assert.equal(r04("massa de 2 cm.", "<b>Análise</b><br>massa de 2 cm.<br><br><b>Conclusão</b><br>x.")?.passed, true);
  });

  it("PASSES comma/dot and trailing .0 normalization", () => {
    assert.equal(r04("lesão de 1.5 cm.", "<b>Análise</b><br>lesão de 1,5 cm.<br><br><b>Conclusão</b><br>x.")?.passed, true);
    assert.equal(r04("massa de 2 cm.", "<b>Análise</b><br>massa de 2.0 cm.<br><br><b>Conclusão</b><br>x.")?.passed, true);
  });

  it("holds the size-error verdict on the en-US path too (parity)", () => {
    assert.equal(r04("2 cm mass.", "<b>Findings</b><br>12 cm mass.<br><br><b>Impression</b><br>x.", "en-US")?.passed, false);
  });
});

describe("QG04 measurement preservation is exact, not substring", () => {
  it("FAILS a tenfold size error: gold 2 cm vs report 12 cm", () => {
    const c = qg04("2 cm", "<b>Análise</b><br>massa de 12 cm.<br><br><b>Conclusão</b><br>massa de 12 cm.");
    assert.ok(c, "QG04 must be emitted when gold has measurements");
    assert.equal(c!.passed, false, c!.evidence);
  });

  it("PASSES an exact multi-axis measurement (18x12x15mm vs 18 x 12 x 15 mm)", () => {
    const c = qg04("18x12x15mm", "<b>Análise</b><br>massa de 18 x 12 x 15 mm.<br><br><b>Conclusão</b><br>massa.");
    assert.equal(c?.passed, true, c?.evidence);
  });
});
