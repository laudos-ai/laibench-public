#!/usr/bin/env node
// Audit failed checks across one or more run artifacts.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const STRATA = [
  { id: "critical_finding", label: "Critical / safety", match: (issue) => issue.dim === "CRIT" || /critical|critico|missed critical|^QG02\b|^CG\d/i.test(issue.signature) },
  { id: "evidence_fidelity", label: "Evidence fidelity / invention", match: (issue) => issue.dim === "RAG" || /unsupported|^R\d|evidence|fidelity|invent/i.test(issue.signature) },
  { id: "copy_synthesis", label: "Low synthesis / copy-paste", match: (issue) => /^QG0[67]\b|synthesizes|principal finding|principalCovered|copiedOutputRatio|copy/i.test(issue.signature) },
  { id: "guideline", label: "Guideline / classification", match: (issue) => /^GE-|^TC\d|BI-?RADS|TI-?RADS|Fleischner|Lung-RADS|guideline/i.test(issue.signature) },
  { id: "terminology", label: "Terminology", match: (issue) => issue.dim === "TERM" || /^T\d|terminology|termo/i.test(issue.signature) },
  { id: "measurement_laterality", label: "Measurement / laterality", match: (issue) => /measurement|measure|laterality|lateralidade|^QG04\b|^QG05\b|^R02\b/i.test(issue.signature) },
  { id: "anatomic_coverage", label: "Scoped anatomy coverage", match: (issue) => issue.dim === "GUIDE" && (/^G\d\d\b|Anatomical coverage|missing:/i.test(issue.signature)) },
  { id: "report_quality", label: "Report quality", match: (issue) => issue.dim === "QUAL" || /Q\d|quality|impression|hallucination/i.test(issue.key) },
];

const SEVERITY_WEIGHT = { critical: 4, major: 2, minor: 1, incidental: 0.5, unknown: 1 };

function usage() {
  console.error("Usage: node scripts/audit-run-failures.mjs [--out report.md] [--json report.json] <run.json>...");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { inputs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--out") args.out = argv[++i];
    else if (value === "--json") args.json = argv[++i];
    else if (value.startsWith("--")) usage();
    else args.inputs.push(value);
  }
  if (args.inputs.length === 0) usage();
  return args;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripTags(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ");
}

function reportText(result) {
  return normalizeText(stripTags(result.rawHtml ?? result.normalizedHtml ?? result.sanitizedHtml ?? ""));
}

function issueKey(check) {
  return [check.dim, check.id, check.name, check.evidence].filter(Boolean).join(":");
}

function issueWeight(issue) {
  return SEVERITY_WEIGHT[issue.severity] ?? SEVERITY_WEIGHT.unknown;
}

function hasBiRadsMention(result) {
  return /bi[\s\-.‐-―‑–—]?rads/i.test(reportText(result));
}

function hasEquivalentFiveMm(result) {
  const text = reportText(result).replace(/,/g, ".");
  return /\b5\s*mm\b/.test(text) || /\b0\.5\s*cm\b/.test(text);
}

function adjudicateIssue(issue, result) {
  const evidence = normalizeText(issue.evidence);
  const text = reportText(result);

  if (/^operational-failure/i.test(issue.id)) {
    return { adjudication: "system_error", reason: "provider/output operational failure" };
  }

  if (evidence === "ok") {
    return { adjudication: "evaluator_limitation", reason: "check failed but evidence says ok" };
  }

  if (/bi-?rads not mentioned/i.test(issue.evidence) && hasBiRadsMention(result)) {
    return { adjudication: "evaluator_limitation", reason: "BI-RADS is present with alternate punctuation" };
  }

  if ((issue.id === "QG04" || issue.id === "R04") && /5\s*mm/.test(evidence) && hasEquivalentFiveMm(result)) {
    return { adjudication: "evaluator_limitation", reason: "5 mm is preserved as an equivalent 0.5 cm measurement" };
  }

  if (issue.id === "QG05" && /joelho esquerdo|knee left|left knee/.test(text)) {
    return { adjudication: "evaluator_limitation", reason: "laterality is present in the exam title/report context" };
  }

  if (issue.id === "QG01" && /missed=\d+/.test(evidence)) {
    return { adjudication: "review_needed", reason: "aggregate gold-finding mismatch requires clinical review; no synonym override applied" };
  }

  return { adjudication: "system_error", reason: "" };
}

function stratumForIssue(issue) {
  return STRATA.find((candidate) => candidate.match(issue)) ?? { id: "other", label: "Other" };
}

function failedIssues(result) {
  return (result.checks ?? [])
    .filter((check) => check && check.passed === false)
    .map((check) => {
      const issue = {
        dim: check.dim ?? "UNKNOWN",
        id: check.id ?? "unknown",
        name: check.name ?? "Unnamed check",
        evidence: check.evidence ?? "",
        severity: check.severity ?? "unknown",
        signature: [check.id ?? "unknown", check.name ?? "", check.evidence ?? ""].join(":"),
        key: issueKey(check),
      };
      const adjudicated = adjudicateIssue(issue, result);
      const stratum = stratumForIssue(issue);
      return { ...issue, ...adjudicated, stratum: stratum.id, stratumLabel: stratum.label, weight: issueWeight(issue) };
    });
}

function auditRun(path) {
  const run = JSON.parse(readFileSync(path, "utf8"));
  const cases = [];
  const totals = {
    failedChecks: 0,
    systemErrors: 0,
    evaluatorLimitations: 0,
    reviewNeeded: 0,
    systemWeight: 0,
    rawWeight: 0,
  };
  const byStratum = {};

  for (const result of run.results ?? []) {
    const issues = failedIssues(result);
    if (issues.length === 0) continue;
    for (const issue of issues) {
      totals.failedChecks += 1;
      totals.rawWeight += issue.weight;
      if (issue.adjudication === "system_error") {
        totals.systemErrors += 1;
        totals.systemWeight += issue.weight;
      } else if (issue.adjudication === "evaluator_limitation") totals.evaluatorLimitations += 1;
      else if (issue.adjudication === "review_needed") totals.reviewNeeded += 1;

      byStratum[issue.stratum] ??= { id: issue.stratum, label: issue.stratumLabel, failedChecks: 0, systemErrors: 0, evaluatorLimitations: 0, reviewNeeded: 0, systemWeight: 0, rawWeight: 0 };
      byStratum[issue.stratum].failedChecks += 1;
      byStratum[issue.stratum].rawWeight += issue.weight;
      if (issue.adjudication === "system_error") {
        byStratum[issue.stratum].systemErrors += 1;
        byStratum[issue.stratum].systemWeight += issue.weight;
      } else if (issue.adjudication === "evaluator_limitation") byStratum[issue.stratum].evaluatorLimitations += 1;
      else if (issue.adjudication === "review_needed") byStratum[issue.stratum].reviewNeeded += 1;
    }
    cases.push({
      id: result.case?.id,
      exam: result.case?.exam,
      score: result.combinedOverall,
      verdict: result.verdict,
      issues,
    });
  }

  for (const obj of [totals, ...Object.values(byStratum)]) {
    obj.systemWeight = Number(obj.systemWeight.toFixed(1));
    obj.rawWeight = Number(obj.rawWeight.toFixed(1));
  }

  return {
    path,
    label: run.manifest?.entityName ?? run.manifest?.modelLabel ?? run.manifest?.runName ?? path,
    runName: run.manifest?.runName,
    modelLabel: run.manifest?.modelLabel,
    valid: run.manifest?.validation?.valid ?? true,
    validationErrors: run.manifest?.validation?.errors ?? [],
    emptyOutputs: run.manifest?.validation?.emptyOutputs ?? [],
    summary: run.summary,
    totals,
    byStratum: Object.values(byStratum).sort((a, b) => b.systemWeight - a.systemWeight || b.failedChecks - a.failedChecks),
    cases,
  };
}

function pct(value) {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? "-" : `${Number(value).toFixed(1)}%`;
}

function shortIssue(issue) {
  const reason = issue.reason ? `; ${issue.reason}` : "";
  return `${issue.dim}:${issue.id} ${issue.name} (${issue.severity}; ${issue.adjudication}${reason}; evidence: ${issue.evidence || "ok"})`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Run failure audit");
  lines.push("");
  lines.push("| Run | Valid | All-pass | Criteria | Clinical | Strict pass | System errors | Evaluator limits | Review | System weight | Raw weight |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const run of report.runs) {
    lines.push(`| ${run.label} | ${run.valid ? "yes" : "no"} | ${pct(run.summary?.allPassRate)} | ${pct(run.summary?.criterionPassRate)} | ${pct(run.summary?.averageOverall)} | ${pct(run.summary?.strictPassRate)} | ${run.totals.systemErrors} | ${run.totals.evaluatorLimitations} | ${run.totals.reviewNeeded} | ${run.totals.systemWeight.toFixed(1)} | ${run.totals.rawWeight.toFixed(1)} |`);
  }
  lines.push("");
  lines.push("System errors are likely attributable to the output. Evaluator limits are known harness/detector limitations. Review items need clinical adjudication.");

  for (const run of report.runs) {
    lines.push("");
    lines.push(`## ${run.label}`);
    lines.push("");
    lines.push(`Run: ${run.runName}; valid: ${run.valid ? "yes" : "no"}; all-pass ${pct(run.summary?.allPassRate)}; criteria ${pct(run.summary?.criterionPassRate)}; clinical ${pct(run.summary?.averageOverall)}; strict pass ${pct(run.summary?.strictPassRate)}.`);
    if (!run.valid) lines.push(`Validation: ${(run.validationErrors ?? []).join("; ") || "invalid"}; empty outputs: ${(run.emptyOutputs ?? []).join(", ") || "-"}.`);
    lines.push("");
    lines.push("| Stratum | Failed checks | System errors | Evaluator limits | Review | System weight | Raw weight |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const s of run.byStratum) {
      lines.push(`| ${s.label} | ${s.failedChecks} | ${s.systemErrors} | ${s.evaluatorLimitations} | ${s.reviewNeeded} | ${s.systemWeight.toFixed(1)} | ${s.rawWeight.toFixed(1)} |`);
    }
    for (const c of run.cases) {
      lines.push("");
      lines.push(`### ${c.id}: ${c.exam}`);
      lines.push("");
      lines.push(`Score: ${pct(c.score)} (${c.verdict}); failed checks: ${c.issues.length}.`);
      for (const issue of c.issues) lines.push(`- ${shortIssue(issue)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const report = { generatedAt: new Date().toISOString(), runs: args.inputs.map(auditRun) };
if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, JSON.stringify(report, null, 2) + "\n");
}
const markdown = renderMarkdown(report);
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, markdown);
} else {
  console.log(markdown);
}
