import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readJsonFile } from "./io.js";
import { suiteHashFromCases } from "./provenance.js";
import type { BenchCase, EntityType, LocaleKey, RunManifest, ScoreCombinationMode, SubmissionValidation, SuiteManifest, SystemType, TrackId } from "./types.js";

export async function loadSuiteManifest(path: string): Promise<SuiteManifest> {
  const suite = await readJsonFile<SuiteManifest>(path);
  if (suite.benchmarkName !== "laibench" && suite.benchmarkName !== "laibench-pro") throw new Error(`Invalid suite benchmarkName in ${path}`);
  return suite;
}

export async function loadCasesForSuite(suitePath: string, suite: SuiteManifest): Promise<BenchCase[]> {
  if (!suite.casesPath) throw new Error(`Suite ${suite.id} does not ship cases.`);
  const casesPath = resolve(resolve(suitePath, ".."), suite.casesPath);
  const cases = await readJsonFile<BenchCase[]>(casesPath);
  if (!Array.isArray(cases)) throw new Error(`Cases file must be a JSON array: ${casesPath}`);
  return cases;
}

export async function computeSuiteHash(cases: BenchCase[]): Promise<string> {
  return suiteHashFromCases(cases);
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
  judgeTemperature?: number | null;
  judgeMaxTokens?: number | null;
  scoreMode?: ScoreCombinationMode;
  policyId?: string | null;
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
    benchmarkName: "laibench-pro",
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
    judgeTemperature: args.judgeTemperature ?? null,
    judgeMaxTokens: args.judgeMaxTokens ?? null,
    scoreMode: args.scoreMode ?? "conservative-min",
    policyId: args.policyId ?? null,
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
