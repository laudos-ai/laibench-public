import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAdjudicationRecord, type AdjudicationRecord } from "./adjudication.js";

function validRecord(): AdjudicationRecord {
  const label = (reviewerId: string) => ({
    reviewerId,
    clinicallyAcceptable: true,
    dimensionVerdicts: { CRIT: "PASS", QUAL: "PASS", TERM: "PASS", GUIDE: "PASS", RAG: "PASS" } as const,
    notes: "All target findings, polarity, laterality, and measurements reviewed.",
    signedAt: "2026-06-14T12:00:00.000Z",
  });
  return {
    schemaVersion: "1.0",
    suiteId: "private-suite",
    suiteHash: "abc123",
    lockedAt: "2026-06-14T11:00:00.000Z",
    caseIds: ["case-1", "case-2"],
    adjudicators: ["rad-1", "rad-2"],
    cases: ["case-1", "case-2"].map((caseId) => ({
      caseId,
      goldFindingsReviewed: true,
      criticalFindingsReviewed: true,
      guidelineExpectationsReviewed: true,
      polarityReviewed: true,
      lateralityReviewed: true,
      measurementsReviewed: true,
      criticalResultPolicyReviewed: true,
      reviewerLabels: [label("rad-1"), label("rad-2")],
    })),
  };
}

describe("validateAdjudicationRecord", () => {
  it("accepts a complete two-radiologist adjudication record", () => {
    const result = validateAdjudicationRecord(validRecord(), { suiteId: "private-suite", suiteHash: "abc123" });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.metrics.clinicalAcceptabilityAgreement, 100);
    assert.equal(result.metrics.perDimensionExactAgreement, 100);
  });

  it("rejects missing item-level polarity/laterality/measurement review", () => {
    const record = validRecord();
    record.cases[0].polarityReviewed = false;
    record.cases[0].lateralityReviewed = false;
    const result = validateAdjudicationRecord(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /polarityReviewed/.test(error)));
    assert.ok(result.errors.some((error) => /lateralityReviewed/.test(error)));
  });

  it("rejects PHI-like reviewer notes and suite hash mismatch", () => {
    const record = validRecord();
    record.cases[0].reviewerLabels[0].notes = "Reviewed prior exam 03/09/2020.";
    const result = validateAdjudicationRecord(record, { suiteHash: "different" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /PHI\/PII-like/.test(error)));
    assert.ok(result.errors.some((error) => /suiteHash mismatch/.test(error)));
  });

  it("rejects low reviewer agreement", () => {
    const record = validRecord();
    record.cases[0].reviewerLabels[1].clinicallyAcceptable = false;
    record.cases[0].reviewerLabels[1].dimensionVerdicts.CRIT = "FAIL";
    record.cases[0].reviewerLabels[1].dimensionVerdicts.QUAL = "FAIL";
    record.cases[0].reviewerLabels[1].dimensionVerdicts.TERM = "FAIL";
    record.cases[0].reviewerLabels[1].dimensionVerdicts.GUIDE = "FAIL";
    record.cases[0].reviewerLabels[1].dimensionVerdicts.RAG = "FAIL";
    const result = validateAdjudicationRecord(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /clinical acceptability agreement/.test(error)));
    assert.ok(result.errors.some((error) => /per-dimension exact agreement/.test(error)));
  });
});
