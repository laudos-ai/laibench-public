// Pure, dependency-free helpers for the public leaderboard site data.
//
// Extracted from build-site-data.mjs so the conflict-of-interest segregation
// logic (production agent vs free/open model vs calibration fixture) and the
// first-party disclosure are unit-testable. No file IO here.

// First-party disclosure shown on the public board. The ranked production agent
// is built by the same team that maintains this benchmark, so the board must
// say so plainly and must never rank external/raw-model rows against it.
export const LEADERBOARD_DISCLOSURE =
  "Disclosure: the ranked production agent (Laudos.AI) is a first-party system " +
  "built by the same team that maintains LAIBench Pro. Free and open model rows " +
  "are diagnostic comparisons only and are never ranked against the first-party " +
  "production agent. Calibration fixtures are harness sanity checks, not product " +
  "claims. The public demonstration cases are synthetic and input-only; they were " +
  "not clinically reviewed and must not be used to claim clinical validation. The " +
  "controlled pt-BR suite is synthetic and was authored and reviewed by senior " +
  "radiologists in Sao Paulo, SP, Brazil as an internal data-quality process; this " +
  "is not an independent third-party validation, and the suite is aggregate-only " +
  "and is not an open-download benchmark. Independent external adjudication " +
  "(vendor-versus-external inter-rater kappa) is tracked as future work and is not " +
  "claimed here.";

export function criterionStats(run) {
  const results = Array.isArray(run.results) ? run.results : [];
  let allPassCount = 0;
  let criteriaPassed = 0;
  let criteriaTotal = 0;

  for (const result of results) {
    const checks = Array.isArray(result.checks) ? result.checks : [];
    const passed = checks.filter((check) => check && check.passed === true).length;
    if (checks.length > 0 && passed === checks.length) allPassCount += 1;
    criteriaPassed += passed;
    criteriaTotal += checks.length;
  }

  return {
    allPassRate: results.length > 0 ? Math.round((allPassCount / results.length) * 1000) / 10 : 0,
    criterionPassRate: criteriaTotal > 0 ? Math.round((criteriaPassed / criteriaTotal) * 1000) / 10 : 0,
    allPassCount,
    criteriaPassed,
    criteriaTotal,
  };
}

// Classify a run into exactly one board group. Order of precedence matters:
// calibration fixtures first (they look like agents otherwise), then raw/free
// models, then production agents.
export function groupForRun(manifest) {
  const systemType = manifest.systemType || "";
  const entityType = manifest.entityType || "";
  const track = manifest.track || "";
  const isFixture = systemType === "mini-agent" || /baseline|fixture|mock/i.test(manifest.entityName || "");
  const isModel = systemType === "raw-model" || entityType === "model" || track === "model";
  if (isFixture) return "calibration";
  if (isModel) return "model";
  return "production";
}

export function entryFromRun(run) {
  const s = run.summary;
  const m = run.manifest;
  const criterion = criterionStats(run);
  const allPassRate = s.allPassRate ?? criterion.allPassRate;
  const criterionPassRate = s.criterionPassRate ?? criterion.criterionPassRate;
  const clinicalScore = s.averageOverall ?? 0;
  const group = groupForRun(m);
  return {
    system: m.entityName || m.modelLabel || m.runName,
    kind: group === "calibration" ? "Harness fixture" : group === "model" ? "Free/open model" : (m.systemType || "agent"),
    group,
    score: clinicalScore / 100,
    allPass: allPassRate / 100,
    criterionPass: criterionPassRate / 100,
    clinicalScore: clinicalScore / 100,
    strictPass: (s.strictPassRate ?? 0) / 100,
    dims: {
      CRIT: (s.averagePerDim.CRIT ?? null) === null ? null : s.averagePerDim.CRIT / 100,
      QUAL: (s.averagePerDim.QUAL ?? null) === null ? null : s.averagePerDim.QUAL / 100,
      TERM: (s.averagePerDim.TERM ?? null) === null ? null : s.averagePerDim.TERM / 100,
      GUIDE: (s.averagePerDim.GUIDE ?? null) === null ? null : s.averagePerDim.GUIDE / 100,
      RAG: (s.averagePerDim.RAG ?? null) === null ? null : s.averagePerDim.RAG / 100,
    },
    latencyMs: s.averageLatencyMs ?? null,
    track: m.track,
    suiteHash: m.suiteHash,
  };
}

// Rank within group, then concatenate so production agents come first, free/open
// models second, calibration fixtures last. Models and fixtures are never
// interleaved into the production ranking.
export function orderEntries(entries) {
  const byGroup = (g) => entries.filter((e) => e.group === g).sort((a, b) =>
    (b.clinicalScore - a.clinicalScore) ||
    (b.criterionPass - a.criterionPass) ||
    (b.allPass - a.allPass)
  );
  return [...byGroup("production"), ...byGroup("model"), ...byGroup("calibration")];
}
