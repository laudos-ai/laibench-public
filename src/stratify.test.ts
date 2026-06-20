import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runArtifact(name: string, checks: unknown[], rawHtml = "", caseId = "CASE-1") {
  return {
    manifest: { runName: name, modelLabel: name, entityName: name },
    summary: { averageOverall: name === "a" ? 95 : 90, strictPassRate: name === "a" ? 100 : 50 },
    results: [
      {
        case: { id: caseId, exam: "TC de torax" },
        combinedOverall: name === "a" ? 95 : 90,
        verdict: name === "a" ? "PASS" : "PARTIAL",
        rawHtml,
        checks,
      },
    ],
  };
}

test("stratify-run-comparison assigns each failed check to one primary stratum", () => {
  const dir = mkdtempSync(join(tmpdir(), "laibench-strata-"));
  const aPath = join(dir, "a.json");
  const bPath = join(dir, "b.json");
  const outPath = join(dir, "report.json");

  writeFileSync(aPath, JSON.stringify(runArtifact("a", [
    { dim: "GUIDE", id: "G01", name: "Anatomical coverage: mediastino", severity: "major", passed: false, evidence: "missing: mediastino" },
  ])));
  writeFileSync(bPath, JSON.stringify(runArtifact("b", [
    { dim: "GUIDE", id: "G01", name: "Anatomical coverage: mediastino", severity: "major", passed: false, evidence: "missing: mediastino" },
    { dim: "GUIDE", id: "GE-fleischner-presence", name: "Fleischner classification present", severity: "major", passed: false, evidence: "Fleischner not mentioned" },
    { dim: "QUAL", id: "QG07", name: "Report synthesizes findings beyond input copy", severity: "major", passed: false, evidence: "copiedOutputRatio=80%" },
    { dim: "RAG", id: "R-ACQ", name: "No unsupported acquisition details", severity: "major", passed: false, evidence: "slice thickness" },
    { dim: "TERM", id: "T12", name: "intravenoso->endovenoso", severity: "major", passed: false, evidence: "intravenoso" },
  ])));

  const result = spawnSync(process.execPath, [
    "scripts/stratify-run-comparison.mjs",
    "--a", aPath,
    "--b", bPath,
    "--json", outPath,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  const byId = Object.fromEntries(report.strata.map((s: { id: string }) => [s.id, s]));

  assert.equal(byId.anatomic_coverage.aFailures, 1);
  assert.equal(byId.anatomic_coverage.bFailures, 1);
  assert.equal(byId.guideline.bFailures, 1);
  assert.equal(byId.copy_synthesis.bFailures, 1);
  assert.equal(byId.evidence_fidelity.bFailures, 1);
  assert.equal(byId.terminology.bFailures, 1);
  assert.equal(byId.report_quality.bFailures, 0);

  const totalBFailures = report.strata.reduce((sum: number, s: { bFailures: number }) => sum + s.bFailures, 0);
  assert.equal(totalBFailures, 5);
  assert.equal(byId.guideline.bWeighted, 2);
  assert.equal(byId.guideline.bSystemWeighted, 2);
  assert.equal(byId.guideline.bExcessFailures, 1);
  assert.equal(report.executiveReadout.totals.aSystemWeight, 2);
  assert.equal(report.executiveReadout.totals.bSystemWeight, 10);
  assert.equal(report.executiveReadout.totals.aSystemExcessWeight, 0);
  assert.equal(report.executiveReadout.totals.bSystemExcessWeight, 8);
  assert.equal(report.executiveReadout.totals.netSystemExcessWeight, 8);
  assert.ok(report.executiveReadout.topSystemDeltas.some((s: { id: string; bSystemExcessWeight: number }) => s.id === "guideline" && s.bSystemExcessWeight === 2));
  assert.equal(report.executiveReadout.largestCaseWins[0].id, "CASE-1");
});

test("stratify-run-comparison separates likely evaluator limitations from system errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "laibench-strata-adjudication-"));
  const aPath = join(dir, "a.json");
  const bPath = join(dir, "b.json");
  const outPath = join(dir, "report.json");

  writeFileSync(aPath, JSON.stringify(runArtifact("a", [
    { dim: "RAG", id: "R04", name: "Measurements preserved in body", severity: "major", passed: false, evidence: "5 mm" },
    { dim: "QUAL", id: "QG05", name: "Gold finding laterality correct", severity: "major", passed: false, evidence: "0/2 laterality correct" },
  ], "<center><b>TC cranio</b></center><br>colecao de 0,5 cm. joelho esquerdo.")));

  writeFileSync(bPath, JSON.stringify(runArtifact("b", [
    { dim: "CRIT", id: "C05", name: "No measurements in conclusion", severity: "major", passed: false, evidence: "ok" },
    { dim: "TERM", id: "TC02", name: "Breast finding should reference BI-RADS", severity: "major", passed: false, evidence: "BI-RADS not mentioned" },
  ], "<center><b>Mamografia</b></center><br>Categoria BI‑RADS 4.")));

  const result = spawnSync(process.execPath, [
    "scripts/stratify-run-comparison.mjs",
    "--a", aPath,
    "--b", bPath,
    "--json", outPath,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  const byId = Object.fromEntries(report.strata.map((s: { id: string }) => [s.id, s]));

  assert.equal(byId.evidence_fidelity.aFailures, 1);
  assert.equal(byId.evidence_fidelity.aEvaluatorLimitations, 1);
  assert.equal(byId.evidence_fidelity.aSystemFailures, 0);
  assert.equal(byId.measurement_laterality.aEvaluatorLimitations, 1);
  assert.equal(byId.critical_finding.bEvaluatorLimitations, 1);
  assert.equal(byId.critical_finding.bSystemFailures, 0);
  assert.equal(byId.guideline.bEvaluatorLimitations, 1);
  assert.equal(byId.guideline.bSystemFailures, 0);
  assert.equal(byId.guideline.bWeighted, 2);
  assert.equal(byId.guideline.bSystemWeighted, 0);
});

test("stratify-run-comparison sends aggregate QG01 misses to clinical review", () => {
  const dir = mkdtempSync(join(tmpdir(), "laibench-strata-review-"));
  const aPath = join(dir, "a.json");
  const bPath = join(dir, "b.json");
  const outPath = join(dir, "report.json");

  writeFileSync(aPath, JSON.stringify(runArtifact("a", [
    { dim: "QUAL", id: "QG01", name: "Gold finding detection rate", severity: "major", passed: false, evidence: "exact=2 partial=1 missed=1 total=4" },
  ])));
  writeFileSync(bPath, JSON.stringify(runArtifact("b", [
    { dim: "QUAL", id: "QG07", name: "Report synthesizes findings beyond input copy", severity: "major", passed: false, evidence: "copiedOutputRatio=80%" },
  ])));

  const result = spawnSync(process.execPath, [
    "scripts/stratify-run-comparison.mjs",
    "--a", aPath,
    "--b", bPath,
    "--json", outPath,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  const byId = Object.fromEntries(report.strata.map((s: { id: string }) => [s.id, s]));

  assert.equal(byId.report_quality.aFailures, 1);
  assert.equal(byId.report_quality.aReviewNeeded, 1);
  assert.equal(byId.report_quality.aSystemFailures, 0);
  assert.equal(byId.report_quality.aSystemWeighted, 0);
  assert.equal(byId.copy_synthesis.bSystemFailures, 1);
  assert.equal(report.executiveReadout.totals.aReviewNeeded, 1);
  assert.equal(report.executiveReadout.totals.aSystemWeight, 0);
  assert.equal(report.executiveReadout.reviewStrata.length, 1);
});

test("stratify-run-comparison adjudicates complete QG01 misses as system errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "laibench-strata-complete-miss-"));
  const aPath = join(dir, "a.json");
  const bPath = join(dir, "b.json");
  const outPath = join(dir, "report.json");

  writeFileSync(aPath, JSON.stringify(runArtifact("a", [])));
  writeFileSync(bPath, JSON.stringify(runArtifact("b", [
    { dim: "QUAL", id: "QG01", name: "Gold finding detection rate", severity: "critical", passed: false, evidence: "exact=0 partial=0 missed=3 total=3" },
  ])));

  const result = spawnSync(process.execPath, [
    "scripts/stratify-run-comparison.mjs",
    "--a", aPath,
    "--b", bPath,
    "--json", outPath,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  const byId = Object.fromEntries(report.strata.map((s: { id: string }) => [s.id, s]));

  assert.equal(byId.report_quality.bFailures, 1);
  assert.equal(byId.report_quality.bSystemFailures, 1);
  assert.equal(byId.report_quality.bReviewNeeded, 0);
  assert.equal(byId.report_quality.bSystemWeighted, 4);
  assert.equal(report.executiveReadout.totals.bReviewNeeded, 0);
  assert.equal(report.executiveReadout.totals.bSystemWeight, 4);
});

test("stratify-run-comparison does not auto-accept QG01 synonym matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "laibench-strata-reviewed-qg01-"));
  const aPath = join(dir, "a.json");
  const bPath = join(dir, "b.json");
  const outPath = join(dir, "report.json");

  writeFileSync(aPath, JSON.stringify({
    manifest: { runName: "a", modelLabel: "a", entityName: "a" },
    summary: { averageOverall: 95, strictPassRate: 100 },
    results: [
      {
        case: { id: "SYN-DEMO-003", exam: "US abdome" },
        combinedOverall: 95,
        verdict: "PASS",
        rawHtml: "Colelitíase. Vesícula com paredes finas. Vias biliares intra e extra-hepáticas não dilatadas.",
        checks: [
          { dim: "QUAL", id: "QG01", name: "Gold finding detection rate", severity: "major", passed: false, evidence: "exact=0 partial=2 missed=1 total=3" },
        ],
      },
      {
        case: { id: "SYN-PRO-011", exam: "US tireoide" },
        combinedOverall: 95,
        verdict: "PASS",
        rawHtml: "Nódulo sólido hipoecogênico no lobo direito, medindo 1,8 cm, com margens irregulares e focos ecogênicos puntiformes. Ausência de linfonodomegalias cervicais suspeitas.",
        checks: [
          { dim: "QUAL", id: "QG01", name: "Gold finding detection rate", severity: "critical", passed: false, evidence: "exact=2 partial=1 missed=1 total=4" },
        ],
      },
    ],
  }));
  writeFileSync(bPath, JSON.stringify({
    manifest: { runName: "b", modelLabel: "b", entityName: "b" },
    summary: { averageOverall: 90, strictPassRate: 50 },
    results: [
      {
        case: { id: "SYN-DEMO-003", exam: "US abdome" },
        combinedOverall: 90,
        verdict: "PASS",
        rawHtml: "",
        checks: [],
      },
      {
        case: { id: "SYN-PRO-011", exam: "US tireoide" },
        combinedOverall: 90,
        verdict: "PASS",
        rawHtml: "",
        checks: [],
      },
    ],
  }));

  const result = spawnSync(process.execPath, [
    "scripts/stratify-run-comparison.mjs",
    "--a", aPath,
    "--b", bPath,
    "--json", outPath,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(outPath, "utf8"));
  const byId = Object.fromEntries(report.strata.map((s: { id: string }) => [s.id, s]));

  assert.equal(byId.report_quality.aEvaluatorLimitations, 0);
  assert.equal(byId.report_quality.aReviewNeeded, 2);
  assert.equal(byId.report_quality.aSystemFailures, 0);
  assert.equal(report.executiveReadout.totals.aReviewNeeded, 2);
});
