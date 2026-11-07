#!/usr/bin/env tsx
/**
 * Run the decision judge in SHADOW over a finished run: every case is judged,
 * the would-be combined score is computed with the real combiner, and nothing
 * in the run or on the leaderboard changes. Output:
 *
 *   <out>.json            agreement summary, per-case shadow verdicts, cost
 *   <out>.review.jsonl    adjudication queue for the human double-blind review:
 *                         cases where the judge is unsure, refused, or would
 *                         change the verdict
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npx tsx scripts/decision-shadow.ts --run runs/my-agent.json \
 *     [--model <vendor>/<model>-<version>] [--out runs/my-agent.shadow] [--concurrency 6] [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { combineScores } from "../src/scoring.ts";
import { getPolicy } from "../src/policies.ts";
import { buildDecisionRequest, decisionJudgeConfigHash, judgeCaseWithDecisions, reportPlainText, type DecisionJudgement } from "../src/decision-judge.ts";
import { buildDecisionsClient } from "../src/providers/decisions.ts";
import type { SuiteRunResult } from "../src/types.ts";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const runPath = arg("run");
if (!runPath) { console.error("Usage: decision-shadow.ts --run runs/<run>.json [--model <vendor>/<model>-<version>] [--out <prefix>] [--dry-run]"); process.exit(2); }
const dryRunFlag = process.argv.includes("--dry-run");
const model = arg("model") ?? process.env.LAIBENCH_DECISION_MODEL ?? (dryRunFlag ? "unset/decision-model-0.0" : null);
if (!model) { console.error("Set LAIBENCH_DECISION_MODEL (or --model) to a pinned decision model id."); process.exit(2); }
const outPrefix = resolve(arg("out", runPath.replace(/\.json$/, ".shadow"))!);
const concurrency = Math.max(1, Number(arg("concurrency", "6")) || 6);
/** Input price per million tokens, for estimates only (actual cost comes from the API usage). */
const USD_PER_M_INPUT = Number(arg("usd-per-m-input") ?? process.env.LAIBENCH_DECISION_USD_PER_M_INPUT ?? NaN);

const run = JSON.parse(readFileSync(resolve(runPath), "utf8")) as SuiteRunResult;
const results = run.results.filter((r) => r.normalizedHtml && r.detDims);

if (process.argv.includes("--dry-run")) {
  let chars = 0;
  for (const r of results) {
    const { request } = buildDecisionRequest(r.case, r.locale, r.normalizedHtml, model);
    chars += JSON.stringify({ state: request.state, questions: request.questions }).length;
  }
  const tokens = Math.round(chars / 4);
  console.log(JSON.stringify({ dryRun: true, model, cases: results.length, estInputTokens: tokens, estCostUsd: Number.isFinite(USD_PER_M_INPUT) ? +(tokens * USD_PER_M_INPUT / 1e6).toFixed(4) : null }, null, 2));
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error("OPENROUTER_API_KEY is not set. Use --dry-run to estimate cost."); process.exit(2); }
const client = buildDecisionsClient(apiKey, { url: arg("endpoint") ?? undefined });
const policy = run.manifest.policyId ? getPolicy(run.manifest.policyId) : undefined;

type Out = { caseId: string; officialVerdict: string; officialScore: number; shadowVerdict?: string; shadowScore?: number; judgement?: DecisionJudgement; error?: string };
const rows: Out[] = new Array(results.length);
let next = 0;
async function worker() {
  while (next < results.length) {
    const i = next++;
    const r = results[i];
    const base: Out = { caseId: r.case.id, officialVerdict: r.verdict, officialScore: r.combinedOverall };
    try {
      const judgement = await judgeCaseWithDecisions({ client, model, case: r.case, locale: r.locale, reportHtml: r.normalizedHtml });
      // Shadow score = what the deterministic channel combined with ONLY the decision judge would give.
      const shadow = combineScores(r.detDims, judgement.judge, r.checks, policy, run.manifest.scoreMode);
      rows[i] = { ...base, shadowVerdict: shadow.verdict, shadowScore: shadow.overall, judgement };
    } catch (e) {
      rows[i] = { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const ok = rows.filter((r) => r.judgement);
const changed = ok.filter((r) => r.shadowVerdict !== r.officialVerdict);
const review = ok.filter((r) => r.judgement!.needsReview || r.shadowVerdict !== r.officialVerdict);
const cost = ok.reduce((a, r) => a + (r.judgement!.usage.costUsd ?? (Number.isFinite(USD_PER_M_INPUT) ? r.judgement!.usage.inputTokens * USD_PER_M_INPUT / 1e6 : 0)), 0);
const summary = {
  title: "LAIBench decision judge shadow run",
  createdAt: new Date().toISOString(),
  run: run.manifest.runName,
  model,
  resolvedModel: ok[0]?.judgement?.model ?? null,
  configHash: decisionJudgeConfigHash(model),
  cases: results.length,
  failed: rows.length - ok.length,
  verdictAgreement: ok.length ? Math.round((1000 * (ok.length - changed.length)) / ok.length) / 1000 : null,
  verdictChanges: changed.map((r) => ({ caseId: r.caseId, from: r.officialVerdict, to: r.shadowVerdict, issues: r.judgement!.judge.critical_failures.map((f) => f.issue) })),
  sentToReview: review.length,
  costUsd: Math.round(cost * 1e6) / 1e6,
  note: "Shadow only: the official run, its scores and the leaderboard are unchanged.",
};
mkdirSync(dirname(outPrefix), { recursive: true });
writeFileSync(`${outPrefix}.json`, `${JSON.stringify({ summary, rows: rows.map(({ judgement, ...rest }) => ({ ...rest, flags: judgement?.flags ?? [] })) }, null, 2)}\n`);
const byId = new Map(results.map((r) => [r.case.id, r]));
writeFileSync(`${outPrefix}.review.jsonl`, review.map((r) => {
  const c = byId.get(r.caseId)!;
  return JSON.stringify({
    caseId: r.caseId,
    exam: c.case.exam,
    inputFindings: c.case.findings,
    report: reportPlainText(c.normalizedHtml),
    officialVerdict: r.officialVerdict,
    shadowVerdict: r.shadowVerdict,
    reasons: r.judgement!.flags.filter((f) => f.band !== "clear").map((f) => ({ question: f.term ? `${f.kind}: ${f.term}` : f.kind, pError: f.pError, band: f.band })),
  });
}).join("\n") + (review.length ? "\n" : ""));
console.log(JSON.stringify(summary, null, 2));
