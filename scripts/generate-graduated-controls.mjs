#!/usr/bin/env node
// Build frozen-prediction controls from the public gold labels.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LEVELS = [
  { id: "l1", label: "measure-perturbation" },
  { id: "l2", label: "laterality-perturbation" },
  { id: "l3", label: "noncritical-omission" },
  { id: "l4", label: "critical-omission" },
  { id: "l5", label: "null-baseline" },
];

function usage() {
  console.error("Usage: node scripts/generate-graduated-controls.mjs --cases <cases.json> --out-dir <dir> [--locale pt-BR]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) usage();
    const next = argv[i + 1];
    args[token.slice(2)] = next && !next.startsWith("--") ? next : true;
    if (args[token.slice(2)] !== true) i += 1;
  }
  if (!args.cases || !args["out-dir"]) usage();
  return args;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[char]);
}

function titleFor(benchCase) {
  return String(benchCase.exam ?? "Exame").split(".")[0].trim() || "Exame";
}

function mutateFirstMeasurement(text) {
  return text.replace(/(\d+(?:[,.]\d+)?)(\s*(?:cm|mm|ml|mL|centimetros?|centímetros?|milimetros?|milímetros?))/i, (full, raw, unit) => {
    const value = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(value)) return full;
    const next = value >= 10 ? value + 5 : value + 1;
    const formatted = String(raw).includes(",") ? next.toFixed(1).replace(".", ",") : next.toFixed(1);
    return `${formatted}${unit}`;
  });
}

function swapLaterality(text) {
  const pairs = [
    [/\bdireita\b/i, "esquerda"],
    [/\besquerda\b/i, "direita"],
    [/\bdireito\b/i, "esquerdo"],
    [/\besquerdo\b/i, "direito"],
    [/\bright\b/i, "left"],
    [/\bleft\b/i, "right"],
  ];
  for (const [pattern, replacement] of pairs) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

function mutateFirstMatching(findings, mutate) {
  let changed = false;
  return findings.map((item) => {
    if (changed) return item;
    const next = mutate(item.finding);
    if (next === item.finding) return item;
    changed = true;
    return { ...item, finding: next };
  });
}

function textTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4);
}

function removeBestMatchingSegments(html, finding) {
  const target = new Set(textTokens(finding));
  if (target.size === 0) return html;
  let parts = String(html).split(/(<br\s*\/?>|[.。])/i);
  const threshold = Math.min(2, target.size);

  for (let removal = 0; removal < 4; removal += 1) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const tokens = textTokens(parts[i]);
      const score = tokens.reduce((sum, token) => sum + (target.has(token) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestScore < threshold) break;
    parts = parts.filter((_, index) => index !== bestIndex);
  }
  return parts.join("").replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>");
}

function severityRank(severity) {
  if (severity === "critical") return 3;
  if (severity === "major") return 2;
  if (severity === "minor") return 1;
  return 0;
}

function omitOne(findings, predicate) {
  const index = findings.findIndex(predicate);
  if (index < 0) return findings;
  return findings.filter((_, i) => i !== index);
}

function selectedFindings(benchCase, level) {
  let findings = Array.isArray(benchCase.goldFindings) ? benchCase.goldFindings.map((item) => ({ ...item })) : [];
  if (findings.length === 0) {
    findings = [{ finding: "Sem achados relevantes extraídos do gold público.", severity: "minor" }];
  }

  if (level === "l3") {
    findings = omitOne(findings, (item) => item.severity !== "critical");
  }
  if (level === "l4") {
    const critical = findings.some((item) => item.severity === "critical");
    findings = critical
      ? omitOne(findings, (item) => item.severity === "critical")
      : omitOne([...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)), () => true);
  }
  return findings;
}

function renderReport(benchCase, level) {
  if (level === "l5") {
    return "Relatorio preliminar sem padrao. Nao ha alteracoes agudas. Sem lesao suspeita, hemorragia, fratura, obstrucao ou embolia. Recomenda-se controle de rotina sem evidencia fornecida.";
  }

  if (benchCase.referenceReport) {
    let report = String(benchCase.referenceReport);
    if (["l1", "l2", "l3", "l4"].includes(level)) report = mutateFirstMeasurement(report);
    if (["l2", "l3", "l4"].includes(level)) report = swapLaterality(report);
    if (level === "l1" || level === "l2") return report;
    const removed = selectedFindings(benchCase, level);
    const original = Array.isArray(benchCase.goldFindings) ? benchCase.goldFindings : [];
    const omitted = original.find((item) => !removed.some((kept) => kept.finding === item.finding));
    return omitted ? removeBestMatchingSegments(report, omitted.finding) : report;
  }

  let gold = selectedFindings(benchCase, level);
  if (level === "l1") gold = mutateFirstMatching(gold, mutateFirstMeasurement);
  if (level === "l2") gold = mutateFirstMatching(mutateFirstMatching(gold, mutateFirstMeasurement), swapLaterality);

  const findings = gold.map((item) => String(item.finding ?? "").trim()).filter(Boolean);

  const conclusion = findings.length > 0 ? findings.join("; ") : "Sem achado principal descrito.";
  return [
    `<center><b>${esc(titleFor(benchCase))}</b></center>`,
    "<br><br><b>Achados</b><br>",
    findings.length > 0 ? esc(findings.join(". ")) : "Sem achado principal descrito.",
    "<br><br><b>Conclusao</b><br>",
    esc(conclusion),
  ].join("");
}

const args = parseArgs(process.argv.slice(2));
const cases = JSON.parse(readFileSync(args.cases, "utf8"));
if (!Array.isArray(cases)) throw new Error(`Cases file must be an array: ${args.cases}`);

const locale = args.locale ?? cases[0]?.locale ?? "pt-BR";
const outDir = args["out-dir"];
mkdirSync(outDir, { recursive: true });

for (const level of LEVELS) {
  const model = `graduated-control-${level.id}-${level.label}`;
  const lines = cases.map((benchCase) => JSON.stringify({
    instance_id: benchCase.id,
    model_name_or_path: model,
    model_output: renderReport(benchCase, level.id),
  }));
  const outPath = join(outDir, `graduated-control-${level.id}-${locale}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(`Wrote ${lines.length} ${level.id} predictions to ${outPath}`);
}
