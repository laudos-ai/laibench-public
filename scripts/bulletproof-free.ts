#!/usr/bin/env npx tsx
/**
 * Bulletproof free-model generator for the en-US public-smoke suite.
 *
 * Decouples GENERATION (rate-limited, here) from SCORING (deterministic
 * eval-submission, later). Generation:
 *   - prompt is byte-identical to the engine (imports the real locale + classify)
 *   - per-case UNBOUNDED-ish retry (40 attempts) honoring Retry-After, exp backoff
 *   - empty-content responses are retried (free models return "" under load)
 *   - FATAL statuses (400/401/403/404) abort that model immediately (no wasted time)
 *   - resume-capable: predictions JSONL is appended per case; reruns skip done cases
 *   - global serial throttle (one request at a time, BASE_SLEEP between successes)
 *
 * Run:  OPENROUTER_API_KEY=... npx tsx scripts/bulletproof-free.ts
 * Probe: ... npx tsx scripts/bulletproof-free.ts --probe
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getLocale } from "../src/locales/index.js";
import { deriveExamMeta } from "../src/classify.js";

const API = "https://openrouter.ai/api/v1/chat/completions";
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("Missing OPENROUTER_API_KEY"); process.exit(1); }

const PROBE = process.argv.includes("--probe");
const BASE_SLEEP = Number(process.env.BASE_SLEEP_MS ?? 5000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 40);

const MODELS = [
  { id: "cohere/north-mini-code:free",                                   slug: "north-mini-code",       label: "North Mini Code · Cohere" },
  { id: "poolside/laguna-m.1:free",                                      slug: "laguna-m1",             label: "Laguna M.1 · Poolside" },
  { id: "openai/gpt-oss-120b:free",                                      slug: "gpt-oss-120b",          label: "gpt-oss-120b · OpenAI" },
  { id: "openai/gpt-oss-20b:free",                                       slug: "gpt-oss-20b",           label: "gpt-oss-20b · OpenAI" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",            slug: "nemotron-3-nano-omni",  label: "Nemotron 3 Nano Omni 30B · NVIDIA" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free",                        slug: "nemotron-3-super-120b", label: "Nemotron 3 Super 120B · NVIDIA" },
  { id: "google/gemma-4-31b-it:free",                                    slug: "gemma-4-31b",           label: "Gemma 4 31B · Google" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free",                        slug: "nemotron-3-ultra-550b", label: "Nemotron 3 Ultra 550B · NVIDIA" },
];

type Case = { id: string; exam: string; findings: string };
const cases: Case[] = JSON.parse(readFileSync(resolve("cases/public/synthetic-demo.en-US.json"), "utf8"));
const locale = getLocale("en-US");
const sys = (c: Case) => locale.buildSystemPrompt(deriveExamMeta(c.exam, c.findings, "en-US"));
const usr = (c: Case) => `Exam: ${c.exam}\nFindings: ${c.findings}\n\nGenerate the complete radiology report. Output only HTML.`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Gen = { status: "ok"; html: string } | { status: "fatal"; reason: string } | { status: "exhausted" };

async function genOne(model: string, c: Case): Promise<Gen> {
  const body = JSON.stringify({
    model, temperature: 0.2, max_tokens: 4096,
    messages: [{ role: "system", content: sys(c) }, { role: "user", content: usr(c) }],
    provider: { data_collection: "allow", allow_fallbacks: true },
  });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "HTTP-Referer": "https://laudos.ai", "X-Title": "laibench" },
        body,
      });
      if (res.ok) {
        const j: any = await res.json();
        const out: string = j?.choices?.[0]?.message?.content ?? "";
        if (out && out.trim().length > 0) return { status: "ok", html: out };
        const w = Math.min(5000 * attempt, 60000);
        console.log(`      ${c.id} empty-content, retry ${attempt}/${MAX_ATTEMPTS} (+${Math.round(w / 1000)}s)`);
        await sleep(w); continue;
      }
      const txt = await res.text().catch(() => "");
      if ([400, 401, 403, 404].includes(res.status)) return { status: "fatal", reason: `${res.status}: ${txt.slice(0, 160)}` };
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120000) : Math.min(4000 * Math.pow(1.6, attempt), 90000);
      const jit = wait * 0.25 * Math.random();
      console.log(`      ${c.id} HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS} (+${Math.round((wait + jit) / 1000)}s)`);
      await sleep(wait + jit);
    } catch (e: any) {
      const wait = Math.min(4000 * Math.pow(1.6, attempt), 90000);
      console.log(`      ${c.id} neterr ${String(e?.message).slice(0, 80)}, retry ${attempt}/${MAX_ATTEMPTS} (+${Math.round(wait / 1000)}s)`);
      await sleep(wait);
    }
  }
  return { status: "exhausted" };
}

mkdirSync("predictions/free49", { recursive: true });
const ONLY = process.env.MODEL_SLUG;
const selected = ONLY ? MODELS.filter((m) => m.slug === ONLY) : MODELS;
if (ONLY && selected.length === 0) { console.error(`No model with slug=${ONLY}`); process.exit(1); }
const models = PROBE ? [MODELS[2]] : selected; // probe: gpt-oss-120b only
const limit = PROBE ? 2 : cases.length;

for (const m of models) {
  const out = `predictions/free49/${m.slug}.jsonl`;
  const done = new Set<string>();
  if (existsSync(out)) for (const ln of readFileSync(out, "utf8").split("\n")) { if (ln.trim()) try { done.add(JSON.parse(ln).instance_id); } catch {} }
  const target = cases.slice(0, limit);
  console.log(`\n=== ${m.id}  (${done.size}/${target.length} done) ===`);
  let fatal = false;
  for (const c of target) {
    if (done.has(c.id)) continue;
    const r = await genOne(m.id, c);
    if (r.status === "fatal") { console.log(`  !! FATAL ${m.id}: ${r.reason} — aborting model`); fatal = true; break; }
    if (r.status === "exhausted") { console.log(`  ~~ exhausted ${c.id} — leaving incomplete (rerun will retry)`); continue; }
    appendFileSync(out, JSON.stringify({ instance_id: c.id, model_name_or_path: m.id, model_output: r.html }) + "\n");
    done.add(c.id);
    console.log(`  OK ${c.id}  (${done.size}/${target.length})`);
    await sleep(BASE_SLEEP);
  }
  console.log(`=== ${m.id}: ${done.size}/${target.length} complete${fatal ? " (FATAL — model unavailable)" : ""} ===`);
}
console.log("\nALL MODELS PROCESSED");
