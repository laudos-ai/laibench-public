#!/usr/bin/env node
// Build site/data.js from run artifacts.
//
// Leaderboard policy: product agents rank first; raw/free models and harness
// baseline fixtures are shown as separate comparison/calibration sections.
//
// Usage: node scripts/build-site-data.mjs --out site/data.js \
//          --board pt-BR runs/a.json runs/b.json \
//          --board en-US runs/c.json \
//          [--reliability pt-BR runs/reliability.json]

import { readFileSync, writeFileSync } from "node:fs";
import { entryFromRun, orderEntries, LEADERBOARD_DISCLOSURE } from "./site-data-core.mjs";

const argv = process.argv.slice(2);
const boards = {};
const reliability = {};
let outPath = "site/data.js";

for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out") {
    outPath = argv[++i];
  } else if (argv[i] === "--board") {
    const locale = argv[++i];
    const files = [];
    while (argv[i + 1] && !argv[i + 1].startsWith("--")) files.push(argv[++i]);
    boards[locale] = files;
  } else if (argv[i] === "--reliability") {
    const locale = argv[++i];
    reliability[locale] = argv[++i];
  }
}

const data = { generatedAt: null, locales: {} };

for (const [locale, files] of Object.entries(boards)) {
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  // Rank within group; production agents first, then free/open model
  // comparisons, then calibration fixtures.
  // Public score is the weighted clinical score. All-pass completion is an
  // intentionally harsh diagnostic, not the headline grade for the CSV suite.
  const all = runs.map(entryFromRun);
  const entries = orderEntries(all);
  const first = runs[0];
  let rel = null;
  let relRuns = 0;
  if (reliability[locale]) {
    const r = JSON.parse(readFileSync(reliability[locale], "utf8"));
    // Headline reliability = critical-safe pass^k (the safety-critical metric).
    rel = r.passPowerKCriticalSafe ?? r.summary?.passPowerKCriticalSafe ?? null;
    if (rel != null && rel > 1) rel /= 100;
    relRuns = r.k ?? r.summary?.k ?? 0;
  }
  data.locales[locale] = {
    suite: first.manifest.suiteId,
    suiteHash: first.manifest.suiteHash,
    cases: first.results.length,
    track: first.manifest.track,
    scoring: first.manifest.scoreMode,
    entries,
    reliability: rel,
    reliabilityRuns: relRuns,
    disclosure: LEADERBOARD_DISCLOSURE,
    note:
      "Controlled benchmark preview. Production agents are ranked separately from free/open model comparisons and calibration fixtures. The public board excludes case JSON, answer keys, frozen predictions and corpus provenance. " +
      "The pt-BR controlled suite is gated and must not be treated as an open-download benchmark. Score is weighted clinical fidelity score. Strict all-pass means zero-failure cases: every criterion in a case passes simultaneously, and any critical failure forces FAIL instead of being averaged into PASS. Runs are reproducible only inside the controlled adjudication environment. " +
      "<a href=\"#methods\">Methods</a>.",
  };
}

writeFileSync(outPath, "window.LAIBENCH_DATA = " + JSON.stringify(data, null, 1) + ";\n");
console.log(`Wrote ${outPath}`);
