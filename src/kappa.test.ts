import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cohensKappa, fleissKappa, krippendorffAlphaInterval, pairedBootstrap, interpretKappa, interpretAlpha } from "./kappa.js";

describe("cohensKappa", () => {
  it("returns kappa=1 when raters agree perfectly", () => {
    const r = cohensKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]);
    assert.equal(r.kappa, 1);
    assert.equal(r.po, 1);
  });

  it("returns kappa=0 when agreement equals chance", () => {
    // 50/50 random agreement on binary categories
    const a = ["a", "a", "b", "b"];
    const b = ["a", "b", "a", "b"];
    const r = cohensKappa(a, b);
    assert.equal(r.po, 0.5);
    assert.ok(Math.abs(r.kappa) < 0.01);
  });

  it("returns negative kappa when disagreement exceeds chance", () => {
    const a = ["a", "b", "a", "b", "a", "b"];
    const b = ["b", "a", "b", "a", "b", "a"];
    const r = cohensKappa(a, b);
    assert.ok(r.kappa < 0);
  });

  it("throws on length mismatch", () => {
    assert.throws(() => cohensKappa(["a"], ["a", "b"]));
  });

  it("interpretKappa produces Landis-Koch labels", () => {
    assert.equal(interpretKappa(-0.1), "poor");
    assert.equal(interpretKappa(0.1), "slight");
    assert.equal(interpretKappa(0.3), "fair");
    assert.equal(interpretKappa(0.5), "moderate");
    assert.equal(interpretKappa(0.7), "substantial");
    assert.equal(interpretKappa(0.9), "almost perfect");
  });
});

describe("fleissKappa", () => {
  it("returns kappa=1 when all raters agree on every item", () => {
    const ratings = [
      ["x", "x", "x"],
      ["y", "y", "y"],
      ["z", "z", "z"],
    ];
    const r = fleissKappa(ratings);
    assert.equal(r.kappa, 1);
  });

  it("returns near-0 when ratings are random", () => {
    const ratings = [
      ["a", "b", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
    ];
    const r = fleissKappa(ratings);
    assert.ok(r.kappa < 0.5);
  });

  it("throws on inconsistent rater counts", () => {
    assert.throws(() => fleissKappa([["a", "b"], ["a"]]));
  });

  it("throws when raters < 2", () => {
    assert.throws(() => fleissKappa([["a"], ["b"]]));
  });
});

describe("krippendorffAlphaInterval", () => {
  it("returns alpha=1 when all raters give identical scores", () => {
    const ratings = [
      [80, 80, 80],
      [60, 60, 60],
      [90, 90, 90],
    ];
    const r = krippendorffAlphaInterval(ratings);
    assert.equal(r.alpha, 1);
  });

  it("decreases alpha as rater disagreement grows", () => {
    const close = krippendorffAlphaInterval([[80, 82], [60, 58], [90, 91]]);
    const wide = krippendorffAlphaInterval([[80, 50], [60, 90], [90, 30]]);
    assert.ok(close.alpha > wide.alpha);
  });

  it("handles missing values (NaN) gracefully", () => {
    const r = krippendorffAlphaInterval([[80, 80, NaN], [60, 60, 60], [NaN, 90, 90]]);
    assert.ok(Number.isFinite(r.alpha));
  });

  it("interpretAlpha produces convention labels", () => {
    assert.equal(interpretAlpha(-0.1), "no agreement");
    assert.equal(interpretAlpha(0.5), "tentative");
    assert.equal(interpretAlpha(0.7), "acceptable");
    assert.equal(interpretAlpha(0.85), "high");
  });
});

describe("pairedBootstrap", () => {
  it("returns meanDiff=0 when arrays are identical", () => {
    const r = pairedBootstrap([80, 70, 90], [80, 70, 90]);
    assert.equal(r.meanDiff, 0);
    assert.ok(r.lower <= 0 && r.upper >= 0);
  });

  it("detects positive shift with significance when A consistently beats B", () => {
    const a = Array.from({ length: 50 }, () => 90);
    const b = Array.from({ length: 50 }, () => 70);
    const r = pairedBootstrap(a, b);
    assert.equal(r.meanDiff, 20);
    assert.ok(r.lower > 0);
    assert.ok(r.pValue < 0.05);
  });

  it("returns CI containing 0 when paired diffs are noisy", () => {
    const a = Array.from({ length: 30 }, (_, i) => 70 + (i % 5));
    const b = Array.from({ length: 30 }, (_, i) => 70 + ((i + 2) % 5));
    const r = pairedBootstrap(a, b);
    assert.ok(r.lower <= 0 && r.upper >= 0);
  });

  it("is deterministic given same seed", () => {
    const a = [70, 80, 75, 90, 60];
    const b = [60, 75, 70, 85, 55];
    const r1 = pairedBootstrap(a, b, 1000, 0.05, 1);
    const r2 = pairedBootstrap(a, b, 1000, 0.05, 1);
    assert.deepEqual(r1, r2);
  });

  it("throws on length mismatch", () => {
    assert.throws(() => pairedBootstrap([1, 2], [1]));
  });
});
