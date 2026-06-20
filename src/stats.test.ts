import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chi2CDFForTest, mcNemarTest } from "./stats.js";

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

describe("chi2CDF / regularizedGammaP numerics", () => {
  it("matches the df=1 closed form erf(sqrt(x/2))", () => {
    for (const x of [0.5, 3.84, 10]) {
      assert.ok(Math.abs(chi2CDFForTest(x, 1) - erf(Math.sqrt(x / 2))) < 1e-6, `df=1 at x=${x}`);
    }
  });

  it("matches the df=2 closed form 1 - exp(-x/2) (formerly-broken continued-fraction branch)", () => {
    for (const x of [2, 4, 6]) {
      assert.ok(Math.abs(chi2CDFForTest(x, 2) - (1 - Math.exp(-x / 2))) < 1e-6, `df=2 at x=${x}`);
    }
  });

  it("returns sane reference values for half-integer a (df=1, df=3) instead of ~1e27 garbage", () => {
    assert.ok(Math.abs(chi2CDFForTest(3.84, 1) - 0.949957) < 1e-3);
    assert.ok(Math.abs(chi2CDFForTest(10, 1) - 0.998434) < 1e-3);
    assert.ok(Math.abs(chi2CDFForTest(6, 3) - 0.888389) < 1e-3);
  });

  it("stays a probability in [0,1] and is monotincreasing across df", () => {
    for (const df of [1, 2, 3, 4]) {
      let prev = -1;
      for (const x of [0.1, 1, 3, 6, 12, 30]) {
        const p = chi2CDFForTest(x, df);
        assert.ok(p >= 0 && p <= 1, `p in range df=${df} x=${x} got ${p}`);
        assert.ok(p >= prev - 1e-9, `monotone df=${df} x=${x}`);
        prev = p;
      }
    }
  });

  it("mcNemarTest large-n path (df=1) yields a valid p-value", () => {
    const a = Array.from({ length: 60 }, (_, i) => i % 4 !== 0);
    const b = Array.from({ length: 60 }, (_, i) => i % 3 === 0);
    const r = mcNemarTest(a, b);
    assert.ok(r.pValue >= 0 && r.pValue <= 1);
  });
});
