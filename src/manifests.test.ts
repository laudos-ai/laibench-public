import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSuiteHash } from "./manifests.js";
import type { BenchCase } from "./types.js";

const base: BenchCase = {
  id: "C1",
  exam: "CT chest",
  findings: "small nodule RUL",
  locale: "en-US",
  criticalFindings: ["pulmonary embolism"],
  goldFindings: [{ finding: "nodule", severity: "minor", laterality: "right" }],
  referenceReport: "<b>Findings</b> nodule",
};

describe("computeSuiteHash", () => {
  it("is deterministic for identical content", async () => {
    assert.equal(await computeSuiteHash([base]), await computeSuiteHash([{ ...base }]));
  });

  it("is invariant to object key order", async () => {
    const reordered: BenchCase = { findings: base.findings, exam: base.exam, id: base.id, locale: base.locale, referenceReport: base.referenceReport, criticalFindings: base.criticalFindings, goldFindings: base.goldFindings };
    assert.equal(await computeSuiteHash([base]), await computeSuiteHash([reordered]));
  });

  it("changes when the prompt changes", async () => {
    assert.notEqual(await computeSuiteHash([base]), await computeSuiteHash([{ ...base, findings: "large mass RUL" }]));
  });

  it("changes when a critical finding (answer key) is swapped", async () => {
    const tampered: BenchCase = { ...base, criticalFindings: ["aortic dissection"] };
    assert.notEqual(await computeSuiteHash([base]), await computeSuiteHash([tampered]));
  });

  it("changes when a gold finding severity is flipped", async () => {
    const tampered: BenchCase = { ...base, goldFindings: [{ finding: "nodule", severity: "critical", laterality: "right" }] };
    assert.notEqual(await computeSuiteHash([base]), await computeSuiteHash([tampered]));
  });

  it("changes when the reference report is edited", async () => {
    const tampered: BenchCase = { ...base, referenceReport: "<b>Findings</b> normal" };
    assert.notEqual(await computeSuiteHash([base]), await computeSuiteHash([tampered]));
  });
});
