/**
 * Pure TypeScript statistical utilities for benchmark analysis.
 * No external dependencies.
 */

/**
 * Seeded pseudo-random number generator (xoshiro128** variant).
 * Produces deterministic sequences given a seed, suitable for reproducible bootstrap resampling.
 */
function splitmix32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x9e3779b9) | 0;
    let t = seed ^ (seed >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Compute a bootstrap confidence interval for the mean of a set of scores.
 *
 * @param scores     Array of numeric scores (e.g., per-case overall scores)
 * @param nResamples Number of bootstrap resamples (default: 10000)
 * @param alpha      Significance level (default: 0.05 for 95% CI)
 * @param seed       Optional seed for reproducibility (default: 42)
 * @returns          Object with mean, lower, and upper bounds of the CI
 */
export function bootstrapCI(
  scores: number[],
  nResamples = 10000,
  alpha = 0.05,
  seed = 42,
): { mean: number; lower: number; upper: number } {
  const n = scores.length;
  if (n === 0) return { mean: 0, lower: 0, upper: 0 };
  if (n === 1) return { mean: scores[0], lower: scores[0], upper: scores[0] };

  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const rng = splitmix32(seed);
  const resampledMeans: number[] = new Array(nResamples);

  for (let r = 0; r < nResamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sum += scores[idx];
    }
    resampledMeans[r] = sum / n;
  }

  resampledMeans.sort((a, b) => a - b);

  const lowerIdx = Math.floor((alpha / 2) * nResamples);
  const upperIdx = Math.floor((1 - alpha / 2) * nResamples) - 1;

  return {
    mean: round6(mean),
    lower: round6(resampledMeans[Math.max(0, lowerIdx)]),
    upper: round6(resampledMeans[Math.min(nResamples - 1, upperIdx)]),
  };
}

/**
 * McNemar's test for paired nominal data.
 * Compares two binary classifiers on the same dataset.
 *
 * Given paired boolean arrays a and b (e.g., "did model A get case i correct?"),
 * tests whether the disagreements are symmetric.
 *
 * @param a Array of booleans (model A correct per case)
 * @param b Array of booleans (model B correct per case)
 * @returns chi2 statistic and approximate p-value (1 df chi-squared)
 */
export function mcNemarTest(
  a: boolean[],
  b: boolean[],
): { chi2: number; pValue: number } {
  if (a.length !== b.length) {
    throw new Error(`mcNemarTest: arrays must have equal length (got ${a.length} vs ${b.length})`);
  }

  // Count discordant pairs
  let bNotA = 0; // b correct, a wrong
  let aNotB = 0; // a correct, b wrong

  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) aNotB++;
    if (!a[i] && b[i]) bNotA++;
  }

  const total = aNotB + bNotA;
  if (total === 0) return { chi2: 0, pValue: 1 };

  // McNemar chi-squared with continuity correction
  const chi2 = ((Math.abs(aNotB - bNotA) - 1) ** 2) / total;
  const pValue = 1 - chi2CDF(chi2, 1);

  return {
    chi2: round6(chi2),
    pValue: round6(Math.max(0, Math.min(1, pValue))),
  };
}

/**
 * Cohen's h effect size for comparing two proportions.
 * Uses the arcsine transformation: h = 2 * arcsin(sqrt(p1)) - 2 * arcsin(sqrt(p2))
 *
 * Interpretation (absolute value):
 *   |h| < 0.2  = small
 *   |h| < 0.5  = medium
 *   |h| < 0.8  = large
 *   |h| >= 0.8 = very large
 *
 * @param p1 Proportion for group 1 (0-1)
 * @param p2 Proportion for group 2 (0-1)
 * @returns Cohen's h value (positive means p1 > p2)
 */
export function cohensH(p1: number, p2: number): number {
  if (p1 < 0 || p1 > 1 || p2 < 0 || p2 > 1) {
    throw new Error(`cohensH: proportions must be in [0,1] (got ${p1}, ${p2})`);
  }
  const h = 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));
  return round6(h);
}

// ---- Internal helpers ----

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Approximate CDF of the chi-squared distribution using the
 * regularized incomplete gamma function.
 * For df=1 (McNemar's test), this simplifies to: P(X <= x) = erf(sqrt(x/2))
 */
function chi2CDF(x: number, df: number): number {
  if (x <= 0) return 0;
  if (df === 1) {
    // Special case: chi2 with 1 df = P(X<=x) = erf(sqrt(x/2))
    return erf(Math.sqrt(x / 2));
  }
  // General case using regularized lower incomplete gamma
  return regularizedGammaP(df / 2, x / 2);
}

/**
 * Error function approximation (Abramowitz & Stegun 7.1.26).
 * Maximum error: 1.5e-7
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

/**
 * Regularized lower incomplete gamma function P(a, x).
 * Uses series expansion for small x, continued fraction for large x.
 */
function regularizedGammaP(a: number, x: number): number {
  if (x < 0) return 0;
  if (x === 0) return 0;

  if (x < a + 1) {
    // Series expansion
    let sum = 1 / a;
    let term = 1 / a;
    for (let n = 1; n < 200; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }

  // Continued fraction (Lentz's method)
  let f = 1e-30;
  let c = 1e-30;
  let d = 1 / (x + 1 - a);
  let h = d;
  for (let n = 1; n < 200; n++) {
    const an = -n * (n - a);
    const bn = x + 2 * n + 1 - a;
    d = 1 / (bn + an * d);
    c = bn + an / c;
    const delta = c * d;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }

  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/**
 * Log-gamma function using Stirling's approximation (Lanczos).
 */
function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }

  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) {
    a += c[i] / (x + i);
  }

  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
