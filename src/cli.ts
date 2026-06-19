#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, resolve } from "node:path";
import { benchmarkCase, benchmarkSuiteFromGenerator, benchmarkSuiteFromPredictions } from "./benchmark.js";
import { writeJsonFile, writeTextFile } from "./io.js";
import { buildCommandGenerator } from "./providers/command.js";
import { buildOpenAICompatibleGenerator, buildOpenAICompatibleJudge } from "./providers/openai-compatible.js";
import { buildOpenRouterGenerator, buildOpenRouterJudge } from "./providers/openrouter.js";
import { buildLeaderboard, compareToText, leaderboardToMarkdown, readSuiteRun, writeJson } from "./leaderboard.js";
import { computeSuiteHash, loadCasesForSuite, loadSuiteManifest } from "./manifests.js";
import { readPredictionsJsonl, validatePredictions } from "./submission.js";
import { defaultTrackForProvider } from "./tracks.js";
import { discriminate } from "./discriminate.js";
import { calibrateJudges, scanContamination } from "./calibrate.js";
import { buildPerturbationMatrix } from "./perturb.js";
import { buildPerturbationDataset, summarizePerturbationRun } from "./perturb-eval.js";
import { buildProvenanceManifest } from "./provenance.js";
import { bootstrapCI } from "./stats.js";
import { buildConsolidatedReport, reportToMarkdown } from "./report.js";
import { reliabilityAtK, reliabilityToMarkdown } from "./reliability.js";
import type { CaseRunResult, EntityType, GeneratorAdapter, JudgeAdapter, LocaleKey, ScoreCombinationMode, SystemType, TrackId } from "./types.js";

type Flags = Record<string, string | boolean | string[]>;
type Pricing = { inputPer1M?: number; outputPer1M?: number };
type JsonObject = Record<string, unknown>;

type ProviderBuild = {
  generator: GeneratorAdapter;
  provider: string;
  modelLabel: string;
};

type PublicSystemMeta = {
  entityName?: string;
  entityType?: EntityType;
  systemType?: SystemType;
  comparisonClass?: string;
};

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {};
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (!token || !token.startsWith("--")) {
      i += 1;
      continue;
    }
    const key = token.slice(2);
    // Consume every consecutive non-flag token as a value for this flag, so
    // `--inputs A B C` captures all three (matching the repeated `--inputs A
    // --inputs B` form). A flag with no following value is a boolean true.
    const values: string[] = [];
    let j = i + 1;
    while (j < rest.length && !rest[j].startsWith("--")) {
      values.push(rest[j]);
      j += 1;
    }
    if (values.length === 0) {
      flags[key] = true;
    } else {
      const existing = flags[key];
      const merged =
        existing === undefined || existing === true
          ? values
          : Array.isArray(existing)
            ? [...existing, ...values]
            : [String(existing), ...values];
      flags[key] = merged.length === 1 ? merged[0] : merged;
    }
    i = j;
  }
  return { command, flags };
}

function getString(flags: Flags, key: string, fallback?: string): string | undefined {
  const value = flags[key];
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return fallback;
}

function getMany(flags: Flags, key: string): string[] {
  const value = flags[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function getNumber(flags: Flags, key: string, fallback?: number): number | undefined {
  const raw = getString(flags, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric flag --${key}: ${raw}`);
  return parsed;
}

function limitCases<T>(cases: T[], flags: Flags): T[] {
  const limit = getNumber(flags, "case-limit");
  if (limit === undefined) return cases;
  return cases.slice(0, Math.max(1, Math.floor(limit)));
}

function required(flags: Flags, key: string): string {
  const value = getString(flags, key);
  if (!value) throw new Error(`Missing required flag --${key}`);
  return value;
}

function resolveLocale(flags: Flags, fallback: LocaleKey): LocaleKey {
  return (getString(flags, "locale", fallback) ?? fallback) as LocaleKey;
}

function resolveTrack(flags: Flags, fallbackProvider: string): TrackId {
  return (getString(flags, "track") ?? defaultTrackForProvider(fallbackProvider)) as TrackId;
}

function resolveScoreMode(flags: Flags): ScoreCombinationMode {
  const value = getString(flags, "score-mode", "conservative-min") ?? "conservative-min";
  if (value === "conservative-min" || value === "judge-primary") return value;
  throw new Error(`Invalid --score-mode: ${value}. Use conservative-min or judge-primary.`);
}

const HTTP_PROVIDERS = new Set(["openrouter", "openai-compatible"]);

/** Default pool width for generator runs: HTTP providers parallelize well, local commands stay serial. */
function defaultGeneratorConcurrency(provider: string): number {
  return HTTP_PROVIDERS.has(provider) ? 4 : 1;
}

/** Default pool width for prediction-mode runs (eval-submission, perturb-run): CPU-bound scoring. */
function defaultPredictionConcurrency(): number {
  return Math.min(availableParallelism(), 8);
}

/** Minimum delay between request dispatches: --sleep-ms flag wins over LAIBENCH_INTER_REQ_SLEEP_MS. */
function resolveSleepMs(flags: Flags): number | undefined {
  const flagValue = getNumber(flags, "sleep-ms");
  if (flagValue !== undefined) return flagValue;
  const raw = process.env.LAIBENCH_INTER_REQ_SLEEP_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function formatEta(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function makeProgressPrinter(): (index: number, total: number, caseResult: CaseRunResult) => void {
  const startedAt = Date.now();
  let completed = 0;
  return (index, total, caseResult) => {
    completed += 1;
    const dims = Object.entries(caseResult.combined).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${(v as number).toFixed(0)}%`).join(" ");
    const costStr = caseResult.costUsd > 0 ? ` | $${caseResult.costUsd.toFixed(4)}` : "";
    const avgMsPerCase = (Date.now() - startedAt) / completed;
    const etaStr = ` ETA ${formatEta(avgMsPerCase * (total - completed))}`;
    console.log(`[${index}/${total}] ${caseResult.case.id} ${caseResult.verdict} ${caseResult.combinedOverall.toFixed(1)}% | ${dims} | ${caseResult.latencyMs}ms${costStr}${etaStr}`);
  };
}

function resolvePublicSystemMeta(flags: Flags): PublicSystemMeta {
  return {
    entityName: getString(flags, "entity-name"),
    entityType: getString(flags, "entity-type") as EntityType | undefined,
    systemType: getString(flags, "system-type") as SystemType | undefined,
    comparisonClass: getString(flags, "comparison-class"),
  };
}

function buildPricing(flags: Flags, prefix = ""): Pricing | undefined {
  const input = getNumber(flags, `${prefix}price-in`);
  const output = getNumber(flags, `${prefix}price-out`);
  if (input === undefined && output === undefined) return undefined;
  return { inputPer1M: input, outputPer1M: output };
}

function readJsonObject(value: string | undefined, label: string): JsonObject | undefined {
  if (!value) return undefined;
  const source = value.startsWith("@") ? readFileSync(resolve(value.slice(1)), "utf8") : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must parse to a JSON object.`);
  }
  return parsed as JsonObject;
}

/** Precedence: --[prefix]base-url > --base-url (if prefixed) > OPENAI_COMPAT_BASE_URL > OPENAI_BASE_URL */
function resolveOpenAIBaseUrl(flags: Flags, prefix = ""): string | undefined {
  return getString(flags, `${prefix}base-url`)
    ?? (prefix ? getString(flags, "base-url") : undefined)
    ?? process.env.OPENAI_COMPAT_BASE_URL
    ?? process.env.OPENAI_BASE_URL;
}

/** Precedence: --[prefix]api-key > --api-key (if prefixed) > OPENAI_COMPAT_API_KEY > OPENAI_API_KEY */
function resolveOpenAIApiKey(flags: Flags, prefix = ""): string | undefined {
  return getString(flags, `${prefix}api-key`)
    ?? (prefix ? getString(flags, "api-key") : undefined)
    ?? process.env.OPENAI_COMPAT_API_KEY
    ?? process.env.OPENAI_API_KEY;
}

function resolveOpenAIConfig(flags: Flags, options: { prefix?: string; model?: string }): {
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  authHeader?: string;
  authPrefix?: string;
  maxTokens?: number;
  temperature?: number;
} {
  const prefix = options.prefix ?? "";
  const baseUrl = resolveOpenAIBaseUrl(flags, prefix);
  if (!baseUrl) throw new Error(`Missing ${prefix || ""}base-url for openai-compatible provider.`);

  const model = options.model ?? getString(flags, `${prefix}model`) ?? (prefix ? getString(flags, "model") : undefined);
  if (!model) throw new Error(`Missing ${prefix || ""}model for openai-compatible provider.`);

  const headers = readJsonObject(
    getString(flags, `${prefix}headers-json`) ?? (prefix ? getString(flags, "headers-json") : undefined),
    `--${prefix}headers-json`,
  );
  const body = readJsonObject(
    getString(flags, `${prefix}body-json`) ?? (prefix ? getString(flags, "body-json") : undefined),
    `--${prefix}body-json`,
  );

  return {
    baseUrl,
    apiKey: resolveOpenAIApiKey(flags, prefix),
    model,
    headers: headers ? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)])) : undefined,
    body,
    authHeader: getString(flags, `${prefix}auth-header`) ?? (prefix ? getString(flags, "auth-header") : undefined),
    authPrefix: getString(flags, `${prefix}auth-prefix`) ?? (prefix ? getString(flags, "auth-prefix") : undefined),
    maxTokens: getNumber(flags, `${prefix}max-tokens`) ?? (prefix ? getNumber(flags, "max-tokens") : undefined),
    temperature: getNumber(flags, `${prefix}temperature`) ?? (prefix ? getNumber(flags, "temperature") : undefined),
  };
}

function buildGenerator(flags: Flags): ProviderBuild {
  const provider = required(flags, "provider");
  if (provider === "openrouter") {
    const model = required(flags, "model");
    const apiKey = getString(flags, "api-key") ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OpenRouter API key. Use --api-key or OPENROUTER_API_KEY.");
    // Footgun guard: OpenRouter ":free" endpoints require consent to free-model
    // training. With the default data_collection=deny every request 404s ("No
    // endpoints found matching your data policy") and the model silently scores
    // 0%. Warn loudly instead of producing a misleading zero.
    const dataCollection = getString(flags, "data-collection") ?? process.env.OPENROUTER_DATA_COLLECTION;
    if (model.includes(":free") && dataCollection !== "allow") {
      console.error(`WARN openrouter free-model data policy: ${model} is a ":free" endpoint. Set --data-collection allow (or OPENROUTER_DATA_COLLECTION=allow) or every request will 404 on the free-training data policy and the model will score 0%.`);
    }
    const noSystemPrompt = flags["no-system-prompt"] === true;
    return {
      generator: buildOpenRouterGenerator(apiKey, model, buildPricing(flags), {
        maxTokens: getNumber(flags, "max-tokens"),
        temperature: getNumber(flags, "temperature"),
        noSystemPrompt,
        dataCollection: dataCollection === "allow" ? "allow" : dataCollection === "deny" ? "deny" : undefined,
      }),
      provider,
      modelLabel: getString(flags, "agent-name") ?? model,
    };
  }
  if (provider === "openai-compatible") {
    const config = resolveOpenAIConfig(flags, {});
    return {
      generator: buildOpenAICompatibleGenerator(config, buildPricing(flags)),
      provider,
      modelLabel: getString(flags, "agent-name") ?? config.model,
    };
  }
  if (provider === "command") {
    const cmd = required(flags, "cmd");
    return {
      generator: buildCommandGenerator(cmd),
      provider,
      modelLabel: getString(flags, "agent-name") ?? cmd,
    };
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function buildJudge(flags: Flags, generatorProvider: string): JudgeAdapter | null {
  const judgeModel = getString(flags, "judge-model");
  if (!judgeModel) return null;
  const publicJudgeProvider = getString(flags, "judge-provider-label");
  const publicJudgeLabel = getString(flags, "judge-label");

  const judgeProvider = getString(flags, "judge-provider")
    ?? (generatorProvider === "openai-compatible" ? "openai-compatible" : generatorProvider === "openrouter" ? "openrouter" : null);

  if (!judgeProvider) {
    throw new Error(`Cannot infer judge provider from generator provider "${generatorProvider}". Use --judge-provider explicitly.`);
  }

  if (judgeProvider === "openrouter") {
    const apiKey = getString(flags, "judge-api-key") ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Missing OpenRouter judge API key. Use --judge-api-key or OPENROUTER_API_KEY.");
    const judge = buildOpenRouterJudge(apiKey, judgeModel, buildPricing(flags, "judge-"), {
      maxTokens: getNumber(flags, "judge-max-tokens", 2048),
      temperature: getNumber(flags, "judge-temperature", 0),
    });
    return { ...judge, provider: publicJudgeProvider ?? judge.provider, modelLabel: publicJudgeLabel ?? judge.modelLabel };
  }

  if (judgeProvider === "openai-compatible") {
    const config = resolveOpenAIConfig(flags, { prefix: "judge-", model: judgeModel });
    const judge = buildOpenAICompatibleJudge({
      ...config,
      maxTokens: config.maxTokens ?? 2048,
      temperature: config.temperature ?? 0,
    }, buildPricing(flags, "judge-"));
    return { ...judge, provider: publicJudgeProvider ?? judge.provider, modelLabel: publicJudgeLabel ?? judge.modelLabel };
  }

  throw new Error(`Unsupported judge provider: ${judgeProvider}`);
}

async function printSuites(): Promise<void> {
  const suitesDir = resolve(process.cwd(), "suites");
  const entries = (await readdir(suitesDir)).filter((name) => name.endsWith(".json")).sort();
  for (const entry of entries) {
    const manifest = await loadSuiteManifest(resolve(suitesDir, entry));
    console.log(`${entry}\n  id=${manifest.id}\n  locale=${manifest.locale}\n  visibility=${manifest.visibility}\n  cases=${manifest.caseCount}\n  mode=${manifest.evaluationMode}\n`);
  }
}

async function verifyLocalSuiteHash(run: import("./types.js").SuiteRunResult): Promise<void> {
  const suitesDir = resolve(process.cwd(), "suites");
  const entries = (await readdir(suitesDir)).filter((name) => name.endsWith(".json")).sort();
  for (const entry of entries) {
    const suitePath = resolve(suitesDir, entry);
    const suite = await loadSuiteManifest(suitePath);
    if (suite.id !== run.manifest.suiteId) continue;
    if (!suite.casesPath) {
      throw new Error(`Run ${run.manifest.runName} points to suite ${suite.id}, but that suite does not ship locked cases. Refusing to publish without local case-hash verification.`);
    }
    if (suite.visibility !== run.manifest.suiteVisibility) {
      throw new Error(`Run ${run.manifest.runName} suiteVisibility=${run.manifest.suiteVisibility}, but local suite ${suite.id} is ${suite.visibility}.`);
    }
    if (suite.evaluationMode !== run.manifest.evaluationMode) {
      throw new Error(`Run ${run.manifest.runName} evaluationMode=${run.manifest.evaluationMode}, but local suite ${suite.id} is ${suite.evaluationMode}.`);
    }
    if (suite.locale !== run.manifest.locale) {
      throw new Error(`Run ${run.manifest.runName} locale=${run.manifest.locale}, but local suite ${suite.id} is ${suite.locale}.`);
    }
    const cases = await loadCasesForSuite(suitePath, suite);
    if (cases.length !== suite.caseCount) {
      throw new Error(`Local suite ${suite.id} declares caseCount=${suite.caseCount}, but ships ${cases.length} cases.`);
    }
    if (run.manifest.validation.valid && run.manifest.validation.expectedIds.length !== cases.length) {
      throw new Error(`Run ${run.manifest.runName} expectedIds=${run.manifest.validation.expectedIds.length}, but local suite ${suite.id} has ${cases.length} cases.`);
    }
    const hash = await computeSuiteHash(cases);
    if (hash !== run.manifest.suiteHash) {
      throw new Error(`Run ${run.manifest.runName} has suiteHash=${run.manifest.suiteHash}, but local suite ${suite.id} hashes to ${hash}. Refusing to publish a non-locked or edited artifact.`);
    }
    if (suite.benchmarkVersion !== run.manifest.benchmarkVersion) {
      throw new Error(`Run ${run.manifest.runName} benchmarkVersion=${run.manifest.benchmarkVersion}, but local suite ${suite.id} is ${suite.benchmarkVersion}.`);
    }
    return;
  }
  throw new Error(`No local suite manifest found for run suiteId=${run.manifest.suiteId}. Refusing to publish without suite-hash verification.`);
}

async function verifyLoadedRuns(runs: Array<{ path: string; run: import("./types.js").SuiteRunResult }>): Promise<void> {
  for (const { run } of runs) await verifyLocalSuiteHash(run);
}

function printHelp(): void {
  console.log(`
LAIBench Pro CLI

Commands:
  suites               List suite manifests
  single               Run one case through a generator
  suite                Run a public suite through a generator
  matrix               Run many models/commands on the same suite
  validate-submission  Validate a predictions.jsonl file against a suite
  eval-submission      Evaluate a predictions.jsonl file against a suite
  leaderboard          Build grouped leaderboards from suite result files
  compare              Compare two compatible suite result files

Providers:
  openrouter           Hosted models through OpenRouter
  openai-compatible    Any OpenAI-like /chat/completions endpoint
  command              Local/custom agent over stdin/stdout

Examples:
  npm run bench -- suites
  npm run bench -- suite --suite suites/lite-public.pt-BR.json --provider openrouter --model anthropic/claude-sonnet-4.6 --judge-model anthropic/claude-opus-4.7 --run-name sonnet-mini --out runs/sonnet-mini.json
  npm run bench -- suite --suite suites/lite-public.pt-BR.json --provider command --cmd "node examples/mock-agent.mjs" --case-limit 10 --run-name smoke --out runs/smoke.json
  npm run bench -- suite --suite suites/lite-public.pt-BR.json --provider openai-compatible --base-url http://localhost:8787/v1 --model custom-rad-reporter --run-name local-endpoint --out runs/local-endpoint.json
  npm run bench -- validate-submission --suite suites/lite-public.pt-BR.json --predictions predictions/my-agent.jsonl
  npm run bench -- eval-submission --suite suites/lite-public.pt-BR.json --predictions predictions/my-agent.jsonl --run-name my-agent --model-label my-agent --track agent --out runs/my-agent.json
  npm run bench -- matrix --suite suites/lite-public.pt-BR.json --provider openrouter --model model-a --model model-b --judge-model judge-model --score-mode judge-primary --out-dir runs/reference-en
  npm run bench -- leaderboard --inputs runs/a.json runs/b.json --out runs/leaderboard.json --markdown runs/leaderboard.md
  npm run bench -- compare --a runs/a.json --b runs/b.json

Throttling:
  --concurrency N        Parallel cases. Defaults: 4 for HTTP providers (openrouter, openai-compatible),
                         1 for command, min(cpu cores, 8) for eval-submission/perturb-run.
  --sleep-ms MS          Minimum delay between request dispatches, enforced globally across workers.
                         Also honors the LAIBENCH_INTER_REQ_SLEEP_MS env var (flag wins).

Scoring:
  --score-mode conservative-min  Default. LLM judge can only lower deterministic dimension scores.
  --score-mode judge-primary     LLM-adjudicated 0-100 score is primary when present; deterministic critical gates still force unsafe-case failures.
  --judge-label LABEL            Public manifest label for a hidden pinned judge profile.
  --judge-provider-label LABEL   Public manifest label for the judge provider.
`.trim());
}

async function runSingle(flags: Flags): Promise<void> {
  const locale = resolveLocale(flags, "pt-BR");
  const { generator, provider, modelLabel } = buildGenerator(flags);
  const judge = buildJudge(flags, provider);
  const scoreMode = resolveScoreMode(flags);
  const exam = required(flags, "exam");
  const findings = required(flags, "findings");

  const result = await benchmarkCase({
    case: { id: "single", exam, findings, locale },
    locale,
    generator,
    providerLabel: provider,
    modelLabel,
    judge,
    scoreMode,
  });

  const out = getString(flags, "out");
  if (out) {
    await writeJsonFile(out, result);
    console.log(`Wrote ${out}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

async function runSuite(flags: Flags): Promise<void> {
  const suitePath = required(flags, "suite");
  const suite = await loadSuiteManifest(suitePath);
  if (suite.evaluationMode !== "local") throw new Error(`Suite ${suite.id} is ${suite.evaluationMode}; evaluate it via the private/cloud runner.`);
  const cases = limitCases(await loadCasesForSuite(suitePath, suite), flags);
  const locale = resolveLocale(flags, suite.locale);
  const { generator, provider, modelLabel } = buildGenerator(flags);
  const judge = buildJudge(flags, provider);
  const scoreMode = resolveScoreMode(flags);
  const runName = required(flags, "run-name");
  const concurrency = getNumber(flags, "concurrency") ?? defaultGeneratorConcurrency(provider);
  const minInterRequestMs = resolveSleepMs(flags);
  const track = resolveTrack(flags, provider);
  const notes = getString(flags, "notes");
  const publicMeta = resolvePublicSystemMeta(flags);

  console.log(`Running suite ${suite.id} (${cases.length} cases) | provider=${provider} | model=${modelLabel} | locale=${locale} | track=${track}`);
  const completedResults: CaseRunResult[] = [];
  const out = required(flags, "out");
  registerPartialSave(out, () => ({ manifest: { runName, suiteId: suite.id, partial: true }, completedCount: completedResults.length, results: completedResults }));
  const printProgress = makeProgressPrinter();

  const result = await benchmarkSuiteFromGenerator({
    suite,
    cases,
    locale,
    generator,
    runName,
    provider,
    modelLabel,
    ...publicMeta,
    judge,
    scoreMode,
    track,
    concurrency,
    minInterRequestMs,
    notes,
    onCaseComplete(index, total, caseResult) {
      completedResults.push(caseResult);
      printProgress(index, total, caseResult);
    },
  });

  await writeJson(out, result);
  console.log(`Wrote ${out}`);
  const caseCount = result.results.length || 1;
  const avgCost = result.summary.totalCostUsd / caseCount;
  console.log(`\nAll-pass completion: ${(result.summary.allPassRate ?? 0).toFixed(1)}% | Criterion pass: ${(result.summary.criterionPassRate ?? 0).toFixed(1)}% | Clinical score: ${result.summary.averageOverall.toFixed(1)}% | Strict PASS gate: ${result.summary.accuracyRate.toFixed(1)}% | Cost: $${result.summary.totalCostUsd.toFixed(4)} ($${avgCost.toFixed(4)}/case)`);
}

async function runMatrix(flags: Flags): Promise<void> {
  const suitePath = required(flags, "suite");
  const suite = await loadSuiteManifest(suitePath);
  if (suite.evaluationMode !== "local") throw new Error(`Suite ${suite.id} is ${suite.evaluationMode}; evaluate it via the private/cloud runner.`);
  const cases = limitCases(await loadCasesForSuite(suitePath, suite), flags);
  const locale = resolveLocale(flags, suite.locale);
  const provider = required(flags, "provider");
  const judge = buildJudge(flags, provider);
  const scoreMode = resolveScoreMode(flags);
  const outDir = required(flags, "out-dir");
  const concurrency = getNumber(flags, "concurrency") ?? defaultGeneratorConcurrency(provider);
  const minInterRequestMs = resolveSleepMs(flags);
  const track = resolveTrack(flags, provider);
  const notes = getString(flags, "notes");
  const publicMeta = resolvePublicSystemMeta(flags);
  const inputs = provider === "command" ? getMany(flags, "cmd") : getMany(flags, "model");
  if (inputs.length === 0) throw new Error(`Use --${provider === "command" ? "cmd" : "model"} one or more times.`);

  for (const item of inputs) {
    const localFlags: Flags = { ...flags, provider };
    if (provider === "command") localFlags.cmd = item;
    else localFlags.model = item;

    const built = buildGenerator(localFlags);
    const runName = basename(item).replace(/[^a-zA-Z0-9_.-]+/g, "-");
    const out = resolve(outDir, `${runName}.json`);
    console.log(`\n==> ${provider} ${item}`);

    const result = await benchmarkSuiteFromGenerator({
      suite,
      cases,
      locale,
      generator: built.generator,
      runName,
      provider: built.provider,
      modelLabel: built.modelLabel,
      ...publicMeta,
      judge,
      scoreMode,
      track,
      concurrency,
      minInterRequestMs,
      notes,
      onCaseComplete: makeProgressPrinter(),
    });

    await writeJson(out, result);
    console.log(`Wrote ${out}`);
  }
}

async function runValidateSubmission(flags: Flags, onlyValidate = true): Promise<void> {
  const suitePath = required(flags, "suite");
  const suite = await loadSuiteManifest(suitePath);
  if (suite.evaluationMode !== "local") throw new Error(`Suite ${suite.id} is ${suite.evaluationMode}; evaluate it via the private/cloud runner.`);
  const cases = await loadCasesForSuite(suitePath, suite);
  const predictions = await readPredictionsJsonl(required(flags, "predictions"));
  const validation = validatePredictions(cases, predictions);

  if (onlyValidate) {
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.valid) process.exitCode = 1;
    return;
  }

  const locale = resolveLocale(flags, suite.locale);
  const provider = getString(flags, "provider", "predictions") ?? "predictions";
  const judge = buildJudge(flags, provider);
  const scoreMode = resolveScoreMode(flags);
  const modelLabel = required(flags, "model-label");
  const runName = required(flags, "run-name");
  const concurrency = getNumber(flags, "concurrency") ?? defaultPredictionConcurrency();
  const minInterRequestMs = resolveSleepMs(flags);
  const track = resolveTrack(flags, provider);
  const notes = getString(flags, "notes");
  const publicMeta = resolvePublicSystemMeta(flags);

  if (!validation.valid) {
    console.warn("Submission is invalid; the run will still be evaluated for debugging, but it will not rank on the leaderboard.");
  }

  const result = await benchmarkSuiteFromPredictions({
    suite,
    cases,
    locale,
    predictions,
    validation,
    runName,
    provider,
    modelLabel,
    ...publicMeta,
    judge,
    scoreMode,
    track,
    concurrency,
    minInterRequestMs,
    notes,
    onCaseComplete: makeProgressPrinter(),
  });

  const out = required(flags, "out");
  await writeJson(out, result);
  console.log(`Wrote ${out}`);
  const evalCaseCount = result.results.length || 1;
  const evalAvgCost = result.summary.totalCostUsd / evalCaseCount;
  console.log(`\nAll-pass completion: ${(result.summary.allPassRate ?? 0).toFixed(1)}% | Criterion pass: ${(result.summary.criterionPassRate ?? 0).toFixed(1)}% | Clinical score: ${result.summary.averageOverall.toFixed(1)}% | Strict PASS gate: ${result.summary.accuracyRate.toFixed(1)}% | Cost: $${result.summary.totalCostUsd.toFixed(4)} ($${evalAvgCost.toFixed(4)}/case) | Eligible: ${result.manifest.validation.valid}`);
}

async function runLeaderboard(flags: Flags): Promise<void> {
  const inputs = getMany(flags, "inputs");
  if (inputs.length === 0) throw new Error("Use --inputs with one or more suite result files.");
  const loaded = await Promise.all(inputs.map(async (path) => ({ path, run: await readSuiteRun(path) })));
  await verifyLoadedRuns(loaded);
  const leaderboard = buildLeaderboard(loaded);

  const out = required(flags, "out");
  await writeJson(out, leaderboard);

  const markdownPath = getString(flags, "markdown");
  if (markdownPath) {
    await writeTextFile(markdownPath, leaderboardToMarkdown(leaderboard));
    console.log(`Wrote ${markdownPath}`);
  }

  console.log(`Wrote ${out}`);
  for (const group of leaderboard.groups) {
    const top = group.entries[0];
    const judgingMode = group.scoreMode === "judge-primary"
      ? "judged/frozen judge-primary"
      : group.judgeModel
        ? "judged/frozen conservative-min"
        : "deterministic";
    console.log(`${group.suiteId} | ${group.locale} | ${group.track} | ${judgingMode} | entries=${group.entries.length} | #${top?.rank ?? "—"} ${top?.runName ?? "n/a"} allPass=${top?.allPassRate?.toFixed(1) ?? "n/a"}% criterion=${top?.criterionPassRate?.toFixed(1) ?? "n/a"}% clinical=${top?.averageOverall.toFixed(1) ?? "n/a"}%`);
  }
}

async function runCompare(flags: Flags): Promise<void> {
  const a = await readSuiteRun(required(flags, "a"));
  const b = await readSuiteRun(required(flags, "b"));
  await verifyLoadedRuns([{ path: "a", run: a }, { path: "b", run: b }]);
  console.log(compareToText(a, b));
}

async function runDiscriminate(flags: Flags): Promise<void> {
  const runA = await readSuiteRun(required(flags, "a"));
  const runB = await readSuiteRun(required(flags, "b"));
  const minDelta = getNumber(flags, "min-delta", 5)!;
  const alpha = getNumber(flags, "alpha", 0.05)!;
  const report = discriminate(runA, runB, { alpha, minDelta });
  const out = getString(flags, "out");
  if (out) {
    await writeJsonFile(out, report);
    console.log(`Wrote ${out}`);
  }
  console.log(`\nDiscrimination: ${report.verdict.toUpperCase()}`);
  console.log(`  ${report.modelA.modelLabel} (${report.overall.aMean.toFixed(2)}%) vs ${report.modelB.modelLabel} (${report.overall.bMean.toFixed(2)}%)`);
  console.log(`  Δ=${report.overall.meanDiff.toFixed(2)}pp  95% CI [${report.overall.ci[0].toFixed(2)}, ${report.overall.ci[1].toFixed(2)}]  p=${report.overall.pValue.toFixed(4)}  n=${report.caseCount}`);
  for (const note of report.notes) console.log(`  • ${note}`);
}

async function runReliability(flags: Flags): Promise<void> {
  const inputs = getMany(flags, "inputs");
  if (inputs.length === 0) throw new Error("Use --inputs with the SAME system's run files (same suite, k repeated attempts).");
  const runs = await Promise.all(inputs.map((p) => readSuiteRun(p)));
  const report = reliabilityAtK(runs);
  const out = getString(flags, "out");
  if (out) {
    await writeJsonFile(out, report);
    console.log(`Wrote ${out}`);
  }
  const markdownPath = getString(flags, "markdown");
  if (markdownPath) {
    await writeTextFile(markdownPath, reliabilityToMarkdown(report));
    console.log(`Wrote ${markdownPath}`);
  }
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  console.log(`\nReliability (pass^${report.k}) over ${report.caseCount} cases:`);
  console.log(`  Critical-safe pass^${report.k}: ${pct(report.passPowerKCriticalSafe)}  (headline)`);
  console.log(`  Critical-safe pass@1:  ${pct(report.passAt1CriticalSafe)}`);
  console.log(`  Verdict pass^${report.k}:      ${pct(report.passPowerKVerdict)}`);
  if (report.flakyCriticalCases.length > 0) {
    console.log(`  Flaky critical cases:  ${report.flakyCriticalCases.join(", ")}`);
  }
}

async function runCalibrate(flags: Flags): Promise<void> {
  const inputs = getMany(flags, "inputs");
  if (inputs.length === 0) throw new Error("Use --inputs with one or more suite result files (same suite, different judge runs).");
  const runs = await Promise.all(inputs.map((p) => readSuiteRun(p)));
  const report = calibrateJudges(runs);
  const out = getString(flags, "out");
  if (out) {
    await writeJsonFile(out, report);
    console.log(`Wrote ${out}`);
  }
  console.log(`\nCalibration verdict: ${report.verdict.toUpperCase()}`);
  console.log(`  Suite: ${report.comparableKey}`);
  console.log(`  Judges: ${report.judges.join(" | ")}`);
  console.log(`  Cases: ${report.caseCount}`);
  for (const note of report.notes) console.log(`  • ${note}`);
}

async function runContamination(flags: Flags): Promise<void> {
  const run = await readSuiteRun(required(flags, "run"));
  const report = scanContamination(run);
  const out = getString(flags, "out");
  if (out) {
    await writeJsonFile(out, report);
    console.log(`Wrote ${out}`);
  }
  console.log(`\nContamination scan: ${report.verdict.toUpperCase()}`);
  console.log(`  Run: ${report.runName}`);
  console.log(`  Canary token: ${report.canaryToken ?? "(none — pre-2.0 run)"}`);
  console.log(`  Canary hits: ${report.canaryHits}`);
  console.log(`  Judge-flagged: ${report.judgeFlaggedContamination}`);
}

async function runPerturbMatrix(flags: Flags): Promise<void> {
  const suitePath = required(flags, "suite");
  const suite = await loadSuiteManifest(suitePath);
  const cases = await loadCasesForSuite(suitePath, suite);
  const limit = getNumber(flags, "limit", cases.length)!;
  const out = required(flags, "out");
  const matrix: Array<{ caseId: string; kind: string; text: string; expectedDims: string[]; expectedSeverity: string; description: string }> = [];
  for (const c of cases.slice(0, limit)) {
    const source = c.referenceReport ?? c.findings;
    const samples = buildPerturbationMatrix(c, source);
    for (const s of samples) {
      matrix.push({
        caseId: c.id,
        kind: s.kind,
        text: s.text,
        expectedDims: s.spec.expectedDims,
        expectedSeverity: s.spec.expectedSeverity,
        description: s.spec.description,
      });
    }
  }
  await writeJsonFile(out, { suiteId: suite.id, samples: matrix });
  console.log(`Wrote ${matrix.length} perturbations across ${Math.min(limit, cases.length)} cases → ${out}`);
}

async function runPerturbRun(flags: Flags): Promise<void> {
  const suitePath = required(flags, "suite");
  const suite = await loadSuiteManifest(suitePath);
  const cases = await loadCasesForSuite(suitePath, suite);
  const limit = getNumber(flags, "limit", cases.length)!;
  const target = cases.slice(0, limit);
  const out = required(flags, "out");

  const { samples, links } = buildPerturbationDataset(target, { applicableOnly: true });
  console.log(`Generated ${samples.length} applicable perturbations across ${target.length} cases.`);

  const predictions = samples.map((s) => ({
    instance_id: s.caseId,
    model_name_or_path: `perturb:${s.kind}`,
    model_output: s.text,
  }));

  const byKind = new Map<string, typeof predictions>();
  for (const p of predictions) {
    const kind = (p.model_name_or_path ?? "perturb:unknown").replace(/^perturb:/, "");
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(p);
  }

  const allOutcomes: Array<{ kind: string; caught: boolean; caseId: string }> = [];
  const judge = buildJudge(flags, "predictions");

  for (const [kind, kindPreds] of byKind.entries()) {
    const validation = validatePredictions(target, kindPreds);
    const result = await benchmarkSuiteFromPredictions({
      suite,
      cases: target,
      locale: suite.locale,
      predictions: kindPreds,
      validation,
      runName: `perturb-${kind}`,
      provider: "perturb",
      modelLabel: `perturb:${kind}`,
      judge,
      track: "agent",
      concurrency: getNumber(flags, "concurrency") ?? defaultPredictionConcurrency(),
      minInterRequestMs: resolveSleepMs(flags),
    });

    const subset = links.filter((l) => l.kind === kind);
    const summary = summarizePerturbationRun(result, subset);
    for (const r of result.results) {
      const link = subset.find((l) => l.predictionId === r.case.id);
      if (!link) continue;
      const spec = (await import("./perturb.js")).PERTURBATIONS[link.kind];
      const caught = (await import("./perturb-eval.js")).isPerturbationCaught(spec, r);
      allOutcomes.push({ kind, caught, caseId: r.case.id });
    }
    console.log(`  ${kind}: ${summary.perKind[0]?.caught}/${summary.perKind[0]?.n} caught (${summary.perKind[0]?.rate ?? 0}%)`);
  }

  const totalCaught = allOutcomes.filter((o) => o.caught).length;
  const overallRate = allOutcomes.length === 0 ? 0 : Number(((totalCaught / allOutcomes.length) * 100).toFixed(2));
  const verdict = overallRate >= 90 ? "robust" : overallRate >= 70 ? "leaky" : "broken";

  const report = {
    suiteId: suite.id,
    benchmarkVersion: suite.benchmarkVersion,
    caseCount: target.length,
    perturbationCount: samples.length,
    overallCatchRate: overallRate,
    verdict,
    perKind: [...byKind.keys()].sort().map((kind) => {
      const subset = allOutcomes.filter((o) => o.kind === kind);
      const caught = subset.filter((o) => o.caught).length;
      return { kind, n: subset.length, caught, rate: subset.length === 0 ? 0 : Number(((caught / subset.length) * 100).toFixed(2)) };
    }),
    generatedAt: new Date().toISOString(),
  };

  await writeJsonFile(out, report);
  console.log(`\nOverall catch rate: ${overallRate}% (verdict: ${verdict.toUpperCase()})`);
  console.log(`Wrote ${out}`);
}

async function runBootstrap(flags: Flags): Promise<void> {
  const path = required(flags, "run");
  const run = await readSuiteRun(path);
  const scores = run.results.map((r) => r.combinedOverall);
  const ci = bootstrapCI(scores, getNumber(flags, "resamples", 10000), getNumber(flags, "alpha", 0.05));
  console.log(`\nBootstrap CI for ${run.manifest.runName}`);
  console.log(`  n=${scores.length}  mean=${ci.mean.toFixed(2)}%  95% CI [${ci.lower.toFixed(2)}, ${ci.upper.toFixed(2)}]`);
}

async function runProvenance(flags: Flags): Promise<void> {
  const suiteInputs = getMany(flags, "suite");
  if (suiteInputs.length === 0) throw new Error("Use --suite one or more times.");
  const suites: Array<{ suiteId: string; locale: string; cases: import("./types.js").BenchCase[] }> = [];
  let benchmarkVersion = "unknown";
  for (const s of suiteInputs) {
    const suite = await loadSuiteManifest(s);
    const cases = await loadCasesForSuite(s, suite);
    suites.push({ suiteId: suite.id, locale: suite.locale, cases });
    benchmarkVersion = suite.benchmarkVersion;
  }
  const manifest = await buildProvenanceManifest({ benchmarkVersion, suites });
  const out = required(flags, "out");
  await writeJsonFile(out, manifest);
  console.log(`Wrote ${out}`);
  console.log(`  Benchmark version: ${manifest.benchmarkVersion}`);
  console.log(`  Scoring hash: ${manifest.scoringHash}`);
  for (const s of manifest.suites) console.log(`  ${s.suiteId} (${s.locale}, n=${s.caseCount}) → ${s.suiteHash.slice(0, 16)}…`);
}

async function runReport(flags: Flags): Promise<void> {
  const primaryPath = required(flags, "run");
  const baselinePath = getString(flags, "baseline");
  const calibrationInputs = getMany(flags, "calibration");
  const perturbReportPath = getString(flags, "perturb-report");
  const provenancePath = getString(flags, "provenance");
  const out = required(flags, "out");
  const report = await buildConsolidatedReport({
    primaryPath,
    baselinePath,
    calibrationInputs: calibrationInputs.length > 0 ? calibrationInputs : undefined,
    perturbReportPath,
    provenancePath,
  });
  await writeJsonFile(out, report);
  const markdownPath = getString(flags, "markdown");
  if (markdownPath) {
    await writeTextFile(markdownPath, reportToMarkdown(report));
    console.log(`Wrote ${markdownPath}`);
  }
  console.log(`Wrote ${out}`);
  console.log(`\n${report.primary.runName}: ${report.primary.mean.toFixed(2)}% (95% CI [${report.primary.ci95[0].toFixed(2)}, ${report.primary.ci95[1].toFixed(2)}], n=${report.primary.n})`);
  console.log(`Contamination: ${report.contamination.verdict.toUpperCase()}`);
  if (report.calibration) console.log(`Calibration: ${report.calibration.verdict.toUpperCase()}`);
  if (report.discrimination) console.log(`Discrimination vs ${report.discrimination.baselineRun}: ${report.discrimination.verdict.toUpperCase()} (Δ=${report.discrimination.meanDiff.toFixed(2)}pp, p=${report.discrimination.pValue.toFixed(4)})`);
  if (report.perturbation) console.log(`Perturbation robustness: ${report.perturbation.verdict.toUpperCase()} (catch=${report.perturbation.overallCatchRate}%)`);
}

async function run(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "suites":
      await printSuites();
      return;
    case "single":
      await runSingle(flags);
      return;
    case "suite":
      await runSuite(flags);
      return;
    case "matrix":
      await runMatrix(flags);
      return;
    case "validate-submission":
      await runValidateSubmission(flags, true);
      return;
    case "eval-submission":
      await runValidateSubmission(flags, false);
      return;
    case "leaderboard":
      await runLeaderboard(flags);
      return;
    case "compare":
      await runCompare(flags);
      return;
    case "discriminate":
      await runDiscriminate(flags);
      return;
    case "calibrate":
      await runCalibrate(flags);
      return;
    case "contamination":
      await runContamination(flags);
      return;
    case "perturb-matrix":
      await runPerturbMatrix(flags);
      return;
    case "perturb-run":
      await runPerturbRun(flags);
      return;
    case "bootstrap":
      await runBootstrap(flags);
      return;
    case "provenance":
      await runProvenance(flags);
      return;
    case "report":
      await runReport(flags);
      return;
    case "reliability":
      await runReliability(flags);
      return;
    default:
      printHelp();
  }
}

let _partialOut: string | null = null;
let _partialHandler: (() => Promise<void>) | null = null;

function registerPartialSave(outPath: string, getData: () => unknown): void {
  _partialOut = outPath;
  if (_partialHandler) {
    process.removeListener("SIGINT", _partialHandler);
    process.removeListener("SIGTERM", _partialHandler);
  }
  const handler = async () => {
    const data = getData();
    if (!_partialOut || !data) {
      process.exit(1);
      return;
    }
    console.error(`\nSIGINT received — saving partial results to ${_partialOut}`);
    try {
      await writeJsonFile(_partialOut.replace(/\.json$/, ".partial.json"), data);
    } catch (error) {
      console.error("Failed to save partial results:", error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  };
  _partialHandler = handler;
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
