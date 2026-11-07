#!/usr/bin/env tsx
/**
 * Calibrate the decision judge on the public discrimination ladder.
 *
 * Ground truth comes from construction, not from another model: each ladder
 * rung injects exactly one known error into the input findings before the
 * reference report is built (scripts/ladder-core.ts), so for every question the
 * decision judge asks we know the right answer. This measures whether the
 * judge's probabilities can be trusted before it is allowed anywhere near a
 * published score.
 *
 * Adoption gate (printed and written to the JSON):
 *   1. zero vetoes and zero QUAL penalties on L0 references (a lower-only judge
 *      must never punish a faithful report);
 *   2. veto recall on the critical rungs (L4-L7) reported per rung;
 *   3. calibration error (ECE) per question kind <= 0.10.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npx tsx scripts/decision-calibrate.ts \
 *     [--model <vendor>/<model>-<version>] [--out calibration/decision-judge.json] \
 *     [--markdown docs/decision-judge-calibration.md] [--limit N] [--concurrency 6] [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RUNGS, perturb, regionOf } from "./ladder-core.ts";
import {
  LOWER_P, VETO_P,
  affirmedInputCriticals, buildDecisionRequest, decisionJudgeConfigHash, decisionsToJudge, errorProbability,
  type QuestionMeta,
} from "../src/decision-judge.ts";
import { abnormalInputClauses } from "../src/evaluators/source-findings.ts";
import { listCriticalOccurrences } from "../src/extract.ts";
import { buildDecisionsClient, type DecisionResponse } from "../src/providers/decisions.ts";
// @ts-ignore — plain ESM helper shared with the website playground
import { buildReferenceReport } from "../examples/reference-agent.mjs";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const repo = resolve(dirname(new URL(import.meta.url).pathname), "..");
const dryRunFlag = process.argv.includes("--dry-run");
const model = arg("model") ?? process.env.LAIBENCH_DECISION_MODEL ?? (dryRunFlag ? "unset/decision-model-0.0" : null);
if (!model) { console.error("Set LAIBENCH_DECISION_MODEL (or --model) to a pinned decision model id."); process.exit(2); }
const outPath = resolve(repo, arg("out", "calibration/decision-judge.json")!);
const mdPath = arg("markdown");
const limit = Number(arg("limit", "0")) || 0;
const concurrency = Math.max(1, Number(arg("concurrency", "6")) || 6);
const dryRun = flag("dry-run");
/** Input price per million tokens, for estimates only (actual cost comes from the API usage). */
const USD_PER_M_INPUT = Number(arg("usd-per-m-input") ?? process.env.LAIBENCH_DECISION_USD_PER_M_INPUT ?? NaN);

const suite = JSON.parse(readFileSync(resolve(repo, "suites/lite-public.en-US.json"), "utf8"));
let cases = JSON.parse(readFileSync(resolve(repo, "suites", suite.casesPath), "utf8")) as Array<{ id: string; exam: string; findings: string }>;
if (limit > 0) cases = cases.slice(0, limit);

type Label = boolean | null; // null = no defensible ground truth for this question on this rung (excluded)
type CritLabel = "kept" | "other_side" | "stated_absent" | "not_mentioned";

const MEASURE_RX = /\d+(?:\.\d+)?\s*(?:mm|cm)\b/gi;
const measures = (t: string) => (t.match(MEASURE_RX) ?? []).map((m) => m.replace(/\s+/g, "").toLowerCase()).sort().join("|");

function critLabel(category: string, originalSide: string | null, perturbed: string): CritLabel {
  const occ = listCriticalOccurrences(perturbed, "en-US").filter((o) => o.category === category);
  if (occ.length === 0) return "not_mentioned";
  const affirmed = affirmedInputCriticals(perturbed, "en-US").find((c) => c.category === category);
  if (!affirmed) return "stated_absent";
  if (originalSide && affirmed.side && affirmed.side !== originalSide) return "other_side";
  return "kept";
}

function nounLabels(rung: string, original: string, perturbed: string, critSideChanged: boolean): Record<string, Label> {
  const nowNormal = abnormalInputClauses(perturbed, "en-US").length === 0 && abnormalInputClauses(original, "en-US").length > 0;
  return {
    invents_critical: rung === "L6" ? true : rung === "L3" && critSideChanged ? null : false,
    normal_despite_abnormal: nowNormal,
    abnormal_omitted: rung === "L2" || rung === "L5" || rung === "L7" ? true : rung === "L4" ? null : false,
    side_changed: rung === "L3",
    measurement_changed: measures(original) !== measures(perturbed),
    self_contradiction: false,
  };
}

type Item = { caseId: string; rung: string; html: string; findings: string; exam: string; perturbed: string };
const items: Item[] = [];
for (const c of cases) {
  const region = regionOf(c.exam);
  for (const r of RUNGS) {
    const perturbed = perturb(r.id, c.findings, region);
    if (perturbed == null) continue;
    items.push({ caseId: c.id, rung: r.id, exam: c.exam, findings: c.findings, perturbed, html: buildReferenceReport({ exam: c.exam, findings: perturbed, locale: "en-US" }) });
  }
}

if (dryRun) {
  let chars = 0, questions = 0;
  for (const it of items) {
    const { request } = buildDecisionRequest({ id: it.caseId, exam: it.exam, findings: it.findings }, "en-US", it.html, model);
    chars += JSON.stringify({ state: request.state, questions: request.questions }).length;
    questions += Object.keys(request.questions).length;
  }
  const tokens = Math.round(chars / 4);
  console.log(JSON.stringify({ dryRun: true, model, requests: items.length, questions, estInputTokens: tokens, estCostUsd: Number.isFinite(USD_PER_M_INPUT) ? +(tokens * USD_PER_M_INPUT / 1e6).toFixed(4) : null }, null, 2));
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error("OPENROUTER_API_KEY is not set. Use --dry-run to estimate cost without calling the API."); process.exit(2); }
const client = buildDecisionsClient(apiKey, { url: arg("endpoint") ?? undefined });

type Row = { caseId: string; rung: string; meta: QuestionMeta[]; response: DecisionResponse | null; error?: string };
const rows: Row[] = new Array(items.length);
let next = 0;
async function worker() {
  while (next < items.length) {
    const i = next++;
    const it = items[i];
    const { request, meta } = buildDecisionRequest({ id: `${it.caseId}:${it.rung}`, exam: it.exam, findings: it.findings }, "en-US", it.html, model);
    try {
      rows[i] = { caseId: it.caseId, rung: it.rung, meta, response: await client(request) };
    } catch (e) {
      rows[i] = { caseId: it.caseId, rung: it.rung, meta, response: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

// ---- scoring the judge against construction ground truth ----
type Obs = { p: number; y: boolean; threshold: number };
const byKind = new Map<string, Obs[]>();
const push = (kind: string, o: Obs) => { if (!byKind.has(kind)) byKind.set(kind, []); byKind.get(kind)!.push(o); };
const perRung = new Map<string, { n: number; vetoed: number; qualLowered: number; review: number }>();
let cost = 0; const latencies: number[] = []; let failed = 0; let resolvedModel = model;

for (const [i, row] of rows.entries()) {
  const it = items[i];
  const pr = perRung.get(row.rung) ?? { n: 0, vetoed: 0, qualLowered: 0, review: 0 };
  perRung.set(row.rung, pr);
  if (!row.response) { failed++; continue; }
  resolvedModel = row.response.model;
  cost += row.response.usage.costUsd ?? (Number.isFinite(USD_PER_M_INPUT) ? row.response.usage.inputTokens * USD_PER_M_INPUT / 1e6 : 0);
  latencies.push(row.response.ms);
  const { judge, flags } = decisionsToJudge(row.meta, row.response.answers);
  pr.n++;
  if (judge.critical_failures.length) pr.vetoed++;
  if ((judge.scores.QUAL ?? 100) < 100) pr.qualLowered++;
  if (flags.some((f) => f.band === "review" || f.band === "refused")) pr.review++;

  const crits = affirmedInputCriticals(it.findings, "en-US");
  const critLabels = new Map(crits.map((c) => [c.category, critLabel(c.category, c.side, it.perturbed)]));
  const critSideChanged = [...critLabels.values()].includes("other_side");
  const labels = nounLabels(row.rung, it.findings, it.perturbed, critSideChanged);
  for (const m of row.meta) {
    const { p, detail } = errorProbability(m, row.response.answers[m.key]);
    if (p === null) continue;
    if (m.kind === "critical_handling") {
      const y = critLabels.get(m.category!) ?? "kept";
      push("critical_handling", { p, y: y !== "kept", threshold: detail === "side_dropped" ? LOWER_P : VETO_P });
      continue;
    }
    const y = labels[m.kind];
    if (y === null || y === undefined) continue;
    push(m.kind, { p, y, threshold: m.kind === "invents_critical" || m.kind === "normal_despite_abnormal" ? VETO_P : LOWER_P });
  }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
function ece(obs: Obs[], bins = 10): number {
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const inBin = obs.filter((o) => o.p >= b / bins && (b === bins - 1 ? o.p <= 1 : o.p < (b + 1) / bins));
    if (!inBin.length) continue;
    const conf = inBin.reduce((a, o) => a + o.p, 0) / inBin.length;
    const acc = inBin.filter((o) => o.y).length / inBin.length;
    total += (inBin.length / obs.length) * Math.abs(conf - acc);
  }
  return total;
}
const kinds = [...byKind.entries()].map(([kind, obs]) => {
  const pos = obs.filter((o) => o.y), neg = obs.filter((o) => !o.y);
  return {
    kind,
    n: obs.length,
    positives: pos.length,
    brier: r3(obs.reduce((a, o) => a + (o.p - (o.y ? 1 : 0)) ** 2, 0) / obs.length),
    ece: r3(ece(obs)),
    accuracyAt05: r3(obs.filter((o) => (o.p >= 0.5) === o.y).length / obs.length),
    recallAtThreshold: pos.length ? r3(pos.filter((o) => o.p >= o.threshold).length / pos.length) : null,
    falsePositiveRateAtThreshold: neg.length ? r3(neg.filter((o) => o.p >= o.threshold).length / neg.length) : null,
  };
}).sort((a, b) => a.kind.localeCompare(b.kind));

const rungs = RUNGS.map((r) => {
  const pr = perRung.get(r.id) ?? { n: 0, vetoed: 0, qualLowered: 0, review: 0 };
  return { id: r.id, label: r.label, critical: r.critical, n: pr.n, vetoRate: pr.n ? r3(pr.vetoed / pr.n) : null, qualLoweredRate: pr.n ? r3(pr.qualLowered / pr.n) : null, reviewRate: pr.n ? r3(pr.review / pr.n) : null };
});
const l0 = rungs.find((r) => r.id === "L0")!;
const gate = {
  noFalseVetoOnReferences: (l0.vetoRate ?? 1) === 0,
  noFalsePenaltyOnReferences: (l0.qualLoweredRate ?? 1) === 0,
  eceAtMost010: kinds.every((k) => k.ece <= 0.1),
  criticalRungVetoRecall: Object.fromEntries(rungs.filter((r) => r.critical).map((r) => [r.id, r.vetoRate])),
};
const adoptable = gate.noFalseVetoOnReferences && gate.noFalsePenaltyOnReferences && gate.eceAtMost010;
latencies.sort((a, b) => a - b);
const out = {
  title: "LAIBench decision judge calibration (public ladder)",
  createdAt: new Date().toISOString(),
  model, resolvedModel,
  configHash: decisionJudgeConfigHash(model),
  thresholds: { VETO_P, LOWER_P },
  suite: suite.id,
  requests: items.length, failed,
  costUsd: r3(cost),
  latencyMsP50: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
  kinds, rungs, gate, adoptable,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.table(kinds);
console.table(rungs);
console.log(JSON.stringify({ gate, adoptable, costUsd: out.costUsd, failed }, null, 2));

if (mdPath) {
  const lines = [
    "# Decision judge calibration",
    "",
    `Model \`${resolvedModel}\` (requested \`${model}\`), config hash \`${out.configHash.slice(0, 16)}…\`, ${items.length} ladder reports, cost US$ ${out.costUsd}.`,
    "",
    "Ground truth is the ladder's construction: each rung injects one known error, so every answer is checked against a known label, not against another model.",
    "",
    "| Question | n | Positives | Brier | ECE | Acc@0.5 | Recall@threshold | FPR@threshold |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...kinds.map((k) => `| ${k.kind} | ${k.n} | ${k.positives} | ${k.brier} | ${k.ece} | ${k.accuracyAt05} | ${k.recallAtThreshold ?? "–"} | ${k.falsePositiveRateAtThreshold ?? "–"} |`),
    "",
    "| Rung | n | Veto rate | QUAL lowered | Sent to review |",
    "|---|---:|---:|---:|---:|",
    ...rungs.map((r) => `| ${r.id} ${r.label} | ${r.n} | ${r.vetoRate ?? "–"} | ${r.qualLoweredRate ?? "–"} | ${r.reviewRate ?? "–"} |`),
    "",
    `Adoption gate: ${adoptable ? "**passed**" : "**not passed**"} (no false veto on references: ${gate.noFalseVetoOnReferences}; no false penalty on references: ${gate.noFalsePenaltyOnReferences}; ECE ≤ 0.10 on every question: ${gate.eceAtMost010}).`,
    "",
  ];
  writeFileSync(resolve(repo, mdPath), lines.join("\n"));
}
