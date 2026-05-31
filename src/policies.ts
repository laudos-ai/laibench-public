/**
 * Policy profiles define configurable dimension weights, scoring thresholds,
 * and structural constraints for different evaluation contexts.
 *
 * All scores are on a 0-100% scale.
 */

import type { Dim } from "./types.js";
import { WEIGHTS } from "./scoring.js";

// ---- Policy types ----

export type PolicyProfileId = "strict" | "research" | "leaderboard";

export type PolicyProfile = {
  id: PolicyProfileId;
  name: string;
  description: string;
  /** Dimension weights consumed by `combineScores`; sum to 1 after normalization. */
  weights: Record<Dim, number>;
  /** Minimum overall score (0-100) to qualify as PASS */
  passThreshold: number;
  /** Minimum overall score (0-100) to qualify as PARTIAL */
  partialThreshold: number;
  /** Whether a single critical failure forces overall FAIL regardless of score */
  criticalFailForces: boolean;
};

/**
 * Canonical default weights — the single source of truth is `WEIGHTS` in
 * scoring.ts (CRIT .30 / QUAL .25 / TERM .20 / GUIDE .15 / RAG .10), which is
 * also what the README documents. The "research"/"leaderboard" profiles reuse
 * these exactly, so the default path is unchanged; only "strict" re-weights.
 */
const DEFAULT_WEIGHTS = normalizeWeights({ ...WEIGHTS });

// ---- Weight normalization ----

function normalizeWeights(raw: Record<Dim, number>): Record<Dim, number> {
  const total = Object.values(raw).reduce((sum, v) => sum + v, 0);
  if (total === 0) throw new Error("Policy weights must sum to a positive value");
  return {
    CRIT: raw.CRIT / total,
    QUAL: raw.QUAL / total,
    TERM: raw.TERM / total,
    GUIDE: raw.GUIDE / total,
    RAG: raw.RAG / total,
  };
}

// ---- Policy registry ----

const REGISTRY: Record<PolicyProfileId, PolicyProfile> = {
  strict: {
    id: "strict",
    name: "Strict",
    description:
      "Up-weights CRIT and raises the PASS/PARTIAL thresholds. Designed for " +
      "clinical validation where critical findings dominate the score and any " +
      "critical miss forces FAIL via the hard veto.",
    weights: normalizeWeights({ CRIT: 0.35, QUAL: 0.25, TERM: 0.15, GUIDE: 0.15, RAG: 0.10 }),
    passThreshold: 90,
    partialThreshold: 70,
    criticalFailForces: true,
  },
  research: {
    id: "research",
    name: "Research",
    description:
      "Canonical default weights and thresholds for research evaluation " +
      "(CRIT .30 / QUAL .25 / TERM .20 / GUIDE .15 / RAG .10), matching the README.",
    weights: DEFAULT_WEIGHTS,
    passThreshold: 84,
    partialThreshold: 60,
    criticalFailForces: true,
  },
  leaderboard: {
    id: "leaderboard",
    name: "Leaderboard",
    description:
      "Same canonical weights as research but paired with stricter submission " +
      "validation. Use for public benchmarks where submission integrity matters.",
    weights: DEFAULT_WEIGHTS,
    passThreshold: 84,
    partialThreshold: 60,
    criticalFailForces: true,
  },
};

// ---- Public API ----

export const DEFAULT_POLICY_ID: PolicyProfileId = "research";

export function getPolicy(name?: PolicyProfileId): PolicyProfile {
  return REGISTRY[name ?? DEFAULT_POLICY_ID] ?? REGISTRY[DEFAULT_POLICY_ID];
}

export function listPolicies(): PolicyProfile[] {
  return Object.values(REGISTRY);
}

export function isPolicyProfileId(value: string): value is PolicyProfileId {
  return value in REGISTRY;
}
