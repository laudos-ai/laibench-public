import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditReleaseFiles } from "./release-guard.js";
import type { AdjudicationRecord } from "./adjudication.js";

const PUBLISHED_HASH = "b7f412e25a71352072d525c9bee9d7630818eb09996d172e9c2664224d7b2217";

// The overclaiming disclosure that FIX 1 removed: it states the PUBLIC demo cases
// were "authored and clinically reviewed" by radiologists — a clinical-validation
// claim that contradicts README/policy and has no signed adjudication backing it.
const OVERCLAIM_DATA_JS =
  'window.LAIBENCH_DATA = {"locales":{"pt-BR":{"suiteHash":"' + PUBLISHED_HASH + '",' +
  '"disclosure":"Public demonstration cases are synthetic and were authored and clinically reviewed by senior radiologists in Sao Paulo, SP, Brazil."}}};\n';

// The truthful, reworded disclosure (FIX 1): public demo cases are input-only and
// NOT clinically reviewed; the controlled suite review is scoped as internal
// data-quality, explicitly not an independent third-party validation.
const TRUTHFUL_DATA_JS =
  'window.LAIBENCH_DATA = {"locales":{"pt-BR":{"suiteHash":"' + PUBLISHED_HASH + '",' +
  '"disclosure":"The public demonstration cases are synthetic and input-only; they were not clinically reviewed and must not be used to claim clinical validation. The controlled pt-BR suite is synthetic and was authored and reviewed by senior radiologists in Sao Paulo, SP, Brazil as an internal data-quality process; this is not an independent third-party validation. Independent external adjudication is tracked as future work and is not claimed here."}}};\n';

function validAdjudicationRecord(suiteHash: string): AdjudicationRecord {
  const label = (reviewerId: string) => ({
    reviewerId,
    clinicallyAcceptable: true,
    dimensionVerdicts: { CRIT: "PASS", QUAL: "PASS", TERM: "PASS", GUIDE: "PASS", RAG: "PASS" } as const,
    notes: "All target findings, polarity, laterality, and measurements reviewed.",
    signedAt: "2026-06-14T12:00:00.000Z",
  });
  return {
    schemaVersion: "1.0",
    suiteId: "lite-public.pt-BR",
    suiteHash,
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

describe("auditReleaseFiles", () => {
  it("blocks raw private corpus files in private and public modes", () => {
    const issues = auditReleaseFiles([{ path: "data/private/clean_42k.csv" }], "private");
    assert.ok(issues.some((issue) => issue.rule === "raw-data-extension" && issue.severity === "error"));
    assert.ok(issues.some((issue) => issue.rule === "private-corpus-name" && issue.severity === "error"));
  });

  it("warns for tracked private case paths in private mode", () => {
    const issues = auditReleaseFiles([{ path: "cases/private/synthetic-demo.pt-BR.json", content: "[]" }], "private");
    assert.ok(issues.some((issue) => issue.rule === "private-path-tracked" && issue.severity === "warn"));
    assert.equal(issues.some((issue) => issue.severity === "error"), false);
  });

  it("blocks private paths and merged CSV markers in public mode", () => {
    const issues = auditReleaseFiles([
      { path: "cases/private/synthetic-demo.pt-BR.json", content: "[]" },
      { path: "leaderboard/frozen/reference-pt-BR.jsonl", content: '{"instance_id":"MERGED-PTBR-001"}' },
    ], "public");
    assert.ok(issues.some((issue) => issue.rule === "private-path-public-release"));
    assert.ok(issues.some((issue) => issue.rule === "public-derived-marker"));
  });

  it("does not flag documentation that describes private-derived marker rules", () => {
    const issues = auditReleaseFiles([
      { path: "README.md", content: "Do not publish MERGED-PTBR fixtures or merged-csv artifacts." },
    ], "public");
    assert.equal(issues.some((issue) => issue.rule === "public-derived-marker"), false);
  });

  it("blocks answer keys in public case files", () => {
    const issues = auditReleaseFiles([
      { path: "cases/public/synthetic-demo.en-US.json", content: '[{"goldFindings":[],"referenceReport":"x"}]' },
    ], "public");
    assert.ok(issues.some((issue) => issue.rule === "public-answer-key"));
  });

  it("allows small synthetic public docs in private mode", () => {
    const issues = auditReleaseFiles([
      { path: "cases/public/synthetic-demo.en-US.json", content: '[{"synthetic":true}]' },
      { path: "README.md", content: "No secrets here." },
    ], "private");
    assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
  });

  // --- Adjudication-claim gate (FIX 2: integrity-disclosure-3, gap-1/gap-2) ---

  it("blocks an unsubstantiated clinical-validation claim in a public artifact (the old overclaim)", () => {
    // This is the escape: site/data.js claims the PUBLIC cases were clinically
    // reviewed, with no signed adjudication record in the release set.
    const issues = auditReleaseFiles([{ path: "site/data.js", content: OVERCLAIM_DATA_JS }], "public");
    assert.ok(
      issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim" && issue.severity === "error"),
      "overclaiming disclosure with no adjudication record must be blocked in public mode",
    );
  });

  it("does NOT block the same overclaim in private mode (public gate only)", () => {
    const issues = auditReleaseFiles([{ path: "site/data.js", content: OVERCLAIM_DATA_JS }], "private");
    assert.equal(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim"), false);
  });

  it("allows the clinical-validation claim only when a signed adjudication record backs the published suiteHash", () => {
    const issues = auditReleaseFiles([
      { path: "site/data.js", content: OVERCLAIM_DATA_JS },
      { path: "private-adjudication.json", content: JSON.stringify(validAdjudicationRecord(PUBLISHED_HASH)) },
    ], "public");
    assert.equal(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim"), false);
  });

  it("still blocks when the adjudication record is for a DIFFERENT suiteHash than the published one", () => {
    const issues = auditReleaseFiles([
      { path: "site/data.js", content: OVERCLAIM_DATA_JS },
      { path: "private-adjudication.json", content: JSON.stringify(validAdjudicationRecord("deadbeef00000000")) },
    ], "public");
    assert.ok(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim" && issue.severity === "error"));
  });

  it("still blocks when the adjudication record exists but is invalid (single reviewer)", () => {
    const record = validAdjudicationRecord(PUBLISHED_HASH);
    record.adjudicators = ["rad-1"];
    record.cases = record.cases.map((c) => ({ ...c, reviewerLabels: [c.reviewerLabels[0]] }));
    const issues = auditReleaseFiles([
      { path: "site/data.js", content: OVERCLAIM_DATA_JS },
      { path: "private-adjudication.json", content: JSON.stringify(record) },
    ], "public");
    assert.ok(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim" && issue.severity === "error"));
  });

  it("does NOT flag the truthful, internal-data-quality-scoped disclosure", () => {
    // The FIX 1 wording: honest, negated, internal-review-only — no validation claim.
    const issues = auditReleaseFiles([{ path: "site/data.js", content: TRUTHFUL_DATA_JS }], "public");
    assert.equal(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim"), false);
  });

  it("flags an affirmative clinical-validation claim in leaderboard markdown too", () => {
    const issues = auditReleaseFiles([
      { path: "leaderboard/README.md", content: "All scored cases were independently validated by third-party radiologists." },
    ], "public");
    assert.ok(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim" && issue.severity === "error"));
  });

  it("does NOT flag documentation that merely warns against unverified validation claims", () => {
    // Negated/cautionary prose ("must not claim clinical validation") is not a claim.
    const issues = auditReleaseFiles([
      { path: "leaderboard/README.md", content: "Public cases must not be used to claim clinical validation and were not clinically reviewed." },
    ], "public");
    assert.equal(issues.some((issue) => issue.rule === "unsubstantiated-clinical-validation-claim"), false);
  });
});
