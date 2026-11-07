#!/usr/bin/env tsx
/**
 * Public discrimination ladder (v3.11.0).
 *
 * Does the score go DOWN when the report gets WORSE — and does every critical
 * error hit the floor? This runs entirely on the public synthetic en-US cases,
 * no answer keys needed: the input findings are the evidence.
 *
 * For each case it builds the template reference report (examples/
 * reference-agent.mjs), then injects exactly one graded error per rung by
 * perturbing the findings text BEFORE the report is built (so the error flows
 * into the impression the way a model's error would), and scores every report
 * against the ORIGINAL case with the real scorer (benchmarkCase, no judge).
 *
 *   L0 reference              faithful restructuring
 *   L1 measurement drift      first measurement changed
 *   L2 non-critical omission  one non-critical abnormal sentence dropped
 *   L3 laterality swap        first right/left in an abnormal sentence swapped
 *   L4 critical denied        the critical sentence replaced by "No <term>."
 *   L5 critical omitted       sentences carrying an input critical dropped
 *   L6 critical fabricated    a region-plausible critical added
 *   L7 null report            "No acute abnormality." for an abnormal study
 *
 * Rungs only apply where meaningful (e.g. L4/L5 only on cases whose input
 * affirms a critical); `n` is reported per rung and drops are PAIRED against the
 * same case's L0 score.
 *
 * Usage:
 *   npx tsx scripts/public-ladder.ts [--src ./src] [--out site/ladder.json] [--markdown docs/public-ladder.md]
 */
import { RUNGS, perturb, regionOf } from "./ladder-core.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-ignore — plain ESM helper shared with the website playground
import { buildReferenceReport } from "../examples/reference-agent.mjs";

type Verdict = "PASS" | "PARTIAL" | "FAIL";
function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = resolve(dirname(new URL(import.meta.url).pathname), "..");
const srcDir = resolve(arg("src", resolve(repo, "src"))!);
const outPath = arg("out", resolve(repo, "site/ladder.json"));
const mdPath = arg("markdown");
// Optional: embed a ladder produced by an earlier scoring version for comparison.
const previousPath = arg("previous");
const suitePath = resolve(repo, "suites/lite-public.en-US.json");

const { benchmarkCase } = await import(pathToFileURL(resolve(srcDir, "benchmark.ts")).href);
const { suiteHashFromCases } = await import(pathToFileURL(resolve(srcDir, "provenance.ts")).href);
const suite = JSON.parse(readFileSync(suitePath, "utf8"));
const cases = JSON.parse(readFileSync(resolve(dirname(suitePath), suite.casesPath), "utf8"));

type Cell = { score: number; verdict: Verdict; criticalVeto: boolean; gateReasons: string[]; failedCritical: string[] };
const perCase: Array<{ id: string; label: string; region: string; cells: Record<string, Cell | null> }> = [];

for (const c of cases) {
  const region = regionOf(c.exam);
  const cells: Record<string, Cell | null> = {};
  for (const rung of RUNGS) {
    const findings = perturb(rung.id, c.findings, region);
    if (findings == null) { cells[rung.id] = null; continue; }
    const html = buildReferenceReport({ exam: c.exam, findings, locale: "en-US" });
    const r = await benchmarkCase({ case: c, locale: "en-US", providedHtml: html, providerLabel: "ladder", modelLabel: rung.id });
    const failedCritical = r.checks.filter((k: { passed: boolean; severity: string }) => !k.passed && k.severity === "critical").map((k: { id: string }) => k.id);
    cells[rung.id] = {
      score: r.combinedOverall,
      verdict: r.verdict,
      criticalVeto: r.verdict === "FAIL" && failedCritical.length > 0,
      gateReasons: r.gateReasons,
      failedCritical,
    };
  }
  perCase.push({ id: c.id, label: c.label, region, cells });
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const levels = RUNGS.map((rung) => {
  const rows = perCase.filter((p) => p.cells[rung.id] && p.cells.L0);
  const n = rows.length;
  const scores = rows.map((p) => p.cells[rung.id]!.score);
  const drops = rows.map((p) => p.cells.L0!.score - p.cells[rung.id]!.score);
  const pct = (k: number) => (n ? round1((100 * k) / n) : null);
  return {
    id: rung.id,
    label: rung.label,
    description: rung.description,
    critical: rung.critical,
    n,
    meanScore: n ? round1(scores.reduce((a, b) => a + b, 0) / n) : null,
    passRate: pct(rows.filter((p) => p.cells[rung.id]!.verdict === "PASS").length),
    failRate: pct(rows.filter((p) => p.cells[rung.id]!.verdict === "FAIL").length),
    criticalVetoRate: pct(rows.filter((p) => p.cells[rung.id]!.criticalVeto).length),
    meanDrop: n ? round1(drops.reduce((a, b) => a + b, 0) / n) : null,
    // Share of cases whose score went DOWN vs their own reference (L0 is 0 by definition).
    detectedRate: rung.id === "L0" ? null : pct(drops.filter((d) => d > 0).length),
  };
});

const benchmarkVersion = suite.benchmarkVersion;
// When --src points at an older scorer, record which scoring version produced
// the numbers (the suite manifest only says which suite was used).
const scoredWith = arg("scored-with", benchmarkVersion);
const out = {
  title: "LAIBench public discrimination ladder",
  benchmarkVersion,
  scoredWith,
  suite: suite.id,
  suiteHash: suiteHashFromCases(cases),
  cases: cases.length,
  agent: "examples/reference-agent.mjs (template reference, deterministic)",
  scorer: "benchmarkCase, deterministic only (no LLM judge), conservative-min",
  note: "Synthetic public cases, input-only (no answer keys). Each rung injects one error into the reference report; drops are paired against the same case's reference score. Not a clinical validation.",
  levels,
  previous: previousPath
    ? (() => {
        const prev = JSON.parse(readFileSync(resolve(previousPath), "utf8"));
        return { benchmarkVersion: prev.scoredWith ?? prev.benchmarkVersion, levels: prev.levels };
      })()
    : null,
  perCase,
};

if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`Wrote ${outPath}`);
}
if (mdPath) {
  const lines = [
    `# Public discrimination ladder — LAIBench ${benchmarkVersion}`,
    "",
    `Suite \`${suite.id}\` (${cases.length} synthetic cases, suiteHash \`${out.suiteHash.slice(0, 16)}…\`). Template reference agent, deterministic scorer, no judge. Regenerate with \`npx tsx scripts/public-ladder.ts --markdown docs/public-ladder.md\`.`,
    "",
    "| Rung | Error injected | n | Mean score | PASS | FAIL | Critical veto | Score dropped |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...levels.map((l) => `| ${l.id} | ${l.label} | ${l.n} | ${l.meanScore ?? "—"} | ${l.passRate ?? "—"}% | ${l.failRate ?? "—"}% | ${l.criticalVetoRate ?? "—"}% | ${l.detectedRate == null ? "—" : `${l.detectedRate}%`} |`),
    "",
    ...(out.previous
      ? [
          `## Same ladder under the previous scorer (${out.previous.benchmarkVersion})`,
          "",
          "| Rung | Error injected | PASS (prev) | PASS (now) | Critical veto (prev) | Critical veto (now) |",
          "| --- | --- | ---: | ---: | ---: | ---: |",
          ...levels.map((l) => {
            const p = out.previous!.levels.find((x: { id: string }) => x.id === l.id);
            return `| ${l.id} | ${l.label} | ${p?.passRate ?? "—"}% | ${l.passRate ?? "—"}% | ${p?.criticalVetoRate ?? "—"}% | ${l.criticalVetoRate ?? "—"}% |`;
          }),
          "",
        ]
      : []),
    out.note,
    "",
  ];
  mkdirSync(dirname(resolve(mdPath)), { recursive: true });
  writeFileSync(resolve(mdPath), lines.join("\n"));
  console.log(`Wrote ${mdPath}`);
}
console.table(levels.map(({ description, ...rest }) => rest));
