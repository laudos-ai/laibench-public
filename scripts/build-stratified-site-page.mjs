#!/usr/bin/env node
// Build a public static page from a stratified comparison JSON artifact.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function usage() {
  console.error("Usage: node scripts/build-stratified-site-page.mjs --in <report.json> --out <site/stratified/index.html> [--json-out <site/stratified/report.json>]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) usage();
    args[key.slice(2)] = argv[++i];
  }
  if (!args.in || !args.out) usage();
  return args;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
  })[char]);
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Number(value).toFixed(1)}%`;
}

function signed(value) {
  const n = Number(value ?? 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

function compactList(items, limit = 6) {
  const values = Array.from(new Set(items ?? [])).filter(Boolean);
  if (values.length === 0) return "-";
  const shown = values.slice(0, limit).map(esc).join(", ");
  const remaining = values.length - limit;
  return remaining > 0 ? `${shown} <span class="more">+${remaining} more</span>` : shown;
}

function compactCaseSummary(items, limit = 5) {
  const values = Array.from(new Set(items ?? [])).filter(Boolean);
  if (values.length === 0) return "no listed cases";
  return `${values.length} ${plural(values.length, "case")}: ${compactList(values, limit)}`;
}

function renderRows(report) {
  return report.strata.map((s) => `
    <tr>
      <td>${esc(s.label)}</td>
      <td class="num">${s.aSystemFailures}</td>
      <td class="num">${s.bSystemFailures}</td>
      <td class="num">${s.aReviewNeeded}</td>
      <td class="num">${s.bReviewNeeded}</td>
      <td class="num">${s.aEvaluatorLimitations}</td>
      <td class="num">${s.bEvaluatorLimitations}</td>
      <td class="num strong">${Number(s.aSystemWeighted).toFixed(1)}</td>
      <td class="num strong">${Number(s.bSystemWeighted).toFixed(1)}</td>
      <td>${compactCaseSummary(s.bOnlyCases)}</td>
    </tr>`).join("");
}

function renderCaseCards(report) {
  return report.executiveReadout.largestCaseWins.map((c) => `
    <article class="case-card">
      <div>
        <h3>${esc(c.id)}</h3>
        <p>${esc(c.exam)}</p>
      </div>
      <div class="case-score">${signed(c.delta)} pp</div>
      <p class="case-detail">${esc(report.labels.a)} ${pct(c.aScore)} vs ${esc(report.labels.b)} ${pct(c.bScore)}</p>
      <p class="case-detail">B-only strata: ${compactList(c.bOnlyStrata, 4)}</p>
    </article>`).join("");
}

function renderTopDeltas(report) {
  return report.executiveReadout.topSystemDeltas.map((s) => `
    <li>
      <b>${esc(s.label)}</b>
      <span>+${Number(s.bSystemExcessWeight).toFixed(1)} system-weight; ${s.bSystemExcessFailures} excess system errors; ${compactCaseSummary(s.bExcessCases)}</span>
    </li>`).join("");
}

function renderReviewQueue(report) {
  const rows = report.executiveReadout.reviewStrata ?? [];
  if (rows.length === 0) return "none.";
  return rows.map((s) => {
    const caseIds = [...(s.aOnlyCases ?? []), ...(s.bOnlyCases ?? []), ...(s.sharedCases ?? [])];
    return `${esc(s.label)}: ${esc(report.labels.a)} ${s.aReviewNeeded}, ${esc(report.labels.b)} ${s.bReviewNeeded}; ${compactCaseSummary(caseIds, 8)}`;
  }).join("; ") + ".";
}

function renderPage(report) {
  const totals = report.executiveReadout.totals;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LAIBench Pro - Stratified audit</title>
<meta name="description" content="Concise public stratified audit for LAIBench Pro." />
<style>
  :root{--bg:#f4f7f8;--ink:#181b1d;--muted:#697174;--line:#d8e0e2;--panel:#ffffff;--teal:#0d8068;--teal-soft:#dff3ec;--warn:#6f5b00;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:42px 0 56px}
  a{color:var(--teal);text-decoration:none} a:hover{text-decoration:underline}
  .topbar{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:34px}
  .brand{font-size:21px;letter-spacing:-.01em}.brand b{font-weight:700}
  .crumb{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  h1{font-size:48px;line-height:1.02;letter-spacing:-.03em;margin:0 0 14px;max-width:820px}
  .lede{font-size:19px;line-height:1.55;color:var(--muted);max-width:860px;margin:0 0 28px}
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}
  .metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;min-height:116px}
  .metric span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-bottom:18px}
  .metric b{font-size:31px;letter-spacing:-.02em}.metric small{font-size:14px;color:var(--muted);font-weight:500;margin-left:5px}
  .metric.primary{background:var(--teal);border-color:var(--teal);color:white}.metric.primary span,.metric.primary small{color:rgba(255,255,255,.75)}
  section{margin-top:34px}
  h2{font-size:24px;letter-spacing:-.01em;margin:0 0 14px}
  .readout{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;align-items:start}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:22px}
  .panel p{margin:0 0 12px;color:var(--muted);line-height:1.55}
  .audit-points{display:grid;gap:12px;margin-top:16px}
  .audit-point{border-top:1px solid var(--line);padding-top:12px}
  .audit-point b{display:block;margin-bottom:4px}
  .audit-point span{color:var(--muted);line-height:1.5}
  .delta-list{list-style:none;padding:0;margin:0;display:grid;gap:10px}
  .delta-list li{display:grid;gap:5px;border-bottom:1px solid var(--line);padding-bottom:10px}
  .delta-list li:last-child{border-bottom:0;padding-bottom:0}
  .delta-list b{font-size:16px}.delta-list span{color:var(--muted);line-height:1.45}
  .more{color:var(--teal);white-space:nowrap}
  .case-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
  .case-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:12px;min-height:250px}
  .case-card h3{margin:0;font-size:16px}.case-card p{margin:7px 0 0;color:var(--muted);font-size:13px;line-height:1.4}
  .case-score{font-size:28px;font-weight:700;color:var(--teal);letter-spacing:-.02em}
  .case-detail{font-size:13px!important}
  .table-wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
  table{width:100%;border-collapse:collapse;min-width:1040px;font-size:14px}
  th,td{padding:12px 13px;border-bottom:1px solid var(--line);vertical-align:top}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
  tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}.strong{font-weight:700}
  .review{background:var(--teal-soft);border:1px solid #b9dfd3;border-radius:8px;padding:18px;color:#245548;line-height:1.55}
  .review b{color:var(--ink)}
  footer{margin-top:34px;color:var(--muted);font-size:13px;line-height:1.5}
  @media(max-width:900px){h1{font-size:36px}.summary{grid-template-columns:repeat(2,1fr)}.readout{grid-template-columns:1fr}.case-grid{grid-template-columns:1fr 1fr}}
  @media(max-width:560px){main{width:min(100% - 24px,1180px);padding-top:24px}.topbar{align-items:flex-start;flex-direction:column}h1{font-size:31px}.summary,.case-grid{grid-template-columns:1fr}.metric{min-height:auto}}
</style>
</head>
<body>
<main>
  <div class="topbar">
    <div class="brand">laibench <b>pro</b></div>
    <div class="crumb"><a href="/">Leaderboard</a> / Stratified comparison</div>
  </div>

  <h1>Harness sanity check: ${esc(report.labels.a)} vs ${esc(report.labels.b)}.</h1>
  <p class="lede">This is a reference-vs-null calibration check, not a product leaderboard and not proof of full discriminative power. The public evaluator should separate fixture reference reports from a fixed unsafe null baseline; graduated controls test the middle of the curve.</p>

  <div class="summary">
    <div class="metric primary"><span>${esc(report.labels.a)} score</span><b>${pct(report.summary.aOverall)}</b><small>criteria ${pct(report.summary.aCriterionPass)}</small></div>
    <div class="metric"><span>${esc(report.labels.b)} score</span><b>${pct(report.summary.bOverall)}</b><small>criteria ${pct(report.summary.bCriterionPass)}</small></div>
    <div class="metric"><span>Score delta</span><b>${signed(report.summary.delta)} pp</b><small>weighted clinical score</small></div>
    <div class="metric"><span>Zero-failure cases</span><b>${pct(report.summary.aAllPass)}</b><small>strict all-pass vs ${pct(report.summary.bAllPass)}</small></div>
  </div>

  <section class="readout">
    <div class="panel">
      <h2>How to read this sanity check</h2>
      <p><b>${esc(report.labels.a)}</b> is the public case reference side. It is useful for calibration, but it is not an upper bound on report quality. <b>${esc(report.labels.b)}</b> is a fixed null baseline that deliberately omits evidence and asserts unsafe normality.</p>
      <div class="audit-points">
        <div class="audit-point"><b>Headline metric</b><span>${pct(report.summary.aOverall)} vs ${pct(report.summary.bOverall)} is weighted clinical score. The delta is ${signed(report.summary.delta)} pp.</span></div>
        <div class="audit-point"><b>Strict all-pass</b><span>${pct(report.summary.aAllPass)} vs ${pct(report.summary.bAllPass)} is zero-failure case completion: every criterion in a case passed simultaneously. It is a conjunctive diagnostic, not the headline grade.</span></div>
        <div class="audit-point"><b>Adjudication</b><span>System errors are likely output failures; review-needed items require clinical adjudication; evaluator limitations are detector noise. Current review queue: ${esc(report.labels.a)} ${totals.aReviewNeeded}, ${esc(report.labels.b)} ${totals.bReviewNeeded}.</span></div>
        <div class="audit-point"><b>Guideline labels</b><span>Guideline classification is label-driven in this release: only explicit or reference-declared RADS expectations are scored. Unlabeled classifications are not inferred from incidental anatomy.</span></div>
        <div class="audit-point"><b>Calibration limit</b><span>This null-baseline spread proves the harness is not inverted. It does not by itself prove sensitivity to subtle omissions, partial degradation, or realistic hallucinations; those require the graduated controls generated from the public gold labels.</span></div>
      </div>
    </div>
    <div class="panel">
      <h2>Top adjudicated deltas</h2>
      <ul class="delta-list">${renderTopDeltas(report)}</ul>
    </div>
  </section>

  <section>
    <h2>Case-level separation examples</h2>
    <div class="case-grid">${renderCaseCards(report)}</div>
  </section>

  <section>
    <h2>Error strata</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Stratum</th><th class="num">A system</th><th class="num">B system</th><th class="num">A review</th><th class="num">B review</th><th class="num">A evaluator</th><th class="num">B evaluator</th><th class="num">A weight</th><th class="num">B weight</th><th>B-only cases</th>
          </tr>
        </thead>
        <tbody>${renderRows(report)}</tbody>
      </table>
    </div>
  </section>

  <section class="review">
    <b>Review queue:</b> ${renderReviewQueue(report)}
  </section>

  <footer>
    Generated from the tracked stratified JSON artifact. Download the <a href="report.json">public report JSON</a>. Source and harness are open source on <a href="https://github.com/Vajbratya/laibench-pro" target="_blank" rel="noopener">GitHub</a>.
  </footer>
</main>
</body>
</html>
`;
}

const args = parseArgs(process.argv.slice(2));
const report = JSON.parse(readFileSync(args.in, "utf8"));
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, renderPage(report));
console.log(`Wrote ${args.out}`);
if (args["json-out"]) {
  mkdirSync(dirname(args["json-out"]), { recursive: true });
  writeFileSync(args["json-out"], JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${args["json-out"]}`);
}
