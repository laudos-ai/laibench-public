import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KeywordCriticalExtractor,
  GreenCriticalExtractor,
  getDefaultCriticalExtractor,
  setDefaultCriticalExtractor,
  type CriticalDetection,
} from "./critical-extractor.js";

describe("KeywordCriticalExtractor", () => {
  const ex = new KeywordCriticalExtractor();

  it("identifies a preserved critical finding (recall=1)", () => {
    const r = ex.detect(["pneumothorax"], "<p>Large right pneumothorax is present.</p>", "en-US");
    assert.deepEqual(r.truePositives, ["pneumothorax"]);
    assert.equal(r.falseNegatives.length, 0);
    assert.equal(r.recall, 1);
  });

  it("flags a dropped critical finding (recall=0)", () => {
    const r = ex.detect(["pneumothorax"], "<p>Unremarkable study.</p>", "en-US");
    assert.deepEqual(r.falseNegatives, ["pneumothorax"]);
    assert.equal(r.recall, 0);
  });

  it("treats a negated mention as a miss, not a hit", () => {
    // en-US negation patterns: "no evidence of", "without", "absent",
    // "negative for", "no signs/findings of" (bare "no X" is intentionally NOT negation).
    const r = ex.detect(["pneumothorax"], "<p>No evidence of pneumothorax.</p>", "en-US");
    assert.equal(r.recall, 0, "negated mention must count as a false negative");
    assert.deepEqual(r.falseNegatives, ["pneumothorax"]);
  });

  it("rejects wrong-side critical mentions as misses and false positives", () => {
    const r = ex.detect(["right pneumothorax"], "<p>Large left pneumothorax is present.</p>", "en-US");
    assert.deepEqual(r.truePositives, []);
    assert.deepEqual(r.falseNegatives, ["right pneumothorax"]);
    assert.equal(r.falsePositives.length, 1);
    assert.match(r.falsePositives[0].text, /left pneumothorax/i);
  });

  it("is unvalidated and self-identifies", () => {
    assert.equal(ex.validated, false);
    assert.equal(ex.name, "keyword-substring-v1");
  });
});

describe("GreenCriticalExtractor", () => {
  it("throws when used without a configured client", () => {
    const green = new GreenCriticalExtractor();
    assert.equal(green.name, "green:unconfigured");
    assert.throws(() => green.detect(["x"], "<p>x</p>", "en-US"), /no GREEN-like client configured/);
  });

  it("delegates to an injected client and reports its name", () => {
    const stub: CriticalDetection = { truePositives: ["x"], falseNegatives: [], falsePositives: [], recall: 1, precision: 1, f1: 1 };
    const green = new GreenCriticalExtractor({ name: "stub-model", detect: () => stub }, true);
    assert.equal(green.name, "green:stub-model");
    assert.equal(green.validated, true);
    assert.deepEqual(green.detect(["x"], "<p>x</p>", "en-US"), stub);
  });
});

describe("default extractor registry", () => {
  it("defaults to the keyword extractor and can be swapped + restored", () => {
    const original = getDefaultCriticalExtractor();
    try {
      assert.ok(original instanceof KeywordCriticalExtractor);
      const sentinel: CriticalDetection = { truePositives: [], falseNegatives: ["z"], falsePositives: [], recall: 0, precision: 1, f1: 0 };
      setDefaultCriticalExtractor(new GreenCriticalExtractor({ name: "sentinel", detect: () => sentinel }, true));
      assert.equal(getDefaultCriticalExtractor().name, "green:sentinel");
      assert.deepEqual(getDefaultCriticalExtractor().detect(["z"], "<p></p>", "en-US"), sentinel);
    } finally {
      setDefaultCriticalExtractor(original);
    }
    assert.ok(getDefaultCriticalExtractor() instanceof KeywordCriticalExtractor);
  });
});
