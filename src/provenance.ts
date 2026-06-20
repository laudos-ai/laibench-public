/**
 * Reproducibility hash chain for laibench.
 *
 * Every artifact (case file, suite manifest, run manifest, leaderboard) carries
 * a cryptographic hash of its inputs so anyone can verify that a leaderboard
 * row was produced from the exact same cases + scoring code + judge model.
 *
 * Chain layers:
 *   1. caseHash       = sha256 of canonical (id, exam, findings, locale, gold)
 *   2. suiteHash      = sha256 of sorted [caseHash...]
 *   3. scoringHash    = sha256 of pinned scoring/eval source files
 *   4. runHash        = sha256(suiteHash + manifestCanonical + scoringHash)
 *   5. leaderboardHash= sha256 of sorted [runHash...]
 *
 * Anyone can recompute these from the published artifacts to prove no silent
 * tampering happened between bench publication and a reported result.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./hash.js";
import type { BenchCase, RunManifest, SuiteRunResult } from "./types.js";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function caseHash(c: BenchCase): string {
  return sha256(
    canonicalize({
      id: c.id,
      exam: c.exam,
      findings: c.findings,
      locale: c.locale ?? null,
      goldFindings: c.goldFindings ?? null,
      referenceReport: c.referenceReport ?? null,
      criticalFindings: c.criticalFindings ?? null,
      guidelineExpectations: c.guidelineExpectations ?? null,
      retrievalGold: c.retrievalGold ?? null,
      patientContext: c.patientContext ?? null,
      difficulty: c.difficulty ?? null,
    }),
  );
}

export function suiteHashFromCases(cases: BenchCase[]): string {
  const hashes = cases.map(caseHash).sort();
  return sha256(canonicalize(hashes));
}

/** Hash a list of source file paths. Returns sha256 of canonical (path, hash) records. */
export async function scoringHashFromFiles(paths: string[]): Promise<string> {
  const records: Array<{ path: string; sha256: string }> = [];
  for (const p of paths) {
    const abs = resolve(p);
    const content = await readFile(abs, "utf8");
    records.push({ path: p, sha256: sha256(content) });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return sha256(canonicalize(records));
}

/**
 * Default scoring source files that affect comparable results.
 * Verified against the v2.0.0 source tree — every path must exist.
 * Append new evaluators here so they enter the scoringHash.
 */
export const DEFAULT_SCORING_FILES = [
  "src/scoring.ts",
  "src/checks.ts",
  "src/judge.ts",
  "src/normalize.ts",
  "src/policies.ts",
  "src/sanitize.ts",
  "src/extract.ts",
  "src/classify.ts",
  "src/clinical-match.ts",
  "src/evaluators/crit.ts",
  "src/evaluators/qual.ts",
  "src/evaluators/guide.ts",
  "src/evaluators/rag.ts",
  "src/evaluators/structural.ts",
  "src/extractors/critical-extractor.ts",
  "src/locales/index.ts",
  "src/locales/types.ts",
  "src/locales/en-US.ts",
  "src/locales/pt-BR.ts",
];

export function runHash(args: { suiteHash: string; manifest: Omit<RunManifest, "validation" | "createdAt">; scoringHash: string }): string {
  const manifestCanon = canonicalize({
    benchmarkVersion: args.manifest.benchmarkVersion,
    suiteId: args.manifest.suiteId,
    locale: args.manifest.locale,
    track: args.manifest.track,
    provider: args.manifest.provider,
    modelLabel: args.manifest.modelLabel,
    scaffoldId: args.manifest.scaffoldId,
    judgeProvider: args.manifest.judgeProvider,
    judgeModel: args.manifest.judgeModel,
    submissionMode: args.manifest.submissionMode,
    canaryToken: args.manifest.canaryToken,
  });
  return sha256(`${args.suiteHash}|${manifestCanon}|${args.scoringHash}`);
}

export function leaderboardHash(runs: SuiteRunResult[]): string {
  const runHashes = runs
    .map((r) => sha256(canonicalize({ runName: r.manifest.runName, suiteHash: r.manifest.suiteHash, modelLabel: r.manifest.modelLabel, average: r.summary.averageOverall })))
    .sort();
  return sha256(canonicalize(runHashes));
}

export type ProvenanceManifest = {
  benchmarkVersion: string;
  generatedAt: string;
  scoringHash: string;
  scoringFiles: Array<{ path: string; sha256: string }>;
  suites: Array<{ suiteId: string; locale: string; caseCount: number; suiteHash: string }>;
};

/**
 * Build a top-level provenance manifest covering all suites and the scoring
 * code at the time of publication. Publish alongside the leaderboard.
 */
export async function buildProvenanceManifest(args: {
  benchmarkVersion: string;
  suites: Array<{ suiteId: string; locale: string; cases: BenchCase[] }>;
  scoringFilePaths?: string[];
}): Promise<ProvenanceManifest> {
  const paths = args.scoringFilePaths ?? DEFAULT_SCORING_FILES;
  const records: Array<{ path: string; sha256: string }> = [];
  const missing: string[] = [];
  for (const p of paths) {
    try {
      const content = await readFile(resolve(p), "utf8");
      records.push({ path: p, sha256: sha256(content) });
    } catch {
      missing.push(p);
    }
  }
  if (missing.length > 0) {
    // Fail loud: a stale scoring file list invalidates the hash chain claim.
    throw new Error(`buildProvenanceManifest: missing scoring files: ${missing.join(", ")}. Update DEFAULT_SCORING_FILES.`);
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  const scoringHash = sha256(canonicalize(records));

  return {
    benchmarkVersion: args.benchmarkVersion,
    generatedAt: new Date().toISOString(),
    scoringHash,
    scoringFiles: records,
    suites: args.suites.map((s) => ({
      suiteId: s.suiteId,
      locale: s.locale,
      caseCount: s.cases.length,
      suiteHash: suiteHashFromCases(s.cases),
    })),
  };
}
