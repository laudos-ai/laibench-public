import { randomUUID } from "node:crypto";
import { deriveExamMeta } from "./classify.js";
import { runDeterministicChecks } from "./checks.js";
import { evaluateCritical } from "./evaluators/crit.js";
import { evaluateGuidelines } from "./evaluators/guide.js";
import { evaluateQuality } from "./evaluators/qual.js";
import { evaluateRetrieval } from "./evaluators/rag.js";
import { buildJudgePrompt, parseJudgeResponse } from "./judge.js";
import { getLocale } from "./locales/index.js";
import { round1, roundCost } from "./normalize.js";
import { getPolicy } from "./policies.js";
import type { PolicyProfileId } from "./policies.js";
import { sanitizeAllowedHtml, normalizeGeneratedHtml } from "./sanitize.js";
import { combineScores, scoreDimensions, scoreDimensionsWithEvaluators, DIMS, WEIGHTS } from "./scoring.js";
import type { ScoreCombinationMode } from "./scoring.js";
import { buildRunManifest, computeSuiteHash } from "./manifests.js";
import { defaultTrackForProvider, resolveScaffoldId } from "./tracks.js";
import { materializeCaseHtmlMap } from "./submission.js";
import { extractRetrievedDocIds } from "./retrieval-metadata.js";
import type {
  BenchCase,
  CaseRunResult,
  Check,
  Dim,
  DimSummary,
  EvaluatorResult,
  GeneratorAdapter,
  EntityType,
  LocaleKey,
  SubmissionPrediction,
  SubmissionValidation,
  SystemType,
  SuiteManifest,
  SuiteRunResult,
  SuiteSummary,
  TraceEvent,
  TrackId,
} from "./types.js";

/**
 * Determine if a case has any rich gold data that would benefit from the new evaluators.
 */
function hasRichGoldData(benchCase: BenchCase): boolean {
  return !!(
    (benchCase.goldFindings && benchCase.goldFindings.length > 0) ||
    benchCase.referenceReport ||
    (benchCase.criticalFindings && benchCase.criticalFindings.length > 0) ||
    (benchCase.guidelineExpectations && benchCase.guidelineExpectations.length > 0) ||
    (benchCase.retrievalGold && benchCase.retrievalGold.length > 0)
  );
}

function isOperationalFailure(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.operationalFailure === true;
}

function buildOperationalFailureChecks(message: string): Check[] {
  return DIMS.map((dim) => ({
    dim,
    id: `operational-failure-${dim.toLowerCase()}`,
    name: "Operational failure",
    severity: "critical",
    passed: false,
    evidence: message,
  }));
}

function buildZeroDimSummaries(): Record<Dim, DimSummary> {
  return Object.fromEntries(DIMS.map((dim) => [
    dim,
    { score: 0, pass: 0, total: 1, critFails: 1, verdict: "FAIL", appliedWeight: WEIGHTS[dim] },
  ])) as Record<Dim, DimSummary>;
}

export async function benchmarkCase(args: {
  case: BenchCase;
  locale: LocaleKey;
  generator?: GeneratorAdapter;
  providedHtml?: string;
  providerLabel: string;
  modelLabel: string;
  judge?: import("./types.js").JudgeAdapter | null;
  scoreMode?: ScoreCombinationMode;
  policyId?: PolicyProfileId;
  canaryToken?: string;
  providedMetadata?: Record<string, unknown>;
}): Promise<CaseRunResult> {
  const started = Date.now();
  const trace: TraceEvent[] = [];
  const locale = getLocale(args.locale);
  const meta = deriveExamMeta(args.case.exam, args.case.findings, args.locale);
  const systemPrompt = locale.buildSystemPrompt(meta);

  let rawOutput = args.providedHtml ?? "";
  let generationMetadata = args.providedMetadata;
  if (args.generator) {
    const generationStarted = Date.now();
    const generation = await args.generator.run({
      exam: args.case.exam,
      findings: args.case.findings,
      locale: args.locale,
      systemPrompt,
    });
    rawOutput = generation.html;
    generationMetadata = generation.metadata;
    trace.push({
      step: "generate",
      model: generation.model ?? args.modelLabel,
      metadata: generation.metadata,
      inputTokens: generation.usage?.inputTokens,
      outputTokens: generation.usage?.outputTokens,
      costUsd: generation.costUsd,
      ms: Date.now() - generationStarted,
    });
  } else {
    trace.push({ step: "ingest-prediction", model: args.modelLabel, ms: 0 });
  }

  const normalizedHtml = normalizeGeneratedHtml(rawOutput);
  const sanitizedHtml = sanitizeAllowedHtml(normalizedHtml);
  const retrievedDocIds = extractRetrievedDocIds(generationMetadata);

  if (isOperationalFailure(generationMetadata)) {
    const failureMessage = typeof generationMetadata?.error === "string"
      ? generationMetadata.error
      : "The evaluated agent did not return a valid report.";
    const checks = buildOperationalFailureChecks(failureMessage);
    const zeroDims = buildZeroDimSummaries();
    trace.push({ step: "operational-failure", ms: 0, error: failureMessage });

    return {
      case: args.case,
      locale: args.locale,
      rawHtml: rawOutput,
      normalizedHtml,
      sanitizedHtml,
      meta,
      checks,
      detDims: zeroDims,
      detOverall: 0,
      judge: null,
      combined: Object.fromEntries(DIMS.map((dim) => [dim, 0])) as Record<Dim, number | null>,
      combinedOverall: 0,
      verdict: "FAIL",
      confidence: "low",
      phaseStatus: "degraded",
      gateReasons: ["operational failure", "adversarial phase unavailable"],
      costUsd: roundCost(trace.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)),
      latencyMs: Date.now() - started,
      trace,
    };
  }

  // --- Phase 1: Structural deterministic checks ---
  const checksStarted = Date.now();
  const structuralChecks = runDeterministicChecks(normalizedHtml, meta, args.case.findings, args.locale);
  trace.push({ step: "structural-checks", ms: Date.now() - checksStarted });

  // --- Phase 2: Run new evaluators if case has rich gold data ---
  const evaluatorResults: EvaluatorResult[] = [];
  let allChecks: Check[] = [...structuralChecks];

  if (hasRichGoldData(args.case)) {
    const evalStarted = Date.now();

    // Quality evaluator
    const qualResult = evaluateQuality(normalizedHtml, args.case, args.locale, meta, structuralChecks);
    evaluatorResults.push(qualResult);

    // Critical finding evaluator
    const critResult = evaluateCritical(normalizedHtml, args.case, args.locale, meta, structuralChecks);
    evaluatorResults.push(critResult);

    // Guideline evaluator
    const guideResult = evaluateGuidelines(normalizedHtml, args.case, args.locale, meta, structuralChecks);
    evaluatorResults.push(guideResult);

    // Retrieval evaluator
    const ragResult = evaluateRetrieval(normalizedHtml, args.case, args.locale, meta, structuralChecks, retrievedDocIds);
    evaluatorResults.push(ragResult);

    // Merge evaluator checks into allChecks (remove structural checks for dims that have evaluator results)
    const evaluatorDims = new Set(evaluatorResults.filter((e) => e.score >= 0).map((e) => e.dim));
    allChecks = structuralChecks.filter((c) => !evaluatorDims.has(c.dim));
    for (const evalResult of evaluatorResults) {
      if (evalResult.score >= 0) {
        allChecks.push(...evalResult.checks);
      }
    }

    trace.push({ step: "evaluators", ms: Date.now() - evalStarted });
  }

  // --- Score dimensions ---
  const det = evaluatorResults.length > 0
    ? scoreDimensionsWithEvaluators(allChecks, evaluatorResults)
    : scoreDimensions(allChecks);

  // --- Phase 3: Optional LLM judge ---
  let judge = null;
  if (args.judge) {
    try {
      const prompt = buildJudgePrompt(args.locale, args.case.exam, args.case.findings, normalizedHtml, args.canaryToken, args.case);
      const judged = await args.judge.run(prompt);
      trace.push({
        step: "judge",
        model: judged.model ?? args.judge.modelLabel,
        inputTokens: judged.usage?.inputTokens,
        outputTokens: judged.usage?.outputTokens,
        costUsd: judged.trace.costUsd,
        ms: judged.trace.ms,
      });
      judge = parseJudgeResponse(judged.text);
    } catch (error) {
      trace.push({
        step: "judge",
        model: args.judge.modelLabel,
        ms: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const policy = args.policyId ? getPolicy(args.policyId) : undefined;
  const combined = combineScores(det.dims, judge, allChecks, policy, args.scoreMode);

  return {
    case: args.case,
    locale: args.locale,
    rawHtml: rawOutput,
    normalizedHtml,
    sanitizedHtml,
    meta,
    checks: allChecks,
    detDims: det.dims,
    detOverall: det.overall,
    judge,
    combined: combined.combined,
    combinedOverall: combined.overall,
    verdict: combined.verdict,
    confidence: combined.confidence,
    phaseStatus: combined.phaseStatus,
    gateReasons: combined.gateReasons,
    costUsd: roundCost(trace.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)),
    latencyMs: Date.now() - started,
    trace,
  };
}

function buildSummary(results: CaseRunResult[]): SuiteSummary {
  const verdictCounts = { PASS: 0, PARTIAL: 0, FAIL: 0 } as Record<"PASS" | "PARTIAL" | "FAIL", number>;
  const averagePerDim: Partial<Record<Dim, number>> = {};
  let averageOverall = 0;
  let passRate = 0;
  let strictPassRate = 0;
  let averageLatencyMs = 0;
  let totalCostUsd = 0;

  for (const result of results) {
    verdictCounts[result.verdict] += 1;
    averageOverall += result.combinedOverall;
    if (result.verdict !== "FAIL") passRate += 1;
    if (result.verdict === "PASS") strictPassRate += 1;
    averageLatencyMs += result.latencyMs;
    totalCostUsd += result.costUsd;
  }

  averageOverall = round1(averageOverall / (results.length || 1));
  passRate = round1((passRate / (results.length || 1)) * 100);
  strictPassRate = round1((strictPassRate / (results.length || 1)) * 100);
  averageLatencyMs = round1(averageLatencyMs / (results.length || 1));
  totalCostUsd = roundCost(totalCostUsd);

  for (const dim of DIMS) {
    const scored = results.map((result) => result.combined[dim]).filter((value): value is number => value !== null);
    if (scored.length > 0) averagePerDim[dim] = round1(scored.reduce((sum, value) => sum + value, 0) / scored.length);
  }

  return {
    accuracyRate: strictPassRate,
    averageOverall,
    passRate,
    strictPassRate,
    averageLatencyMs,
    totalCostUsd,
    verdictCounts,
    averagePerDim,
  };
}

async function runCasePool(args: {
  cases: BenchCase[];
  locale: LocaleKey;
  concurrency?: number;
  runner: (item: BenchCase) => Promise<CaseRunResult>;
  onCaseComplete?: (index: number, total: number, result: CaseRunResult) => void;
}): Promise<CaseRunResult[]> {
  const total = args.cases.length;
  const concurrency = Math.max(1, args.concurrency ?? 1);
  const results: CaseRunResult[] = new Array(total);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= total) return;
      const item = args.cases[current];
      if (!item) return;
      const result = await args.runner(item);
      results[current] = result;
      args.onCaseComplete?.(current + 1, total, result);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function benchmarkSuiteFromGenerator(args: {
  suite: SuiteManifest;
  cases: BenchCase[];
  locale: LocaleKey;
  generator: GeneratorAdapter;
  runName: string;
  provider: string;
  modelLabel: string;
  entityName?: string;
  entityType?: EntityType;
  systemType?: SystemType;
  comparisonClass?: string;
  judge?: import("./types.js").JudgeAdapter | null;
  scoreMode?: ScoreCombinationMode;
  track?: TrackId;
  concurrency?: number;
  notes?: string;
  onCaseComplete?: (index: number, total: number, result: CaseRunResult) => void;
}): Promise<SuiteRunResult> {
  const canaryToken = randomUUID();

  const results = await runCasePool({
    cases: args.cases,
    locale: args.locale,
    concurrency: args.concurrency,
    onCaseComplete: args.onCaseComplete,
    runner: (item) => benchmarkCase({
      case: item,
      locale: item.locale ?? args.locale,
      generator: args.generator,
      providerLabel: args.provider,
      modelLabel: args.modelLabel,
      judge: args.judge,
      scoreMode: args.scoreMode,
      canaryToken,
    }),
  });

  const suiteHash = await computeSuiteHash(args.cases);
  const track = args.track ?? defaultTrackForProvider(args.provider);
  const validation: SubmissionValidation = {
    valid: true,
    expectedIds: args.cases.map((item) => item.id),
    receivedIds: args.cases.map((item) => item.id),
    missingIds: [],
    duplicateIds: [],
    extraIds: [],
    emptyOutputs: [],
    errors: [],
  };

  return {
    manifest: buildRunManifest({
      suite: args.suite,
      suiteHash,
      locale: args.locale,
      runName: args.runName,
      provider: args.provider,
      modelLabel: args.modelLabel,
      entityName: args.entityName,
      entityType: args.entityType,
      systemType: args.systemType,
      comparisonClass: args.comparisonClass,
      track,
      scaffoldId: resolveScaffoldId(track, args.generator),
      judgeProvider: args.judge?.provider ?? null,
      judgeModel: args.judge?.modelLabel ?? null,
      scoreMode: args.scoreMode,
      validation,
      submissionMode: "generator",
      canaryToken,
      notes: args.notes,
    }),
    summary: buildSummary(results),
    results,
  };
}

export async function benchmarkSuiteFromPredictions(args: {
  suite: SuiteManifest;
  cases: BenchCase[];
  locale: LocaleKey;
  predictions: SubmissionPrediction[];
  validation: SubmissionValidation;
  runName: string;
  provider: string;
  modelLabel: string;
  entityName?: string;
  entityType?: EntityType;
  systemType?: SystemType;
  comparisonClass?: string;
  judge?: import("./types.js").JudgeAdapter | null;
  scoreMode?: ScoreCombinationMode;
  track?: TrackId;
  concurrency?: number;
  notes?: string;
  onCaseComplete?: (index: number, total: number, result: CaseRunResult) => void;
}): Promise<SuiteRunResult> {
  const canaryToken = randomUUID();
  const predictionMap = materializeCaseHtmlMap(args.predictions);
  const casesToRun = args.cases.filter((item) => predictionMap.has(item.id));

  const results = await runCasePool({
    cases: casesToRun,
    locale: args.locale,
    concurrency: args.concurrency,
    onCaseComplete: args.onCaseComplete,
    runner: (item) => benchmarkCase({
      case: item,
      locale: item.locale ?? args.locale,
      providedHtml: predictionMap.get(item.id)?.model_output ?? "",
      providedMetadata: predictionMap.get(item.id)?.metadata,
      providerLabel: args.provider,
      modelLabel: args.modelLabel,
      judge: args.judge,
      scoreMode: args.scoreMode,
      canaryToken,
    }),
  });

  const suiteHash = await computeSuiteHash(args.cases);
  const track = args.track ?? defaultTrackForProvider(args.provider);

  return {
    manifest: buildRunManifest({
      suite: args.suite,
      suiteHash,
      locale: args.locale,
      runName: args.runName,
      provider: args.provider,
      modelLabel: args.modelLabel,
      entityName: args.entityName,
      entityType: args.entityType,
      systemType: args.systemType,
      comparisonClass: args.comparisonClass,
      track,
      scaffoldId: resolveScaffoldId(track),
      judgeProvider: args.judge?.provider ?? null,
      judgeModel: args.judge?.modelLabel ?? null,
      scoreMode: args.scoreMode,
      validation: args.validation,
      submissionMode: "predictions",
      canaryToken,
      notes: args.notes,
    }),
    summary: buildSummary(results),
    results,
  };
}
