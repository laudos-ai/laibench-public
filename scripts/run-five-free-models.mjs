#!/usr/bin/env node
/**
 * Rate-safe runner for 5 text-capable OpenRouter free/open-weight models against a laibench suite.
 *
 * Free model rate limits vary by model/provider. This runner intentionally stays
 * well below the common free-tier ceilings by default.
 *
 * Strategy:
 *   - concurrency = 1
 *   - inter-request sleep = 7s (≈8 rpm — safe under common 20 rpm free limits)
 *   - exponential backoff on 429 / 5xx (5 retries, base 2s)
 *   - per-model retry of failed cases at the end
 *   - graceful skip + continue on persistent failure (don't kill the matrix)
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... node scripts/run-five-free-models.mjs \
 *     --suite suites/lite-public.en-US.json \
 *     --out-dir runs/free-models-2026-05-09
 *
 * Note: OpenRouter free endpoints may require OPENROUTER_DATA_COLLECTION=allow.
 * Keep this runner pointed only at data you are allowed to send to free providers.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";

const FREE_MODELS = [
  { id: "poolside/laguna-m.1:free", label: "Poolside Laguna M.1" },
  { id: "nex-agi/nex-n2-pro:free", label: "Nex AGI Nex-N2-Pro" },
  { id: "google/gemma-4-31b-it:free", label: "Google Gemma 4 31B IT" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "NVIDIA Nemotron 3 Nano Omni" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "NVIDIA Nemotron 3 Super 120B" },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const k = t.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[k] = true;
    } else {
      args[k] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const suite = args.suite ?? "suites/lite-public.en-US.json";
const outDir = args["out-dir"] ?? `runs/free-models-${new Date().toISOString().slice(0, 10)}`;
const sleepMs = Number(args.sleep ?? 7000);
const concurrency = Number(args.concurrency ?? 1);
const skipExisting = args["skip-existing"] !== undefined;

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY env var.");
  console.error("Get a free key at https://openrouter.ai/keys then export OPENROUTER_API_KEY=sk-...");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

console.log(`\n=== laibench five-free-models matrix ===`);
console.log(`Suite: ${suite}`);
console.log(`Judge: none (local deterministic scoring)`);
console.log(`Output dir: ${outDir}`);
console.log(`Sleep between calls: ${sleepMs}ms (≈${Math.floor(60000 / sleepMs)} rpm)`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Skip existing: ${skipExisting}`);
console.log(`Models:\n${FREE_MODELS.map((m) => `  - ${m.id}`).join("\n")}\n`);

const failed = [];
const completed = [];

for (let i = 0; i < FREE_MODELS.length; i += 1) {
  const model = FREE_MODELS[i];
  const slug = model.id.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/-+/g, "-");
  const runName = `${slug}-${basename(suite, ".json")}`;
  const outPath = resolve(outDir, `${runName}.json`);

  if (skipExisting && existsSync(outPath)) {
    console.log(`[${i + 1}/${FREE_MODELS.length}] ${model.id} → SKIP (exists)`);
    completed.push({ model: model.id, outPath, status: "skipped" });
    continue;
  }

  console.log(`\n[${i + 1}/${FREE_MODELS.length}] ${model.id}`);
  console.log(`  → ${outPath}`);

  const cliArgs = [
    "src/cli.ts",
    "suite",
    "--suite", suite,
    "--provider", "openrouter",
    "--model", model.id,
    "--run-name", runName,
    "--track", "model",
    "--entity-name", model.label,
    "--entity-type", "model",
    "--system-type", "raw-model",
    "--comparison-class", "openrouter-free-raw-model",
    "--score-mode", "conservative-min",
    "--concurrency", String(concurrency),
    "--max-tokens", String(args["max-tokens"] ?? 2048),
    "--out", outPath,
    // Free models — no input/output cost.
    "--price-in", "0",
    "--price-out", "0",
  ];
  if (args["case-limit"]) {
    cliArgs.push("--case-limit", String(args["case-limit"]));
  }

  // Wrapper that injects an inter-request delay via env so the harness's per-case
  // calls are throttled. The harness already serializes when concurrency=1.
  const env = { ...process.env, LAIBENCH_INTER_REQ_SLEEP_MS: String(sleepMs) };
  const result = spawnSync("npx", ["tsx", ...cliArgs], { cwd: process.cwd(), env, stdio: "inherit" });

  if (result.status !== 0) {
    console.error(`  ✖ failed (exit ${result.status}). Skipping to next model.`);
    failed.push({ model: model.id, outPath, exitCode: result.status });
  } else {
    completed.push({ model: model.id, outPath, status: "ok" });
  }

  // Cool-down between models (avoid hitting rate limits across models on same account)
  if (i < FREE_MODELS.length - 1) {
    const cooldown = 10000;
    console.log(`  cooling down ${cooldown / 1000}s before next model...`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cooldown);
  }
}

const summaryPath = resolve(outDir, "matrix-summary.json");
writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      suite,
      judge: null,
      sleepMs,
      models: FREE_MODELS,
      completed,
      failed,
    },
    null,
    2,
  ),
);

console.log(`\n=== summary ===`);
console.log(`Completed: ${completed.length}/${FREE_MODELS.length}`);
console.log(`Failed: ${failed.length}`);
console.log(`Summary: ${summaryPath}`);

if (failed.length > 0) {
  console.log(`\nRetry failed models with: --skip-existing`);
  process.exit(2);
}
