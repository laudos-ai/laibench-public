#!/usr/bin/env node
// Convert a suite run artifact into a frozen-predictions JSONL so results can be
// re-scored offline (eval-submission) after harness changes — no new provider calls.
//
// Usage: node scripts/run-to-predictions.mjs runs/foo.json predictions/foo.jsonl

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node scripts/run-to-predictions.mjs <run.json> <out.jsonl>");
  process.exit(1);
}

const run = JSON.parse(readFileSync(inPath, "utf8"));
const lines = run.results.map((r) =>
  JSON.stringify({
    instance_id: r.case.id,
    model_name_or_path: run.manifest.modelLabel ?? run.manifest.runName,
    model_output: r.rawHtml,
    metadata: { latencyMs: r.latencyMs ?? null, costUsd: r.costUsd ?? 0 },
  })
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`Wrote ${lines.length} predictions to ${outPath}`);
