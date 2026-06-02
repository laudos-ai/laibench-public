import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sha256 } from "./hash.js";
import { readJsonFile } from "./io.js";
import type { BenchCase, EntityType, LocaleKey, RunManifest, ScoreCombinationMode, SubmissionValidation, SuiteManifest, SystemType, TrackId } from "./types.js";

export async function loadSuiteManifest(path: string): Promise<SuiteManifest> {
  const suite = await readJsonFile<SuiteManifest>(path);
  if (suite.benchmarkName !== "laibench") throw new Error(`Invalid suite benchmarkName in ${path}`);
  return suite;
}

export async function loadCasesForSuite(suitePath: string, suite: SuiteManifest): Promise<BenchCase[]> {
  if (!suite.casesPath) throw new Error(`Suite ${suite.id} does not ship cases.`);
  const casesPath = resolve(resolve(suitePath, ".."), suite.casesPath);
  const cases = await readJsonFile<BenchCase[]>(casesPath);
  if (!Array.isArray(cases)) throw new Error(`Cases file must be a JSON array: ${casesPath}`);
  return cases;
}

/**
 * Deterministic stringify with recursively sorted object keys. Array order is
 * preserved (and is therefore significant). Two cases with the same content in a
 * different key order hash identically; any content difference changes the hash.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function computeSuiteHash(cases: BenchCase[]): Promise<string> {
  // Hash the FULL case content — including the gold answer key (goldFindings,
  // referenceReport, criticalFindings, guidelineExpectations, retrievalGold,
  // patientContext, difficulty) — not just the prompt. Hashing only
  // {id, exam, findings, locale} let a silently re-keyed answer set produce a
  // byte-identical suiteHash and pass verification, defeating integrity.
  const canonical = `[${cases.map(stableStringify).join(",")}]`;
  return sha256(canonical);
}

export function buildComparableKey(args: {
  benchmarkVersion: string;
  suiteId: string;
  locale: LocaleKey;
  track: TrackId;
  comparisonClass?: string | null;
  scaffoldId: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
  scoreMode?: ScoreCombinationMode;
}): string {
  return [
    args.benchmarkVersion,
    args.suiteId,
    args.locale,
    args.track,
    args.comparisonClass ?? args.track,
    args.scaffoldId ?? "none",
    args.judgeProvider ?? "none",
    args.judgeModel ?? "none",
    args.scoreMode ?? "conservative-min",
  ].join("::");
}

function inferSystemType(track: TrackId, provider: string, label: string): SystemType {
  if (track === "model") return "raw-model";
  if (track === "mini-agent") return "mini-agent";
  if (/laudos/i.test(label) && provider === "command") return "product-agent";
  return "custom-agent";
}

function inferEntityType(systemType: SystemType): EntityType {
  if (systemType === "raw-model") return "model";
  if (systemType === "product-agent") return "company";
  return "agent";
}

export function buildRunManifest(args: {
  suite: SuiteManifest;
  suiteHash: string;
  locale: LocaleKey;
  runName: string;
  provider: string;
  modelLabel: string;
  entityName?: string;
  entityType?: EntityType;
  systemType?: SystemType;
  comparisonClass?: string;
  track: TrackId;
  scaffoldId: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
  scoreMode?: ScoreCombinationMode;
  validation: SubmissionValidation;
  submissionMode: "generator" | "predictions";
  canaryToken?: string;
  notes?: string;
}): RunManifest {
  const systemType = args.systemType ?? inferSystemType(args.track, args.provider, args.modelLabel);
  const entityName = args.entityName ?? args.modelLabel;
  const entityType = args.entityType ?? inferEntityType(systemType);
  const comparisonClass = args.comparisonClass ?? systemType;
  return {
    benchmarkName: "laibench",
    benchmarkVersion: args.suite.benchmarkVersion,
    createdAt: new Date().toISOString(),
    runName: args.runName,
    suiteId: args.suite.id,
    suiteLabel: args.suite.label,
    suiteVisibility: args.suite.visibility,
    suiteHash: args.suiteHash,
    locale: args.locale,
    track: args.track,
    provider: args.provider,
    modelLabel: args.modelLabel,
    entityName,
    entityType,
    systemType,
    comparisonClass,
    scaffoldId: args.scaffoldId,
    judgeProvider: args.judgeProvider,
    judgeModel: args.judgeModel,
    scoreMode: args.scoreMode ?? "conservative-min",
    evaluationMode: args.suite.evaluationMode,
    submissionMode: args.submissionMode,
    validation: args.validation,
    comparableKey: buildComparableKey({
      benchmarkVersion: args.suite.benchmarkVersion,
      suiteId: args.suite.id,
      locale: args.locale,
      track: args.track,
      comparisonClass,
      scaffoldId: args.scaffoldId,
      judgeProvider: args.judgeProvider,
      judgeModel: args.judgeModel,
      scoreMode: args.scoreMode,
    }),
    canaryToken: args.canaryToken ?? randomUUID(),
    notes: args.notes,
  };
}
