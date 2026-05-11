/**
 * Policy profiles define configurable dimension weights, scoring thresholds,
 * and structural constraints for different evaluation contexts.
 *
 * All scores are on a 0-100% scale.
 */

import type { Dim } from "./types.js";

// ---- Policy types ----

export type PolicyProfileId = "strict" | "research" | "leaderboard";

export type PolicyProfile = {
  id: PolicyProfileId;
  name: string;
  description: string;
  weights: Record<Dim, number>;
  /** Minimum overall score (0-100) to qualify as PASS */
  passThreshold: number;
  /** Minimum overall score (0-100) to qualify as PARTIAL */
  partialThreshold: number;
  /** Minimum per-dimension score (0-100) below which a dimension is considered FAIL */
  dimFailThreshold: number;
  /** Multiplier applied to overall score when a critical failure is present (0-1) */
  criticalFailPenalty: number;
  /** Whether a single critical failure forces overall FAIL regardless of score */
  criticalFailForces: boolean;
};

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
      "Higher thresholds with aggressive critical-failure penalties. " +
      "Designed for clinical validation where any critical miss must tank the score.",
    weights: normalizeWeights({ CRIT: 0.35, QUAL: 0.25, TERM: 0.15, GUIDE: 0.15, RAG: 0.10 }),
    passThreshold: 90,
    partialThreshold: 70,
    dimFailThreshold: 45,
    criticalFailPenalty: 0.3,
    criticalFailForces: true,
  },
  research: {
    id: "research",
    name: "Research",
    description:
      "Standard weights and thresholds suitable for research evaluation. " +
      "Balanced across all dimensions with moderate penalty for critical failures.",
    weights: normalizeWeights({ CRIT: 0.25, QUAL: 0.30, TERM: 0.15, GUIDE: 0.20, RAG: 0.10 }),
    passThreshold: 84,
    partialThreshold: 60,
    dimFailThreshold: 35,
    criticalFailPenalty: 0.5,
    criticalFailForces: true,
  },
  leaderboard: {
    id: "leaderboard",
    name: "Leaderboard",
    description:
      "Same scoring weights as research but with stricter submission validation. " +
      "Use for public benchmarks where submission integrity matters.",
    weights: normalizeWeights({ CRIT: 0.25, QUAL: 0.30, TERM: 0.15, GUIDE: 0.20, RAG: 0.10 }),
    passThreshold: 84,
    partialThreshold: 60,
    dimFailThreshold: 35,
    criticalFailPenalty: 0.5,
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
