#!/usr/bin/env node
// Compare two suite run artifacts by clinically meaningful error strata.
//
// Usage:
//   node scripts/stratify-run-comparison.mjs --a runs/laudos.json --b runs/gpt.json \
//     --label-a Laudos.AI --label-b "GPT OSS 20B" --out report.md --json report.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const STRATA = [
  {
    id: "critical_finding",
    label: "Achado crítico / segurança",
    match: (issue) => issue.dim === "CRIT" || /critical|critico|missed critical|^QG02\b|^CG\d/i.test(issue.signature),
  },
  {
    id: "evidence_fidelity",
    label: "Fidelidade / invenção técnica",
    match: (issue) => issue.dim === "RAG" || /unsupported|^R\d|evidence|fidelity|invent/i.test(issue.signature),
  },
  {
    id: "copy_synthesis",
    label: "Baixa síntese / copy-paste",
    match: (issue) => /^QG0[67]\b|synthesizes|principal finding|principalCovered|copiedOutputRatio|copy/i.test(issue.signature),
  },
  {
    id: "guideline",
    label: "Guideline / classificação",
    match: (issue) => /^GE-|^TC\d|BI-?RADS|TI-?RADS|Fleischner|Lung-RADS|guideline/i.test(issue.signature),
  },
  {
    id: "terminology",
    label: "Terminologia",
    match: (issue) => issue.dim === "TERM" || /^T\d|terminology|termo/i.test(issue.signature),
  },
  {
    id: "measurement_laterality",
    label: "Medida / lateralidade",
    match: (issue) => /measurement|measure|laterality|lateralidade|^QG04\b|^QG05\b|^R02\b/i.test(issue.signature),
  },
  {
    id: "anatomic_coverage",
    label: "Cobertura anatômica",
    match: (issue) => issue.dim === "GUIDE" && (/^G\d\d\b|Anatomical coverage|missing:/i.test(issue.signature)),
  },
  {
    id: "report_quality",
    label: "Qualidade de laudo",
    match: (issue) => issue.dim === "QUAL" || /Q\d|quality|impression|hallucination/i.test(issue.key),
  },
];

const SEVERITY_WEIGHT = {
  critical: 4,
  major: 2,
  minor: 1,
  incidental: 0.5,
  unknown: 1,
};

function usage() {
  console.error("Usage: node scripts/stratify-run-comparison.mjs --a <run.json> --b <run.json> [--label-a A] [--label-b B] [--out report.md] [--json report.json]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) usage();
    args[key.slice(2)] = argv[++i];
  }
  if (!args.a || !args.b) usage();
  return args;
}

function loadRun(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function issueKey(check) {
  return [check.dim, check.id, check.name, check.evidence].filter(Boolean).join(":");
}

function failedIssues(result) {
  return (result.checks ?? [])
    .filter((check) => check && check.passed === false)
    .map((check) => ({
      dim: check.dim ?? "UNKNOWN",
      id: check.id ?? "unknown",
      name: check.name ?? "Unnamed check",
      evidence: check.evidence ?? "",
      severity: check.severity ?? "unknown",
      signature: [check.id ?? "unknown", check.name ?? "", check.evidence ?? ""].join(":"),
      key: issueKey(check),
    }));
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function reportText(result) {
  return normalizeText(result.rawHtml ?? result.normalizedHtml ?? result.sanitizedHtml ?? "");
}

function hasBiRadsMention(result) {
  return /bi[\s\-.‐-―‑–—]?rads/i.test(reportText(result));
}

function hasEquivalentFiveMm(result) {
  const text = reportText(result).replace(/,/g, ".");
  return /\b5\s*mm\b/.test(text) || /\b0\.5\s*cm\b/.test(text);
}

function parseQG01Evidence(evidence) {
  const match = /exact=(\d+)\s+partial=(\d+)\s+missed=(\d+)\s+total=(\d+)/i.exec(evidence);
  if (!match) return null;
  return {
    exact: Number(match[1]),
    partial: Number(match[2]),
    missed: Number(match[3]),
    total: Number(match[4]),
  };
}

function adjudicateIssue(issue, result) {
  const evidence = normalizeText(issue.evidence);
  const text = reportText(result);

  if (evidence === "ok") {
    return {
      adjudication: "evaluator_limitation",
      reason: "check failed but evidence says ok",
    };
  }

  if (/bi-?rads not mentioned/i.test(issue.evidence) && hasBiRadsMention(result)) {
    return {
      adjudication: "evaluator_limitation",
      reason: "BI-RADS is present with alternate punctuation",
    };
  }

  if ((issue.id === "QG04" || issue.id === "R04") && /5\s*mm/.test(evidence) && hasEquivalentFiveMm(result)) {
    return {
      adjudication: "evaluator_limitation",
      reason: "5 mm is preserved as an equivalent 0.5 cm measurement",
    };
  }

  if (issue.id === "QG05" && /joelho esquerdo|knee left|left knee/.test(text)) {
    return {
      adjudication: "evaluator_limitation",
      reason: "laterality is present in the exam title/report context",
    };
  }

  if (issue.id === "QG01" && /missed=\d+/.test(evidence)) {
    const stats = parseQG01Evidence(issue.evidence);
    if (stats && stats.total > 0 && stats.exact === 0 && stats.partial === 0 && stats.missed === stats.total) {
      return {
        adjudication: "system_error",
        reason: "complete gold-finding miss; no exact or partial match",
      };
    }
    return {
      adjudication: "review_needed",
      reason: "partial aggregate gold-finding mismatch requires clinical review; no synonym override applied",
    };
  }

  return {
    adjudication: "system_error",
    reason: "",
  };
}

function strataForIssues(issues) {
  const matched = new Map(STRATA.map((stratum) => [stratum.id, []]));
  matched.set("other", []);

  for (const issue of issues) {
    const stratum = STRATA.find((candidate) => candidate.match(issue));
    if (stratum) {
      matched.get(stratum.id).push(issue);
    } else {
      matched.get("other").push(issue);
    }
  }
  return matched;
}

function allStrata() {
  return [
    ...STRATA,
    {
      id: "other",
      label: "Outros",
    },
  ];
}

function resultByCase(run) {
  return new Map((run.results ?? []).map((result) => [result.case?.id, result]));
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${Number(value).toFixed(1)}%`;
}

function shortIssue(issue) {
  const evidence = issue.evidence ? ` (${issue.evidence})` : "";
  const tag = issue.adjudication === "evaluator_limitation"
    ? ` [avaliador: ${issue.adjudicationReason}]`
    : issue.adjudication === "review_needed"
      ? ` [revisar: ${issue.adjudicationReason}]`
      : "";
  return `${issue.dim}:${issue.id} ${issue.name}${evidence}${tag}`;
}

function issueWeight(issue) {
  return SEVERITY_WEIGHT[issue.severity] ?? SEVERITY_WEIGHT.unknown;
}

function addCaseOnce(list, id) {
  if (!list.includes(id)) list.push(id);
}

function sortByDesc(items, field) {
  return [...items].sort((left, right) => (right[field] ?? 0) - (left[field] ?? 0));
}

function buildExecutiveReadout(strata, cases) {
  const totals = Object.values(strata).reduce((acc, s) => {
    acc.aSystemErrors += s.aSystemFailures;
    acc.bSystemErrors += s.bSystemFailures;
    acc.aReviewNeeded += s.aReviewNeeded;
    acc.bReviewNeeded += s.bReviewNeeded;
    acc.aEvaluatorLimitations += s.aEvaluatorLimitations;
    acc.bEvaluatorLimitations += s.bEvaluatorLimitations;
    acc.aSystemWeight += s.aSystemWeighted;
    acc.bSystemWeight += s.bSystemWeighted;
    acc.aSystemExcessWeight += s.aSystemExcessWeighted;
    acc.bSystemExcessWeight += s.bSystemExcessWeighted;
    acc.aRawExcessWeight += s.aExcessWeighted;
    acc.bRawExcessWeight += s.bExcessWeighted;
    return acc;
  }, {
    aSystemErrors: 0,
    bSystemErrors: 0,
    aReviewNeeded: 0,
    bReviewNeeded: 0,
    aEvaluatorLimitations: 0,
    bEvaluatorLimitations: 0,
    aSystemWeight: 0,
    bSystemWeight: 0,
    aSystemExcessWeight: 0,
    bSystemExcessWeight: 0,
    aRawExcessWeight: 0,
    bRawExcessWeight: 0,
  });

  const deltaRows = Object.values(strata)
    .map((s) => ({
      id: s.id,
      label: s.label,
      bSystemExcessWeight: Number(s.bSystemExcessWeighted.toFixed(1)),
      aSystemExcessWeight: Number(s.aSystemExcessWeighted.toFixed(1)),
      bRawExcessWeight: Number(s.bExcessWeighted.toFixed(1)),
      aRawExcessWeight: Number(s.aExcessWeighted.toFixed(1)),
      bSystemExcessFailures: s.bSystemExcessFailures,
      aSystemExcessFailures: s.aSystemExcessFailures,
      bRawExcessFailures: s.bExcessFailures,
      aRawExcessFailures: s.aExcessFailures,
      bOnlyCases: s.bOnlyCases,
      aOnlyCases: s.aOnlyCases,
      bExcessCases: s.bExcessCases,
      aExcessCases: s.aExcessCases,
    }))
    .filter((s) => s.bSystemExcessWeight > 0 || s.bRawExcessWeight > 0);

  const caseDeltas = sortByDesc(cases, "delta")
    .filter((c) => c.delta > 0)
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      exam: c.exam,
      delta: c.delta,
      aScore: c.aScore,
      bScore: c.bScore,
      bOnlyStrata: Object.values(c.byStratum)
        .filter((block) => block.a.length === 0 && block.b.length > 0)
        .map((block) => block.label),
    }));

  return {
    totals: {
      ...totals,
      aSystemWeight: Number(totals.aSystemWeight.toFixed(1)),
      bSystemWeight: Number(totals.bSystemWeight.toFixed(1)),
      aSystemExcessWeight: Number(totals.aSystemExcessWeight.toFixed(1)),
      bSystemExcessWeight: Number(totals.bSystemExcessWeight.toFixed(1)),
      netSystemExcessWeight: Number((totals.bSystemExcessWeight - totals.aSystemExcessWeight).toFixed(1)),
      aRawExcessWeight: Number(totals.aRawExcessWeight.toFixed(1)),
      bRawExcessWeight: Number(totals.bRawExcessWeight.toFixed(1)),
      netRawExcessWeight: Number((totals.bRawExcessWeight - totals.aRawExcessWeight).toFixed(1)),
    },
    topSystemDeltas: sortByDesc(deltaRows, "bSystemExcessWeight").slice(0, 5),
    topRawDeltas: sortByDesc(deltaRows, "bRawExcessWeight").slice(0, 5),
    largestCaseWins: caseDeltas,
    reviewStrata: Object.values(strata)
      .filter((s) => s.aReviewNeeded > 0 || s.bReviewNeeded > 0)
      .map((s) => ({
        id: s.id,
        label: s.label,
        aReviewNeeded: s.aReviewNeeded,
        bReviewNeeded: s.bReviewNeeded,
        aOnlyCases: s.aOnlyCases,
        bOnlyCases: s.bOnlyCases,
        sharedCases: s.sharedCases,
      })),
    evaluatorLimitStrata: Object.values(strata)
      .filter((s) => s.aEvaluatorLimitations > 0 || s.bEvaluatorLimitations > 0)
      .map((s) => ({
        id: s.id,
        label: s.label,
        aEvaluatorLimitations: s.aEvaluatorLimitations,
        bEvaluatorLimitations: s.bEvaluatorLimitations,
      })),
  };
}

function summarize(aRun, bRun, labelA, labelB) {
  const aByCase = resultByCase(aRun);
  const bByCase = resultByCase(bRun);
  const caseIds = [...aByCase.keys()].filter((id) => bByCase.has(id));
  const strataList = allStrata();
  const strata = Object.fromEntries(strataList.map((s) => [s.id, {
    id: s.id,
    label: s.label,
    aFailures: 0,
    bFailures: 0,
    aSystemFailures: 0,
    bSystemFailures: 0,
    aEvaluatorLimitations: 0,
    bEvaluatorLimitations: 0,
    aReviewNeeded: 0,
    bReviewNeeded: 0,
    aWeighted: 0,
    bWeighted: 0,
    aSystemWeighted: 0,
    bSystemWeighted: 0,
    aCaseCount: 0,
    bCaseCount: 0,
    bExcessFailures: 0,
    aExcessFailures: 0,
    bSystemExcessFailures: 0,
    aSystemExcessFailures: 0,
    bExcessWeighted: 0,
    aExcessWeighted: 0,
    bSystemExcessWeighted: 0,
    aSystemExcessWeighted: 0,
    bOnlyCases: [],
    aOnlyCases: [],
    bExcessCases: [],
    aExcessCases: [],
    sharedCases: [],
  }]));

  const cases = [];
  for (const id of caseIds) {
    const a = aByCase.get(id);
    const b = bByCase.get(id);
    const aIssues = failedIssues(a).map((issue) => {
      const adjudicated = adjudicateIssue(issue, a);
      return { ...issue, adjudication: adjudicated.adjudication, adjudicationReason: adjudicated.reason };
    });
    const bIssues = failedIssues(b).map((issue) => {
      const adjudicated = adjudicateIssue(issue, b);
      return { ...issue, adjudication: adjudicated.adjudication, adjudicationReason: adjudicated.reason };
    });
    const aStrata = strataForIssues(aIssues);
    const bStrata = strataForIssues(bIssues);
    const byStratum = {};

    for (const stratum of strataList) {
      const ai = aStrata.get(stratum.id) ?? [];
      const bi = bStrata.get(stratum.id) ?? [];
      if (ai.length === 0 && bi.length === 0) continue;
      strata[stratum.id].aFailures += ai.length;
      strata[stratum.id].bFailures += bi.length;
      strata[stratum.id].aSystemFailures += ai.filter((issue) => issue.adjudication === "system_error").length;
      strata[stratum.id].bSystemFailures += bi.filter((issue) => issue.adjudication === "system_error").length;
      strata[stratum.id].aEvaluatorLimitations += ai.filter((issue) => issue.adjudication === "evaluator_limitation").length;
      strata[stratum.id].bEvaluatorLimitations += bi.filter((issue) => issue.adjudication === "evaluator_limitation").length;
      strata[stratum.id].aReviewNeeded += ai.filter((issue) => issue.adjudication === "review_needed").length;
      strata[stratum.id].bReviewNeeded += bi.filter((issue) => issue.adjudication === "review_needed").length;
      strata[stratum.id].aWeighted += ai.reduce((sum, issue) => sum + issueWeight(issue), 0);
      strata[stratum.id].bWeighted += bi.reduce((sum, issue) => sum + issueWeight(issue), 0);
      if (ai.length > 0) strata[stratum.id].aCaseCount += 1;
      if (bi.length > 0) strata[stratum.id].bCaseCount += 1;
      const aSystem = ai.filter((issue) => issue.adjudication === "system_error");
      const bSystem = bi.filter((issue) => issue.adjudication === "system_error");
      strata[stratum.id].aSystemWeighted += aSystem.reduce((sum, issue) => sum + issueWeight(issue), 0);
      strata[stratum.id].bSystemWeighted += bSystem.reduce((sum, issue) => sum + issueWeight(issue), 0);
      strata[stratum.id].bExcessFailures += Math.max(0, bi.length - ai.length);
      strata[stratum.id].aExcessFailures += Math.max(0, ai.length - bi.length);
      strata[stratum.id].bSystemExcessFailures += Math.max(0, bSystem.length - aSystem.length);
      strata[stratum.id].aSystemExcessFailures += Math.max(0, aSystem.length - bSystem.length);
      strata[stratum.id].bExcessWeighted += Math.max(
        0,
        bi.reduce((sum, issue) => sum + issueWeight(issue), 0) -
          ai.reduce((sum, issue) => sum + issueWeight(issue), 0),
      );
      strata[stratum.id].aExcessWeighted += Math.max(
        0,
        ai.reduce((sum, issue) => sum + issueWeight(issue), 0) -
          bi.reduce((sum, issue) => sum + issueWeight(issue), 0),
      );
      strata[stratum.id].bSystemExcessWeighted += Math.max(
        0,
        bSystem.reduce((sum, issue) => sum + issueWeight(issue), 0) -
          aSystem.reduce((sum, issue) => sum + issueWeight(issue), 0),
      );
      strata[stratum.id].aSystemExcessWeighted += Math.max(
        0,
        aSystem.reduce((sum, issue) => sum + issueWeight(issue), 0) -
          bSystem.reduce((sum, issue) => sum + issueWeight(issue), 0),
      );
      if (ai.length === 0 && bi.length > 0) addCaseOnce(strata[stratum.id].bOnlyCases, id);
      else if (ai.length > 0 && bi.length === 0) addCaseOnce(strata[stratum.id].aOnlyCases, id);
      else addCaseOnce(strata[stratum.id].sharedCases, id);
      if (bSystem.reduce((sum, issue) => sum + issueWeight(issue), 0) > aSystem.reduce((sum, issue) => sum + issueWeight(issue), 0)) addCaseOnce(strata[stratum.id].bExcessCases, id);
      if (aSystem.reduce((sum, issue) => sum + issueWeight(issue), 0) > bSystem.reduce((sum, issue) => sum + issueWeight(issue), 0)) addCaseOnce(strata[stratum.id].aExcessCases, id);
      byStratum[stratum.id] = {
        label: stratum.label,
        a: ai.map(shortIssue),
        b: bi.map(shortIssue),
        aSystem: ai.filter((issue) => issue.adjudication === "system_error").map(shortIssue),
        bSystem: bi.filter((issue) => issue.adjudication === "system_error").map(shortIssue),
        aEvaluatorLimitations: ai.filter((issue) => issue.adjudication === "evaluator_limitation").map(shortIssue),
        bEvaluatorLimitations: bi.filter((issue) => issue.adjudication === "evaluator_limitation").map(shortIssue),
        aReviewNeeded: ai.filter((issue) => issue.adjudication === "review_needed").map(shortIssue),
        bReviewNeeded: bi.filter((issue) => issue.adjudication === "review_needed").map(shortIssue),
      };
    }

    cases.push({
      id,
      exam: a.case?.exam ?? b.case?.exam ?? "",
      delta: Number(((a.combinedOverall ?? 0) - (b.combinedOverall ?? 0)).toFixed(1)),
      aScore: a.combinedOverall ?? null,
      bScore: b.combinedOverall ?? null,
      aVerdict: a.verdict,
      bVerdict: b.verdict,
      byStratum,
    });
  }

  const normalizedStrata = Object.values(strata).map((s) => ({
    ...s,
    aWeighted: Number(s.aWeighted.toFixed(1)),
    bWeighted: Number(s.bWeighted.toFixed(1)),
    aSystemWeighted: Number(s.aSystemWeighted.toFixed(1)),
    bSystemWeighted: Number(s.bSystemWeighted.toFixed(1)),
    bExcessWeighted: Number(s.bExcessWeighted.toFixed(1)),
    aExcessWeighted: Number(s.aExcessWeighted.toFixed(1)),
    bSystemExcessWeighted: Number(s.bSystemExcessWeighted.toFixed(1)),
    aSystemExcessWeighted: Number(s.aSystemExcessWeighted.toFixed(1)),
  }));

  const report = {
    labels: { a: labelA, b: labelB },
    summary: {
      aAllPass: aRun.summary?.allPassRate ?? null,
      bAllPass: bRun.summary?.allPassRate ?? null,
      allPassDelta: Number(((aRun.summary?.allPassRate ?? 0) - (bRun.summary?.allPassRate ?? 0)).toFixed(1)),
      aCriterionPass: aRun.summary?.criterionPassRate ?? null,
      bCriterionPass: bRun.summary?.criterionPassRate ?? null,
      aOverall: aRun.summary?.averageOverall ?? null,
      bOverall: bRun.summary?.averageOverall ?? null,
      delta: Number(((aRun.summary?.averageOverall ?? 0) - (bRun.summary?.averageOverall ?? 0)).toFixed(1)),
      aStrictPass: aRun.summary?.strictPassRate ?? aRun.summary?.accuracyRate ?? null,
      bStrictPass: bRun.summary?.strictPassRate ?? bRun.summary?.accuracyRate ?? null,
      caseCount: caseIds.length,
    },
    strata: normalizedStrata,
    cases,
  };
  report.executiveReadout = buildExecutiveReadout(Object.fromEntries(normalizedStrata.map((s) => [s.id, s])), cases);
  return report;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Stratified comparison: ${report.labels.a} vs ${report.labels.b}`);
  lines.push("");
  lines.push(`Cases: ${report.summary.caseCount}`);
  lines.push("");
  lines.push("| System | Clinical score | Criterion pass | Zero-failure cases | Strict pass |");
  lines.push("|---|---:|---:|---:|---:|");
  lines.push(`| ${report.labels.a} | ${pct(report.summary.aOverall)} | ${pct(report.summary.aCriterionPass)} | ${pct(report.summary.aAllPass)} | ${pct(report.summary.aStrictPass)} |`);
  lines.push(`| ${report.labels.b} | ${pct(report.summary.bOverall)} | ${pct(report.summary.bCriterionPass)} | ${pct(report.summary.bAllPass)} | ${pct(report.summary.bStrictPass)} |`);
  lines.push("");
  lines.push(`Clinical score delta: ${report.summary.delta >= 0 ? "+" : ""}${report.summary.delta.toFixed(1)} pp for ${report.labels.a}. Zero-failure cases delta: ${report.summary.allPassDelta >= 0 ? "+" : ""}${report.summary.allPassDelta.toFixed(1)} pp.`);
  lines.push("");
  lines.push("Zero-failure cases are strict all-pass cases: every criterion in the case passed simultaneously. This is a conjunctive diagnostic, not the headline clinical score.");
  lines.push("");
  lines.push("## Executive readout");
  lines.push("");
  lines.push(`- Adjudicated system-error weight: ${report.labels.a} ${report.executiveReadout.totals.aSystemWeight.toFixed(1)} vs ${report.labels.b} ${report.executiveReadout.totals.bSystemWeight.toFixed(1)}.`);
  lines.push(`- Head-to-head adjudicated excess: ${report.labels.a} ${report.executiveReadout.totals.aSystemExcessWeight.toFixed(1)} vs ${report.labels.b} ${report.executiveReadout.totals.bSystemExcessWeight.toFixed(1)}; net +${report.executiveReadout.totals.netSystemExcessWeight.toFixed(1)} against ${report.labels.b}.`);
  lines.push(`- Raw excess weight: ${report.labels.a} ${report.executiveReadout.totals.aRawExcessWeight.toFixed(1)} vs ${report.labels.b} ${report.executiveReadout.totals.bRawExcessWeight.toFixed(1)}; net +${report.executiveReadout.totals.netRawExcessWeight.toFixed(1)} against ${report.labels.b}.`);
  lines.push(`- Review-needed items: ${report.labels.a} ${report.executiveReadout.totals.aReviewNeeded}, ${report.labels.b} ${report.executiveReadout.totals.bReviewNeeded}. These are not counted as system errors.`);
  lines.push(`- Evaluator limitations surfaced: ${report.labels.a} ${report.executiveReadout.totals.aEvaluatorLimitations}, ${report.labels.b} ${report.executiveReadout.totals.bEvaluatorLimitations}.`);
  lines.push("");
  lines.push("Top adjudicated deltas against B:");
  for (const s of report.executiveReadout.topSystemDeltas.slice(0, 5)) {
    lines.push(`- ${s.label}: +${s.bSystemExcessWeight.toFixed(1)} system-weight (${s.bSystemExcessFailures} excess system errors); excess cases ${s.bExcessCases.join(", ") || "-"}.`);
  }
  lines.push("");
  lines.push("Largest case-level wins for A:");
  for (const c of report.executiveReadout.largestCaseWins.slice(0, 5)) {
    lines.push(`- ${c.id}: ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(1)} pp (${pct(c.aScore)} vs ${pct(c.bScore)}); B-only strata ${c.bOnlyStrata.join(", ") || "-"}.`);
  }
  if (report.executiveReadout.reviewStrata.length > 0) {
    lines.push("");
    lines.push("Review-needed strata:");
    for (const s of report.executiveReadout.reviewStrata) {
      lines.push(`- ${s.label}: ${report.labels.a} ${s.aReviewNeeded}, ${report.labels.b} ${s.bReviewNeeded}; cases ${[...s.aOnlyCases, ...s.bOnlyCases, ...s.sharedCases].join(", ") || "-"}.`);
    }
  }
  lines.push("");
  lines.push("## Error strata");
  lines.push("");
  lines.push("| Stratum | A cases | B cases | A system errors | B system errors | A review | B review | A evaluator limits | B evaluator limits | A system excess | B system excess | A raw excess | B raw excess | A system weight | B system weight | A raw weight | B raw weight | B-only cases | A-only cases |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const s of report.strata) {
    lines.push(`| ${s.label} | ${s.aCaseCount} | ${s.bCaseCount} | ${s.aSystemFailures} | ${s.bSystemFailures} | ${s.aReviewNeeded} | ${s.bReviewNeeded} | ${s.aEvaluatorLimitations} | ${s.bEvaluatorLimitations} | ${s.aSystemExcessFailures} | ${s.bSystemExcessFailures} | ${s.aExcessFailures} | ${s.bExcessFailures} | ${s.aSystemWeighted.toFixed(1)} | ${s.bSystemWeighted.toFixed(1)} | ${s.aWeighted.toFixed(1)} | ${s.bWeighted.toFixed(1)} | ${s.bOnlyCases.join(", ") || "-"} | ${s.aOnlyCases.join(", ") || "-"} |`);
  }
  lines.push("");
  lines.push("System errors are adjudicated benchmark failures likely attributable to the output. Review items need clinical adjudication before fault assignment. Evaluator limits are likely harness/detector limitations surfaced separately. Excess counts failures above the paired system within the same case/stratum; weights use critical=4, major=2, minor=1, incidental=0.5.");
  lines.push("");
  lines.push("## Case review");
  for (const c of report.cases) {
    lines.push("");
    lines.push(`### ${c.id}: ${c.exam}`);
    lines.push("");
    lines.push(`Score: ${report.labels.a} ${pct(c.aScore)} (${c.aVerdict}) vs ${report.labels.b} ${pct(c.bScore)} (${c.bVerdict}); delta ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(1)} pp.`);
    for (const [id, block] of Object.entries(c.byStratum)) {
      void id;
      lines.push("");
      lines.push(`- ${block.label}`);
      if (block.a.length) lines.push(`  - ${report.labels.a}: ${block.a.join("; ")}`);
      if (block.b.length) lines.push(`  - ${report.labels.b}: ${block.b.join("; ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const aRun = loadRun(args.a);
const bRun = loadRun(args.b);
const labelA = args["label-a"] ?? aRun.manifest?.entityName ?? aRun.manifest?.modelLabel ?? "A";
const labelB = args["label-b"] ?? bRun.manifest?.entityName ?? bRun.manifest?.modelLabel ?? "B";
const report = summarize(aRun, bRun, labelA, labelB);
const markdown = renderMarkdown(report);

if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, JSON.stringify(report, null, 2));
}

if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, markdown);
} else {
  console.log(markdown);
}
