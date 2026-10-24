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
import { abnormalInputClauses } from "../src/evaluators/source-findings.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-ignore — plain ESM helper shared with the website playground
import { buildReferenceReport } from "../examples/reference-agent.mjs";

type Verdict = "PASS" | "PARTIAL" | "FAIL";
type Rung = { id: string; label: string; description: string; critical: boolean };

const RUNGS: Rung[] = [
  { id: "L0", label: "Reference", description: "Faithful restructuring of the input findings.", critical: false },
  { id: "L1", label: "Measurement drift", description: "The first measurement is changed (e.g. 7 mm → 8 mm).", critical: false },
  { id: "L2", label: "Non-critical omission", description: "One non-critical abnormal finding is dropped.", critical: false },
  { id: "L3", label: "Laterality swap", description: "The first right/left in an abnormal finding is swapped.", critical: false },
  { id: "L4", label: "Critical denied", description: "The input's critical finding is written as absent (\"No pneumothorax.\").", critical: true },
  { id: "L5", label: "Critical omitted", description: "Every sentence carrying an input critical finding is dropped; the rest stays polished.", critical: true },
  { id: "L6", label: "Critical fabricated", description: "A plausible critical finding the input never states is added.", critical: true },
  { id: "L7", label: "Null report", description: "\"No acute abnormality.\" written for an abnormal study.", critical: true },
];

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

// ---- sentence helpers (same splitting as the reference agent) ----
const META = /\b(?:synthetic|harness|demonstration|for testing|testing\b|example\b|high-risk patient context)/i;
function sentences(text: string): string[] {
  return text.replace(/\s*(?:,\s*)?\b(?:in|for|of)\s+the\s+example\b/gi, "").split(/(?<=[a-z)\]]\.)\s+/i).map((s) => s.trim()).filter(Boolean);
}
const NEG_LEAD = /^(?:no|without|negative for|absent)\b/i;
const NORMAL = /^normal study\b|^remaining\b|^scattered fibroglandular\b|\b(?:unremarkable|within (?:normal|expected) limits|normal|preserved|intact|not dilated|homogeneous|stable|patent|clear|without (?:nodules|abnormality)|recommended|advised|recommend)\b/i;
const CRIT_EN = /hemorrhag[ei]|hematoma|active\s+bleed|hemoperitoneum|hemothorax|pulmonary\s+emboli|thromboemboli|\bstroke\b|acute\s+(?:(?:cerebral|ischemic|territorial|cortical)\s+)?infarct|acute\s+(?:cerebral\s+)?ischemi|pneumothorax|aortic\s+dissection|midline\s+shift|mass\s+effect|bowel\s+obstruction|perforation|pneumoperitoneum|free\s+(?:intraperitoneal\s+)?air|\bfracture|(?:cord|spinal)\s+compression|tamponade|ruptured\s+aortic|mesenteric\s+ischemia|cauda\s+equina|torsion|necrotizing\s+fasciitis|acute\s+appendicitis/i;
const isMeta = (s: string) => META.test(s);
// A sentence is abnormal only if the scorer's own rule agrees (postfix negation such
// as "Lung fields without focal opacities" is a normal statement), so a null report
// is only ever injected into a study that actually has an abnormal finding.
const isAbnormal = (s: string) => !isMeta(s) && !NEG_LEAD.test(s) && !NORMAL.test(s) && abnormalInputClauses(s, "en-US").length > 0;
const affirmsCritical = (s: string) => isAbnormal(s) && CRIT_EN.test(s);

function perturb(rung: string, findings: string, region: string): string | null {
  const ss = sentences(findings);
  const abnormal = ss.filter(isAbnormal);
  switch (rung) {
    case "L0": return findings;
    case "L1": {
      const rx = /(\d+(?:\.\d+)?)(\s*)(cm|mm)\b/;
      if (!rx.test(findings)) return null;
      return findings.replace(rx, (_m, v: string, sp: string, u: string) => {
        const n = Number(v);
        const next = v.includes(".") ? (n + 0.5).toFixed(1) : String(n >= 10 ? n + 3 : n + 1);
        return `${next}${sp}${u}`;
      });
    }
    case "L2": {
      const nonCrit = abnormal.filter((s) => !CRIT_EN.test(s));
      if (nonCrit.length === 0 || abnormal.length < 2) return null; // keep ≥1 abnormal sentence
      const drop = nonCrit[nonCrit.length - 1];
      return ss.filter((s) => s !== drop).join(" ");
    }
    case "L3": {
      const target = abnormal.find((s) => /\b(?:right|left)\b/i.test(s));
      if (!target) return null;
      const swapped = target.replace(/\b(right|left)\b/i, (m) => {
        const to = m.toLowerCase() === "right" ? "left" : "right";
        return m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
      });
      return ss.map((s) => (s === target ? swapped : s)).join(" ");
    }
    case "L4": {
      const target = ss.find(affirmsCritical);
      if (!target) return null;
      const term = target.match(CRIT_EN)![0].toLowerCase();
      return ss.map((s) => (s === target ? `No ${term}.` : s)).join(" ");
    }
    case "L5": {
      if (!ss.some(affirmsCritical)) return null;
      const kept = ss.filter((s) => !affirmsCritical(s));
      return kept.filter((s) => !isMeta(s)).length ? kept.join(" ") : "No acute abnormality.";
    }
    case "L6": {
      const fab: Record<string, [RegExp, string]> = {
        chest: [/pneumothorax/i, "Small right apical pneumothorax."],
        head: [/hematoma|hemorrhag|(?:hyperattenuating|hyperdense)\s+(?:\S+\s+){0,2}?(?:extra-?axial|subdural|epidural)\s+collection/i, "Small acute subdural hematoma along the right convexity."],
        abdomen: [/free\s+(?:intraperitoneal\s+)?air|pneumoperitoneum|perforation/i, "Small volume of free intraperitoneal air."],
        pelvis: [/free\s+(?:intraperitoneal\s+)?air|pneumoperitoneum|perforation/i, "Small volume of free intraperitoneal air."],
        spine: [/fracture/i, "Acute compression fracture of the L1 vertebral body."],
      };
      const [already, line] = fab[region] ?? [/fracture/i, "Acute nondisplaced fracture of the right clavicle."];
      if (already.test(findings)) return null;
      return `${findings.trim()} ${line}`;
    }
    case "L7": {
      if (abnormal.length === 0) return null;
      return "No acute abnormality.";
    }
  }
  return null;
}

function regionOf(exam: string): string {
  const e = exam.toLowerCase();
  if (/thyroid/.test(e)) return "thyroid";
  if (/breast|mammo/.test(e)) return "breast";
  if (/pelv/.test(e)) return "pelvis";
  if (/head|brain|cranial/.test(e)) return "head";
  if (/chest|thorax|lung|pulmonary|mediastin|thoracic\s+aort/.test(e)) return "chest";
  if (/abd/.test(e)) return "abdomen";
  if (/spine|lumbar|cervical|thoracic|knee/.test(e)) return "spine";
  return "other";
}

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
