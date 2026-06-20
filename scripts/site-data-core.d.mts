// Type declarations for the plain-ESM site-data core, so src/*.test.ts can
// consume it under strict tsc without implicit any.

export type BoardGroup = "production" | "model" | "calibration";

export interface SiteEntry {
  system: string;
  kind: string;
  group: BoardGroup;
  score: number;
  allPass: number;
  criterionPass: number;
  clinicalScore: number;
  strictPass: number;
  dims: Record<"CRIT" | "QUAL" | "TERM" | "GUIDE" | "RAG", number | null>;
  latencyMs: number | null;
  track: string | undefined;
  suiteHash: string | undefined;
}

export interface RunManifestLike {
  runName?: string;
  entityName?: string;
  modelLabel?: string;
  systemType?: string;
  entityType?: string;
  track?: string;
  suiteHash?: string;
}

export interface RunSummaryLike {
  averageOverall?: number;
  allPassRate?: number;
  criterionPassRate?: number;
  strictPassRate?: number;
  averageLatencyMs?: number | null;
  averagePerDim: Record<string, number | null | undefined>;
}

export interface RunLike {
  manifest: RunManifestLike;
  summary: RunSummaryLike;
  results?: Array<{ checks?: Array<{ passed?: boolean }> }>;
}

export const LEADERBOARD_DISCLOSURE: string;

export function criterionStats(run: RunLike): {
  allPassRate: number;
  criterionPassRate: number;
  allPassCount: number;
  criteriaPassed: number;
  criteriaTotal: number;
};

export function groupForRun(manifest: RunManifestLike): BoardGroup;

export function entryFromRun(run: RunLike): SiteEntry;

export function orderEntries(entries: SiteEntry[]): SiteEntry[];
