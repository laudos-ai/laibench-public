/**
 * Inter-rater agreement statistics for benchmark validation.
 *
 * - Cohen's kappa: two raters, nominal categories
 * - Fleiss' kappa: N raters, nominal categories
 * - Krippendorff's alpha: N raters, any scale (interval used here for 0-100 scores)
 *
 * Used to (1) validate gold labels against multi-rater consensus during dataset
 * construction, and (2) measure judge consistency across reruns or across judge
 * models on the same outputs.
 *
 * No external dependencies. All formulae cited inline.
 */

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Cohen's kappa for two raters with nominal categories.
 * κ = (p_o - p_e) / (1 - p_e)
 * where p_o = observed agreement, p_e = expected by chance.
 *
 * Landis & Koch (1977) interpretation:
 *   <0    poor
 *   0-.20 slight
 *   .21-.40 fair
 *   .41-.60 moderate
 *   .61-.80 substantial
 *   .81-1.0 almost perfect
 */
export function cohensKappa(a: string[], b: string[]): { kappa: number; po: number; pe: number; n: number } {
  if (a.length !== b.length) throw new Error(`cohensKappa: arrays must match length (${a.length} vs ${b.length})`);
  const n = a.length;
  if (n === 0) return { kappa: 0, po: 0, pe: 0, n };

  const cats = new Set<string>([...a, ...b]);
  let agree = 0;
  const marginA: Record<string, number> = {};
  const marginB: Record<string, number> = {};
  for (const c of cats) {
    marginA[c] = 0;
    marginB[c] = 0;
  }
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    marginA[a[i]]++;
    marginB[b[i]]++;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of cats) pe += (marginA[c] / n) * (marginB[c] / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa: round6(kappa), po: round6(po), pe: round6(pe), n };
}

/**
 * Fleiss' kappa for N raters per item with nominal categories.
 * Each row of `ratings` lists the category each rater chose for one item.
 * All rows must have the same number of raters.
 *
 * Fleiss (1971): κ = (P̄ - P̄_e) / (1 - P̄_e)
 */
export function fleissKappa(ratings: string[][]): { kappa: number; pBar: number; peBar: number; n: number; raters: number } {
  const n = ratings.length;
  if (n === 0) return { kappa: 0, pBar: 0, peBar: 0, n, raters: 0 };
  const raters = ratings[0].length;
  if (raters < 2) throw new Error(`fleissKappa: need >=2 raters per item, got ${raters}`);

  const cats = new Set<string>();
  for (const row of ratings) {
    if (row.length !== raters) throw new Error(`fleissKappa: inconsistent rater count`);
    for (const c of row) cats.add(c);
  }
  const catList = [...cats];

  // counts[i][k] = number of raters who chose category k for item i
  const counts: number[][] = ratings.map((row) => {
    const c = new Array(catList.length).fill(0) as number[];
    for (const r of row) c[catList.indexOf(r)]++;
    return c;
  });

  // Per-item agreement P_i
  const pi: number[] = counts.map((c) => {
    let s = 0;
    for (const k of c) s += k * (k - 1);
    return s / (raters * (raters - 1));
  });
  const pBar = pi.reduce((a, b) => a + b, 0) / n;

  // Marginal proportion for each category
  const pj: number[] = catList.map((_, k) => {
    let s = 0;
    for (const row of counts) s += row[k];
    return s / (n * raters);
  });
  const peBar = pj.reduce((a, b) => a + b * b, 0);

  const kappa = peBar === 1 ? 1 : (pBar - peBar) / (1 - peBar);
  return { kappa: round6(kappa), pBar: round6(pBar), peBar: round6(peBar), n, raters };
}

/**
 * Krippendorff's alpha for N raters with interval-level data.
 * Handles missing values (NaN). Uses interval distance δ²(c,k) = (c-k)².
 *
 * α = 1 - D_o / D_e
 *   D_o = observed disagreement
 *   D_e = expected disagreement under chance
 *
 * Krippendorff (2011) computational shortcut for interval data.
 *
 * @param ratings  rows = items, cols = raters; use NaN for missing.
 */
export function krippendorffAlphaInterval(ratings: number[][]): { alpha: number; n: number; pairs: number } {
  const n = ratings.length;
  if (n === 0) return { alpha: 0, n, pairs: 0 };

  // Flatten observed values for the expected-disagreement pool.
  const allVals: number[] = [];
  for (const row of ratings) for (const v of row) if (Number.isFinite(v)) allVals.push(v);
  const N = allVals.length;
  if (N < 2) return { alpha: 0, n, pairs: 0 };

  // Observed disagreement (Hayes & Krippendorff 2007), interval metric.
  // Within each unit, every value pair is counted in BOTH orders (i≠j) so the
  // normalization is consistent with D_e below, which averages over ordered
  // pairs of the value pool (the 2/(N(N-1)) factor). Counting only unordered
  // pairs here would halve D_o and inflate alpha by the relation
  // alpha_wrong = (alpha_true + 1) / 2 (verified against R `irr`/`krippendorff`).
  //   D_o = Σ_u [ Σ_{i≠j in u} (x_i-x_j)^2 / (m_u - 1) ] / Σ_u m_u
  //       = Σ_u [ 2·Σ_{i<j in u} (x_i-x_j)^2 / (m_u - 1) ] / Σ_u m_u
  let Do_num = 0;
  let Do_den = 0;
  let pairs = 0;
  for (const row of ratings) {
    const vals = row.filter((v) => Number.isFinite(v));
    const m = vals.length;
    if (m < 2) continue;
    let s = 0;
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        s += (vals[i] - vals[j]) ** 2;
        pairs++;
      }
    }
    Do_num += (2 * s) / (m - 1);
    Do_den += m;
  }
  const Do = Do_den === 0 ? 0 : Do_num / Do_den;

  // Expected disagreement: pairwise (c-k)^2 over the entire pool
  let De_num = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) De_num += (allVals[i] - allVals[j]) ** 2;
  }
  const De = (De_num * 2) / (N * (N - 1));

  const alpha = De === 0 ? 1 : 1 - Do / De;
  return { alpha: round6(alpha), n, pairs };
}

/**
 * Paired bootstrap test for two paired numeric series (e.g., per-case scores
 * for two models on the same suite). Returns mean difference and bootstrap CI,
 * plus a two-sided p-value for H0: mean diff = 0.
 *
 * @param a  scores from model A (one per case, same order as B)
 * @param b  scores from model B
 */
export function pairedBootstrap(
  a: number[],
  b: number[],
  nResamples = 10000,
  alpha = 0.05,
  seed = 7,
): { meanDiff: number; lower: number; upper: number; pValue: number; n: number } {
  if (a.length !== b.length) throw new Error(`pairedBootstrap: arrays must match length (${a.length} vs ${b.length})`);
  const n = a.length;
  if (n === 0) return { meanDiff: 0, lower: 0, upper: 0, pValue: 1, n };

  const diffs = a.map((x, i) => x - b[i]);
  const observed = diffs.reduce((s, x) => s + x, 0) / n;

  // splitmix32 — deterministic PRNG
  let state = seed | 0;
  const rng = (): number => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };

  const resampled: number[] = new Array(nResamples);
  for (let r = 0; r < nResamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
    resampled[r] = s / n;
  }
  resampled.sort((x, y) => x - y);
  const lo = resampled[Math.floor((alpha / 2) * nResamples)];
  const hi = resampled[Math.floor((1 - alpha / 2) * nResamples) - 1];

  // Two-sided p-value via shifted resamples (centered at 0)
  const centered = resampled.map((x) => x - observed);
  let extreme = 0;
  for (const x of centered) if (Math.abs(x) >= Math.abs(observed)) extreme++;
  // Davison & Hinkley (1997) add-one estimator: a Monte-Carlo p-value cannot be
  // exactly 0 from a finite resample. The true tail probability is bounded below
  // by 1/(N+1); reporting 0.0000 would overstate certainty at the benchmark's
  // headline discrimination claim. meanDiff/CI and all case scores are untouched.
  const pValue = (extreme + 1) / (nResamples + 1);

  return {
    meanDiff: round6(observed),
    lower: round6(lo),
    upper: round6(hi),
    pValue: round6(Math.max(0, Math.min(1, pValue))),
    n,
  };
}

/** Landis & Koch interpretation labels for kappa. */
export function interpretKappa(k: number): string {
  if (k < 0) return "poor";
  if (k < 0.21) return "slight";
  if (k < 0.41) return "fair";
  if (k < 0.61) return "moderate";
  if (k < 0.81) return "substantial";
  return "almost perfect";
}

/** Krippendorff alpha rule-of-thumb thresholds (content analysis convention). */
export function interpretAlpha(a: number): string {
  if (a < 0) return "no agreement";
  if (a < 0.667) return "tentative";
  if (a < 0.8) return "acceptable";
  return "high";
}
