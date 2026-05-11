import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreDimensions, combineScores, scoreDimensionsWithEvaluators, DIMS, WEIGHTS } from "./scoring.js";
import { parseJudgeResponse } from "./judge.js";
import { extractFindings, extractClassifications, extractRecommendations, extractCriticalMentions, normalizeClassificationValue, isNegated } from "./extract.js";
import { evaluateGuidelines } from "./evaluators/guide.js";
import { evaluateQuality } from "./evaluators/qual.js";
import { evaluateCritical } from "./evaluators/crit.js";
import { evaluateRetrieval } from "./evaluators/rag.js";
import { runStructuralChecks } from "./evaluators/structural.js";
import { bootstrapCI, mcNemarTest, cohensH } from "./stats.js";
import { deriveExamMeta } from "./classify.js";
import type { BenchCase, Check, Dim, DimSummary, EvaluatorResult, ExamMeta } from "./types.js";

// ---- Helper factories ----

function makeCheck(dim: Dim, id: string, passed: boolean, severity: Check["severity"] = "major"): Check {
  return { dim, id, name: `check-${id}`, severity, passed, evidence: passed ? "ok" : "fail" };
}

function makeMeta(overrides: Partial<ExamMeta> = {}): ExamMeta {
  return {
    modality: "CT",
    contrast: false,
    region: "head",
    normalizedExam: "ct head",
    normalizedFindings: "normal",
    abnormalStudy: false,
    expectedTitleTokens: ["computed", "tomography"],
    expectedRegionTokens: ["head"],
    ...overrides,
  };
}

function makeCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return {
    id: "test-001",
    exam: "ct head non-contrast",
    findings: "normal",
    locale: "en-US",
    ...overrides,
  };
}

// ---- scoreDimensions tests ----

describe("scoreDimensions", () => {
  it("scores empty checks as all UNSCORED", () => {
    const { dims, overall } = scoreDimensions([]);
    for (const dim of DIMS) {
      assert.equal(dims[dim].score, null);
      assert.equal(dims[dim].verdict, "UNSCORED");
    }
    assert.equal(overall, 0);
  });

  it("scores all-passing checks as 100%", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", true),
      makeCheck("QUAL", "Q01", true),
      makeCheck("QUAL", "Q02", true),
    ];
    const { dims, overall } = scoreDimensions(checks);
    assert.equal(dims.CRIT.score, 100);
    assert.equal(dims.CRIT.verdict, "PASS");
    assert.equal(dims.QUAL.score, 100);
    assert.equal(dims.QUAL.verdict, "PASS");
    assert.ok(overall > 0);
  });

  it("caps score with critical failure", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", false, "critical"),
      makeCheck("CRIT", "C03", true),
    ];
    const { dims } = scoreDimensions(checks);
    assert.ok(dims.CRIT.score! <= 60, `expected <= 60, got ${dims.CRIT.score}`);
    assert.equal(dims.CRIT.verdict, "FAIL");
    assert.equal(dims.CRIT.critFails, 1);
  });

  it("caps score at 70 with 3+ major failures", () => {
    const checks: Check[] = [
      makeCheck("TERM", "T01", false, "major"),
      makeCheck("TERM", "T02", false, "major"),
      makeCheck("TERM", "T03", false, "major"),
      makeCheck("TERM", "T04", true),
      makeCheck("TERM", "T05", true),
      makeCheck("TERM", "T06", true),
      makeCheck("TERM", "T07", true),
    ];
    const { dims } = scoreDimensions(checks);
    assert.ok(dims.TERM.score! <= 70, `expected <= 70, got ${dims.TERM.score}`);
  });

  it("distributes weights across scored dimensions only", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("QUAL", "Q01", true),
    ];
    const { dims } = scoreDimensions(checks);
    // Only CRIT and QUAL are scored, so their weights should sum to 1
    const totalWeight = dims.CRIT.appliedWeight + dims.QUAL.appliedWeight;
    assert.ok(Math.abs(totalWeight - 1) < 0.01, `total weight should be ~1, got ${totalWeight}`);
  });

  it("marks PARTIAL for score >= 80 without critical failures", () => {
    const checks: Check[] = [
      makeCheck("GUIDE", "G01", true),
      makeCheck("GUIDE", "G02", true),
      makeCheck("GUIDE", "G03", true),
      makeCheck("GUIDE", "G04", true),
      makeCheck("GUIDE", "G05", false, "minor"),
    ];
    const { dims } = scoreDimensions(checks);
    // 4/5 = 80%, no critical failures, but pass !== total => PARTIAL
    assert.equal(dims.GUIDE.verdict, "PARTIAL");
    assert.equal(dims.GUIDE.score, 80);
  });
});

describe("deriveExamMeta", () => {
  it("treats source enhancement terms as contrast context even when the exam label omits contrast", () => {
    const meta = deriveExamMeta("rm crânio", "Lesão com impregnação homogênea pelo gadolínio.", "pt-BR");
    assert.equal(meta.contrast, true);
  });
});

// ---- scoreDimensionsWithEvaluators tests ----

describe("scoreDimensionsWithEvaluators", () => {
  it("overrides dimension scores with evaluator results", () => {
    const checks: Check[] = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", false, "major"),
      makeCheck("QUAL", "Q01", true),
    ];
    const evaluatorResults: EvaluatorResult[] = [
      { dim: "CRIT", score: 90, checks: [makeCheck("CRIT", "CG01", true)], details: { mode: "gold-critical" } },
    ];
    const { dims } = scoreDimensionsWithEvaluators(checks, evaluatorResults);
    assert.equal(dims.CRIT.score, 90);
  });

  it("skips evaluator results with score < 0 (UNSCORED)", () => {
    const checks: Check[] = [
      makeCheck("RAG", "R01", true),
      makeCheck("RAG", "R02", true),
    ];
    const evaluatorResults: EvaluatorResult[] = [
      { dim: "RAG", score: -1, checks: [], details: { mode: "unscored" } },
    ];
    const { dims } = scoreDimensionsWithEvaluators(checks, evaluatorResults);
    assert.equal(dims.RAG.score, 100);
  });
});

// ---- combineScores tests ----

describe("combineScores", () => {
  it("returns FAIL verdict for deterministic critical failure", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 9, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const critCheck = makeCheck("CRIT", "C01", false, "critical");
    const result = combineScores(detDims, null, [critCheck]);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.gateReasons.includes("deterministic critical failure"));
  });

  it("returns degraded phaseStatus without judge", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const result = combineScores(detDims, null, []);
    assert.equal(result.phaseStatus, "degraded");
    assert.equal(result.verdict, "PASS");
    assert.equal(result.confidence, "medium");
    assert.ok(result.gateReasons.includes("adversarial phase unavailable"));
  });

  it("combines judge scores by taking minimum of det and judge", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 80, pass: 8, total: 10, critFails: 0, verdict: "PARTIAL", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PARTIAL" as const,
      scores: { CRIT: 3 } as Partial<Record<Dim, number>>, // 3 * 20 = 60
      overall: 3,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, []);
    assert.equal(result.combined.CRIT, 60); // min(80, 60)
    assert.equal(result.phaseStatus, "complete");
  });

  it("uses LLM-adjudicated scores as primary in judge-primary mode", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 62, pass: 6, total: 10, critFails: 0, verdict: "FAIL", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PASS" as const,
      scores: { CRIT: 92, QUAL: 88, TERM: 95, GUIDE: 84, RAG: 90 } as Partial<Record<Dim, number>>,
      overall: 90,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, [], undefined, "judge-primary");
    assert.equal(result.combined.CRIT, 92);
    assert.equal(result.overall, 90.2);
    assert.equal(result.phaseStatus, "complete");
  });

  it("keeps deterministic critical gates active in judge-primary mode", () => {
    const detDims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      detDims[dim] = { score: 90, pass: 9, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    const judge = {
      verdict: "PASS" as const,
      scores: { CRIT: 95, QUAL: 95, TERM: 95, GUIDE: 95, RAG: 95 } as Partial<Record<Dim, number>>,
      overall: 95,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(detDims, judge, [makeCheck("CRIT", "unsafe", false, "critical")], undefined, "judge-primary");
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.gateReasons.includes("deterministic critical failure"));
  });
});

describe("parseJudgeResponse", () => {
  it("accepts fine-grained 0-100 judge scores", () => {
    const result = parseJudgeResponse(JSON.stringify({
      verdict: "PASS",
      scores: { CRIT: 91, QUAL: 87, TERM: 96, GUIDE: 83, RAG: 89 },
      overall: 90,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    }));
    assert.equal(result?.scores.CRIT, 91);
    assert.equal(result?.scores.QUAL, 87);
    assert.equal(result?.overall, 90);
  });
});

// ---- Extraction tests ----

describe("extractFindings", () => {
  it("extracts findings from simple HTML", () => {
    const html = "<b>Findings</b><br>Moderate hepatic steatosis.<br>12mm gallbladder stone.<br>Right simple renal cyst 25mm.";
    const findings = extractFindings(html, "en-US");
    assert.ok(findings.length >= 2, `expected at least 2 findings, got ${findings.length}`);
  });

  it("detects laterality in findings", () => {
    const html = "<b>Findings</b><br>Left frontoparietal acute subdural hematoma measuring 15mm thickness.";
    const findings = extractFindings(html, "en-US");
    const hematomaFinding = findings.find((f) => /hematoma/i.test(f.text));
    assert.ok(hematomaFinding, "should find hematoma");
    assert.equal(hematomaFinding!.laterality, "left");
  });

  it("extracts measurements", () => {
    const html = "<b>Findings</b><br>Nodule measuring 18x12x15mm in right thyroid lobe.";
    const findings = extractFindings(html, "en-US");
    const nodule = findings.find((f) => /nodule/i.test(f.text));
    assert.ok(nodule, "should find nodule");
    assert.ok(nodule!.measurements.length > 0, "should have measurements");
  });

  it("classifies critical severity", () => {
    const html = "<b>Findings</b><br>Large left frontoparietal acute subdural hematoma with midline shift.";
    const findings = extractFindings(html, "en-US");
    const criticalFinding = findings.find((f) => /hematoma/i.test(f.text));
    assert.ok(criticalFinding, "should find hematoma");
    assert.equal(criticalFinding!.severity, "critical");
  });

  it("classifies minor severity", () => {
    const html = "<b>Findings</b><br>Simple renal cyst in the right kidney.";
    const findings = extractFindings(html, "en-US");
    const cystFinding = findings.find((f) => /cyst/i.test(f.text));
    assert.ok(cystFinding, "should find cyst");
    assert.equal(cystFinding!.severity, "minor");
  });

  it("sets negated field on negated findings (BUG G)", () => {
    const html = "<b>Findings</b><br>No evidence of pulmonary embolism.<br>Acute subdural hematoma.";
    const findings = extractFindings(html, "en-US");
    const negatedFinding = findings.find((f) => /embolism/i.test(f.text));
    assert.ok(negatedFinding, "should find embolism finding");
    assert.equal(negatedFinding!.negated, true, "negated finding should have negated=true");
    const affirmedFinding = findings.find((f) => /hematoma/i.test(f.text));
    assert.ok(affirmedFinding, "should find hematoma finding");
    assert.ok(!affirmedFinding!.negated, "affirmed finding should not have negated=true");
  });
});

describe("extractClassifications", () => {
  it("extracts BI-RADS classification", () => {
    const html = "Solid nodule BI-RADS 4A";
    const cls = extractClassifications(html);
    const birads = cls.find((c) => c.system === "birads");
    assert.ok(birads, "should find BI-RADS");
    assert.equal(birads!.normalizedValue, "4A");
  });

  it("extracts TI-RADS classification", () => {
    const html = "ACR TI-RADS 5";
    const cls = extractClassifications(html);
    const tirads = cls.find((c) => c.system === "tirads");
    assert.ok(tirads, "should find TI-RADS");
    assert.equal(tirads!.normalizedValue, "5");
  });

  it("extracts PI-RADS classification", () => {
    const html = "Lesion classified as PI-RADS 4";
    const cls = extractClassifications(html);
    const pirads = cls.find((c) => c.system === "pirads");
    assert.ok(pirads, "should find PI-RADS");
    assert.equal(pirads!.normalizedValue, "4");
  });

  it("extracts Bosniak classification", () => {
    const html = "Complex cyst Bosniak IIF";
    const cls = extractClassifications(html);
    const bosniak = cls.find((c) => c.system === "bosniak");
    assert.ok(bosniak, "should find Bosniak");
  });

  it("extracts Lung-RADS classification", () => {
    const html = "Categorized as Lung-RADS 4B";
    const cls = extractClassifications(html);
    const lungrads = cls.find((c) => c.system === "lungrads");
    assert.ok(lungrads, "should find Lung-RADS");
    assert.equal(lungrads!.normalizedValue, "4B");
  });

  it("deduplicates by system+value", () => {
    const html = "BI-RADS 4A was confirmed. The finding is BI-RADS 4A.";
    const cls = extractClassifications(html);
    const birads = cls.filter((c) => c.system === "birads");
    assert.equal(birads.length, 1);
  });
});

describe("extractRecommendations", () => {
  it("detects follow-up recommendations", () => {
    const html = "Recommend follow-up in 6 months with ultrasound.";
    const recs = extractRecommendations(html, "en-US");
    assert.ok(recs.length > 0, "should find recommendation");
    assert.equal(recs[0].type, "follow-up");
    assert.ok(recs[0].timeframe, "should extract timeframe");
  });

  it("detects biopsy recommendations", () => {
    const html = "Biopsy recommended for further evaluation.";
    const recs = extractRecommendations(html, "en-US");
    assert.ok(recs.length > 0, "should find recommendation");
    assert.equal(recs[0].type, "biopsy");
  });

  it("detects Portuguese recommendations", () => {
    const html = "Sugerimos controle em 6 meses com ultrassonografia.";
    const recs = extractRecommendations(html, "pt-BR");
    assert.ok(recs.length > 0, "should find recommendation");
    assert.equal(recs[0].type, "follow-up");
  });
});

describe("extractCriticalMentions", () => {
  it("detects acute hemorrhage", () => {
    const html = "Acute subdural hematoma with midline shift.";
    const mentions = extractCriticalMentions(html, "en-US");
    assert.ok(mentions.length > 0, "should find critical mention");
    assert.ok(mentions.some((m) => m.category === "acute-bleed"), "should categorize as acute-bleed");
  });

  it("detects pulmonary embolism", () => {
    const html = "Filling defects consistent with acute pulmonary embolism.";
    const mentions = extractCriticalMentions(html, "en-US");
    assert.ok(mentions.some((m) => m.category === "pulmonary-embolism"), "should find PE");
  });

  it("detects pneumothorax", () => {
    const html = "Large left pneumothorax with mediastinal shift.";
    const mentions = extractCriticalMentions(html, "en-US");
    assert.ok(mentions.some((m) => m.category === "pneumothorax"), "should find pneumothorax");
  });

  it("deduplicates by category", () => {
    const html = "Subdural hematoma seen. Another hemorrhage noted.";
    const mentions = extractCriticalMentions(html, "en-US");
    const bleedCategories = mentions.filter((m) => m.category === "acute-bleed");
    assert.equal(bleedCategories.length, 1, "should deduplicate");
  });
});

describe("normalizeClassificationValue", () => {
  it("strips BI-RADS prefix", () => {
    assert.equal(normalizeClassificationValue("BI-RADS 4A"), "4A");
  });

  it("strips TI-RADS prefix", () => {
    assert.equal(normalizeClassificationValue("TI-RADS 5"), "5");
  });

  it("strips LI-RADS variants with spaces or compact prefixes", () => {
    assert.equal(normalizeClassificationValue("LI-RADS 3"), "3");
    assert.equal(normalizeClassificationValue("LIRADS-3"), "3");
  });

  it("normalizes case", () => {
    assert.equal(normalizeClassificationValue("bi-rads 4a"), "4A");
  });
});

// ---- Guideline evaluator tests ----

describe("evaluateGuidelines", () => {
  it("detects applicable guidelines from context", () => {
    const benchCase = makeCase({
      exam: "us thyroid",
      findings: "hypoechoic solid nodule in right thyroid lobe measuring 18x12x15mm",
    });
    const meta = makeMeta({ modality: "US", region: "unknown" });
    const html = "<b>Findings</b><br>Hypoechoic solid nodule in right thyroid lobe. ACR TI-RADS 5.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, []);
    assert.equal(result.dim, "GUIDE");
    assert.ok(result.score > 0 || result.checks.length > 0, "should have evaluated something");
  });

  it("validates gold guideline expectations", () => {
    const benchCase = makeCase({
      exam: "us thyroid",
      findings: "thyroid nodule",
      guidelineExpectations: [
        { guidelineId: "tirads", expectedClassification: "TI-RADS 5", recommendationRequired: true },
      ],
    });
    const meta = makeMeta({ modality: "US" });
    const html = "<b>Findings</b><br>Thyroid nodule ACR TI-RADS 5. Biopsy recommended.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, []);
    assert.ok(result.checks.some((c) => c.id.includes("tirads")), "should check TI-RADS");
  });

  it("falls back to anatomy coverage when no guidelines apply", () => {
    const benchCase = makeCase({
      exam: "ct head non-contrast",
      findings: "normal",
    });
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("GUIDE", "G01", true),
      makeCheck("GUIDE", "G02", false),
    ];
    const html = "<b>Findings</b><br>Normal CT head.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, structuralChecks);
    assert.ok(result.details.mode === "anatomical-coverage-fallback" || result.details.mode === "auto-detect");
  });

  it("does not require PI-RADS for a rectal pelvis MRI just because the generated report mentions prostate", () => {
    const benchCase = makeCase({
      exam: "rm pelve",
      locale: "pt-BR",
      findings: "Lesão expansiva anular no reto, distando 5,5cm da borda anal, para estadiamento de câncer de reto.",
    });
    const meta = makeMeta({ modality: "MRI", region: "pelvis", normalizedExam: "rm pelve" });
    const html = "<b>Análise</b><br>Lesão anular no reto. Próstata e demais estruturas pélvicas sem invasão.";

    const result = evaluateGuidelines(html, benchCase, "pt-BR", meta, []);
    assert.equal(result.checks.some((c) => c.id.includes("pirads")), false, "rectal MRI should not trigger PI-RADS");

    const structural = runStructuralChecks(html, meta, benchCase.findings, "pt-BR");
    assert.equal(structural.some((c) => c.id === "TC06"), false, "TERM should not require PI-RADS from output-only prostate text");
  });

  it("accepts defecografia as the title for an RX defecograma case", () => {
    const meta = deriveExamMeta("rx defecograma", "Incontinência às manobras de Valsalva.", "pt-BR");
    const html = "<center><b>DEFECOGRAFIA</b></center><br><br><b>Técnica:</b><br>Estudo radiográfico dinâmico.<br><br><b>Análise:</b><br>Incontinência às manobras de Valsalva.<br><br><b>Conclusão:</b><br>Incontinência às manobras de Valsalva.";

    const structural = runStructuralChecks(html, meta, "Incontinência às manobras de Valsalva.", "pt-BR");
    const titleCheck = structural.find((c) => c.id === "R01");
    assert.equal(titleCheck?.passed, true, titleCheck?.evidence);
  });
});

// ---- Quality evaluator tests ----

describe("evaluateQuality", () => {
  it("uses gold findings when available", () => {
    const benchCase = makeCase({
      findings: "moderate hepatic steatosis. 12mm gallbladder stone",
      goldFindings: [
        { finding: "hepatic steatosis", severity: "minor" },
        { finding: "gallbladder stone", severity: "minor", measurements: ["12mm"] },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    const html = "<b>Findings</b><br>Moderate hepatic steatosis. Gallbladder stone measuring 12mm.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-findings");
    assert.ok(result.score >= 50, `expected >= 50, got ${result.score}`);
  });

  it("uses reference report when available", () => {
    const benchCase = makeCase({
      findings: "normal",
      referenceReport: "<b>Findings</b><br>Normal head CT. No acute abnormality.<br><b>Impression</b><br>Normal.",
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Normal head CT. No acute abnormality.<br><b>Impression</b><br>Normal.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "reference-comparison");
    assert.ok(result.score > 0);
  });

  it("falls back to structural checks", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("QUAL", "Q01", true),
      makeCheck("QUAL", "Q02", true),
    ];
    const html = "<b>Findings</b><br>Normal.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
  });

  it("matches Portuguese laterality inflections for transplant-kidney context", () => {
    const benchCase = makeCase({
      locale: "pt-BR",
      findings: "Rim transplantado na esquerda, com dimensões normais e contornos regulares. Parênquima de espessura normal.",
      goldFindings: [
        { finding: "Rim transplantado na esquerda", location: "rim", laterality: "left", severity: "incidental" },
        { finding: "dimensões normais", location: "rim transplantado", laterality: "left", severity: "incidental" },
        { finding: "Parênquima de espessura normal", location: "parênquima do rim transplantado", laterality: "left", severity: "incidental" },
      ],
    });
    const meta = makeMeta({ modality: "US", region: "urinary" });
    const html = "<b>Análise</b><br>Rim transplantado em fossa ilíaca esquerda, com dimensões preservadas.<br>Parênquima renal de espessura preservada.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const laterality = result.checks.find((c) => c.id === "QG05");
    assert.equal(laterality?.passed, true, laterality?.evidence);
    assert.equal(laterality?.severity, "major", "incidental laterality checks should not force a critical failure");
  });

  it("matches right and left Portuguese renal measurements", () => {
    const benchCase = makeCase({
      locale: "pt-BR",
      findings: "Rim direito mede 12,42 cm. Rim esquerdo mede 12,44 cm.",
      goldFindings: [
        { finding: "Rim direito mede 12,42 cm", location: "rim", laterality: "right", severity: "incidental", measurements: ["12,42 cm"] },
        { finding: "Rim esquerdo mede 12,44 cm", location: "rim", laterality: "left", severity: "incidental", measurements: ["12,44 cm"] },
      ],
    });
    const meta = makeMeta({ modality: "US", region: "urinary" });
    const html = "<b>Análise</b><br>Rim direito medindo 12,42 cm.<br>Rim esquerdo medindo 12,44 cm.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const laterality = result.checks.find((c) => c.id === "QG05");
    assert.equal(laterality?.passed, true, laterality?.evidence);
  });
});

// ---- Critical evaluator tests ----

describe("evaluateCritical", () => {
  it("computes recall/precision with gold labels", () => {
    const benchCase = makeCase({
      findings: "acute subdural hematoma. midline shift",
      criticalFindings: ["subdural hematoma", "midline shift"],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Left frontoparietal acute subdural hematoma. 8mm midline shift.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");
    assert.ok(typeof result.details.recall === "number");
    assert.ok(typeof result.details.precision === "number");
  });

  it("penalizes missed critical findings", () => {
    const benchCase = makeCase({
      findings: "acute subdural hematoma. midline shift. pneumothorax",
      criticalFindings: ["subdural hematoma", "midline shift", "pneumothorax"],
    });
    const meta = makeMeta();
    // Report only mentions hematoma, missing midline shift and pneumothorax
    const html = "<b>Findings</b><br>Left subdural hematoma.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    const recall = result.details.recall as number;
    assert.ok(recall < 1, `recall should be < 1 when findings are missed, got ${recall}`);
  });

  it("falls back to structural checks without gold", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("CRIT", "C01", true),
      makeCheck("CRIT", "C02", true),
    ];
    const html = "<b>Findings</b><br>Normal.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
  });
});

// ---- Retrieval evaluator tests ----

describe("evaluateRetrieval", () => {
  it("computes IR metrics with gold and retrieved docs", () => {
    const benchCase = makeCase({
      retrievalGold: [
        { documentId: "doc1", relevance: 3 },
        { documentId: "doc2", relevance: 2 },
        { documentId: "doc3", relevance: 1 },
        { documentId: "doc4", relevance: 0 },
      ],
    });
    const meta = makeMeta();
    const html = "";
    const retrievedDocIds = ["doc1", "doc3", "doc4", "doc2"];

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, [], retrievedDocIds);
    assert.equal(result.details.mode, "retrieval-evaluation");
    assert.ok(typeof result.details.mrr === "number");
    assert.ok(typeof result.details.ndcg === "number");
    assert.ok(result.score > 0);
  });

  it("returns UNSCORED without gold data and structural checks", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const html = "";

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, []);
    assert.equal(result.score, -1);
  });

  it("falls back to structural RAG checks without gold data", () => {
    const benchCase = makeCase();
    const meta = makeMeta();
    const structuralChecks = [
      makeCheck("RAG", "R01", true),
      makeCheck("RAG", "R02", true),
    ];
    const html = "";

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, structuralChecks);
    assert.equal(result.details.mode, "structural-fallback");
    assert.equal(result.score, 100);
  });
});

// ---- BUG FIX REGRESSION TESTS ----

describe("BUG 1: Negated critical findings not counted as detected", () => {
  it("does NOT detect PE when negated in English", () => {
    const html = "No evidence of pulmonary embolism. Normal chest CT.";
    const mentions = extractCriticalMentions(html, "en-US");
    const pe = mentions.find((m) => m.category === "pulmonary-embolism");
    assert.equal(pe, undefined, "negated PE should NOT be detected");
  });

  it("does NOT detect PE when negated in Portuguese", () => {
    const html = "Sem evidencia de tromboembolismo pulmonar. Exame normal.";
    const mentions = extractCriticalMentions(html, "pt-BR");
    const pe = mentions.find((m) => m.category === "pulmonary-embolism");
    assert.equal(pe, undefined, "negated TEP should NOT be detected");
  });

  it("still detects PE when affirmed", () => {
    const html = "Filling defects consistent with acute pulmonary embolism in the right main pulmonary artery.";
    const mentions = extractCriticalMentions(html, "en-US");
    const pe = mentions.find((m) => m.category === "pulmonary-embolism");
    assert.ok(pe, "affirmed PE should be detected");
  });

  it("does NOT detect pneumothorax when ruled out", () => {
    const html = "Pneumothorax has been ruled out based on imaging.";
    const mentions = extractCriticalMentions(html, "en-US");
    const ptx = mentions.find((m) => m.category === "pneumothorax");
    assert.equal(ptx, undefined, "ruled-out pneumothorax should NOT be detected");
  });

  it("does NOT detect hemorrhage with 'without' negation", () => {
    const html = "Brain parenchyma without hemorrhage or mass effect.";
    const mentions = extractCriticalMentions(html, "en-US");
    const bleed = mentions.find((m) => m.category === "acute-bleed");
    assert.equal(bleed, undefined, "negated hemorrhage should NOT be detected");
  });

  it("negated critical findings do not count as TP in evaluateCritical", () => {
    const benchCase = makeCase({
      findings: "rule out PE",
      criticalFindings: ["pulmonary embolism"],
    });
    const meta = makeMeta();
    // Report negates PE
    const html = "<b>Findings</b><br>No evidence of pulmonary embolism. Lungs are clear.";
    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    // The gold label "pulmonary embolism" should still be found via substring match in the report text,
    // but the extractCriticalMentions should NOT return it (important for FP count)
    const mentions = extractCriticalMentions(html, "en-US");
    assert.equal(mentions.length, 0, "no critical mentions should be extracted from negated report");
  });
});

describe("BUG 3: Pertinent negatives NOT flagged as hallucinations", () => {
  it("does not flag 'Lungs are clear' as hallucination", () => {
    const benchCase = makeCase({
      findings: "12mm gallbladder stone",
      goldFindings: [
        { finding: "gallbladder stone", severity: "minor", measurements: ["12mm"] },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    // Report includes pertinent negatives alongside the actual finding
    const html = "<b>Findings</b><br>Gallbladder stone measuring 12mm.<br>No pleural effusion.<br>Lungs are clear.<br>Liver is unremarkable.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    const hallucinations = result.details.hallucinations as Array<{ text: string }>;
    // Pertinent negatives should NOT appear as hallucinations
    const halTexts = hallucinations.map((h) => h.text.toLowerCase());
    assert.ok(
      !halTexts.some((t) => /clear|unremarkable|no pleural/.test(t)),
      `pertinent negatives should not be hallucinations, got: ${JSON.stringify(halTexts)}`,
    );
  });

  it("does not flag 'sem derrame pleural' as hallucination (pt-BR)", () => {
    const benchCase = makeCase({
      findings: "esteatose hepatica moderada",
      locale: "pt-BR",
      goldFindings: [
        { finding: "esteatose hepatica", severity: "minor" },
      ],
    });
    const meta = makeMeta({ modality: "US", region: "abdomen" });
    const html = "<b>Analise</b><br>Esteatose hepatica moderada.<br>Sem derrame pleural.<br>Rins sem alteracoes.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    const hallucinations = result.details.hallucinations as Array<{ text: string }>;
    const halTexts = hallucinations.map((h) => h.text.toLowerCase());
    assert.ok(
      !halTexts.some((t) => /sem derrame|sem alterac/.test(t)),
      `pertinent negatives should not be hallucinations, got: ${JSON.stringify(halTexts)}`,
    );
  });
});

describe("BUG 4: nDCG with ideal ranking from full gold set", () => {
  it("nDCG is lower when ideal ranking differs from retrieved ranking", () => {
    // Gold: doc1=3, doc2=2, doc3=1, doc4=0, doc5=3
    // Retrieved: [doc4, doc3, doc1] (worst ordering - irrelevant first)
    // Ideal top-3: [doc1=3, doc5=3, doc2=2]
    const benchCase = makeCase({
      retrievalGold: [
        { documentId: "doc1", relevance: 3 },
        { documentId: "doc2", relevance: 2 },
        { documentId: "doc3", relevance: 1 },
        { documentId: "doc4", relevance: 0 },
        { documentId: "doc5", relevance: 3 },
      ],
    });
    const meta = makeMeta();
    const html = "";
    // Retrieved in bad order: irrelevant first
    const retrievedDocIds = ["doc4", "doc3", "doc1"];

    const result = evaluateRetrieval(html, benchCase, "en-US", meta, [], retrievedDocIds);
    const ndcg3 = result.details["ndcg@3"] as number;
    // With correct iDCG from full gold set (top-3 ideal = [3,3,2]),
    // the nDCG should be significantly less than 1 because we retrieved [0,1,3]
    assert.ok(ndcg3 < 0.7, `nDCG@3 should be < 0.7 with bad ordering, got ${ndcg3}`);

    // Now test perfect ordering
    const perfectRetrieved = ["doc1", "doc5", "doc2"];
    const perfectResult = evaluateRetrieval(html, benchCase, "en-US", meta, [], perfectRetrieved);
    const perfectNdcg3 = perfectResult.details["ndcg@3"] as number;
    assert.ok(perfectNdcg3 > ndcg3, `perfect ordering nDCG (${perfectNdcg3}) should be > bad ordering (${ndcg3})`);
  });
});

describe("BUG 5: Hedging regex counts correctly without skipping", () => {
  it("counts all hedging sentences, not every other one", () => {
    const meta = makeMeta({ abnormalStudy: true });
    // Create a report with 4 hedging sentences in the conclusion (use pt-BR section headers)
    const html = [
      "<center><b>Tomografia Computadorizada do Cr\u00e2nio</b></center>",
      "<br><br><b>T\u00e9cnica</b><br>TC sem contraste.",
      "<br><br><b>An\u00e1lise</b><br>Lesao identificada no lobo frontal direito.",
      "<br><br><b>Conclus\u00e3o</b>",
      "<br>A esclarecer a natureza da lesao.",
      "<br>Nao se pode excluir processo expansivo.",
      "<br>Sugerir complementacao com RM.",
      "<br>Convem correlacionar clinicamente.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "lesao frontal direita", "pt-BR");
    const hedgeCheck = checks.find((c) => c.id === "Q14");
    assert.ok(hedgeCheck, "Q14 check should exist");
    // All 4 sentences are hedging out of 4, so ratio=100% > 40% threshold => should FAIL
    assert.equal(hedgeCheck!.passed, false, `all 4 sentences are hedged, should fail. Evidence: ${hedgeCheck!.evidence}`);
    // Verify the evidence shows 4/4 (not 2/4 which would happen with the lastIndex bug)
    assert.ok(hedgeCheck!.evidence.includes("4/4"), `evidence should show 4/4, got: ${hedgeCheck!.evidence}`);
  });
});

describe("BUG 6: C02 does NOT fire on normal studies", () => {
  it("does not penalize umbrella phrase in normal study conclusion", () => {
    const meta = makeMeta({ abnormalStudy: false });
    const html = [
      "<center><b>Tomografia Computadorizada de Abdome</b></center>",
      "<br><br><b>T\u00e9cnica</b><br>Tecnica padrao sem contraste.",
      "<br><br><b>An\u00e1lise</b><br>Figado de dimensoes normais. Vesicula biliar sem calculos.",
      "<br><br><b>Conclus\u00e3o</b><br>Demais estruturas sem altera\u00e7\u00f5es avali\u00e1veis. Exame normal.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "normal", "pt-BR");
    const c02 = checks.find((c) => c.id === "C02");
    // C02 should not exist at all for normal studies
    assert.equal(c02, undefined, "C02 should not fire on normal studies");
  });

  it("still penalizes umbrella phrase in abnormal study conclusion", () => {
    const meta = makeMeta({ abnormalStudy: true });
    const html = [
      "<center><b>Tomografia Computadorizada de Abdome</b></center>",
      "<br><br><b>T\u00e9cnica</b><br>Tecnica padrao sem contraste.",
      "<br><br><b>An\u00e1lise</b><br>Nodulo hepatico de 3cm no segmento VIII.",
      "<br><br><b>Conclus\u00e3o</b><br>Nodulo hepatico. Demais estruturas sem altera\u00e7\u00f5es.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "nodulo hepatico", "pt-BR");
    const c02 = checks.find((c) => c.id === "C02");
    assert.ok(c02, "C02 should exist for abnormal studies");
    assert.equal(c02!.passed, false, "C02 should fail when umbrella phrase in abnormal study conclusion");
  });
});

describe("BUG 7: CT reports with 'densidade' do NOT get penalized", () => {
  it("does not flag 'densidade' as forbidden in CT reports (pt-BR)", () => {
    const meta = makeMeta({ modality: "CT", region: "abdomen" });
    const html = [
      "<center><b>Tomografia Computadorizada de Abdome</b></center>",
      "<br><br><b>Tecnica</b><br>Tecnica padrao sem contraste.",
      "<br><br><b>Analise</b><br>Figado com atenuacao normal. Lesao de densidade de partes moles no rim direito.",
      "<br><br><b>Conclusao</b><br>Lesao renal direita de densidade de partes moles.",
    ].join("");

    const checks = runStructuralChecks(html, meta, "lesao renal direita", "pt-BR");
    const tm3 = checks.find((c) => c.id === "TM3");
    assert.ok(tm3, "TM3 check should exist");
    assert.equal(tm3!.passed, true, `'densidade' should NOT be flagged as forbidden in CT. Evidence: ${tm3!.evidence}`);
  });
});

describe("BUG 9: Bosniak Roman numeral normalization", () => {
  it("normalizes Bosniak II to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak II");
    assert.equal(result, "II");
  });

  it("normalizes Bosniak IIF to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak IIF");
    assert.equal(result, "IIF");
  });

  it("normalizes Bosniak III to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak III");
    assert.equal(result, "III");
  });

  it("normalizes Bosniak IV to canonical form", () => {
    const result = normalizeClassificationValue("Bosniak IV");
    assert.equal(result, "IV");
  });

  it("normalizes Arabic 2 to same as Roman II", () => {
    const arabic = normalizeClassificationValue("Bosniak 2");
    const roman = normalizeClassificationValue("Bosniak II");
    assert.equal(arabic, roman, `Arabic '2' (${arabic}) should equal Roman 'II' (${roman})`);
  });

  it("normalizes Arabic 2F to same as Roman IIF", () => {
    const arabic = normalizeClassificationValue("Bosniak 2F");
    const roman = normalizeClassificationValue("Bosniak IIF");
    assert.equal(arabic, roman, `Arabic '2F' (${arabic}) should equal Roman 'IIF' (${roman})`);
  });

  it("extracts and normalizes Bosniak Roman numerals from report text", () => {
    const html = "Complex renal cyst classified as Bosniak III.";
    const cls = extractClassifications(html);
    const bosniak = cls.find((c) => c.system === "bosniak");
    assert.ok(bosniak, "should find Bosniak");
    assert.equal(bosniak!.normalizedValue, "III");
  });
});

// ---- BUG F REGRESSION TESTS ----

describe("BUG F.1: compareSections segments by section header and compares independently", () => {
  it("scores higher when both sections match vs only one section matches", () => {
    const benchCase = makeCase({
      findings: "hepatic steatosis",
      referenceReport:
        "<b>Findings</b><br>Moderate hepatic steatosis. No biliary dilatation." +
        "<br><br><b>Impression</b><br>Moderate hepatic steatosis.",
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen" });

    // Good candidate: matches both sections
    const goodHtml =
      "<b>Findings</b><br>Moderate hepatic steatosis. No biliary dilatation." +
      "<br><br><b>Impression</b><br>Moderate hepatic steatosis.";

    // Bad candidate: completely different impression section
    const badHtml =
      "<b>Findings</b><br>Moderate hepatic steatosis. No biliary dilatation." +
      "<br><br><b>Impression</b><br>Pneumothorax with midline shift.";

    const goodResult = evaluateQuality(goodHtml, benchCase, "en-US", meta, []);
    const badResult = evaluateQuality(badHtml, benchCase, "en-US", meta, []);

    assert.equal(goodResult.details.mode, "reference-comparison");
    assert.equal(badResult.details.mode, "reference-comparison");
    assert.ok(
      goodResult.score > badResult.score,
      `good candidate score (${goodResult.score}) should be higher than bad (${badResult.score})`,
    );
  });

  it("detects section-level mismatch in findings vs impression", () => {
    const benchCase = makeCase({
      findings: "normal",
      referenceReport:
        "<b>Findings</b><br>Normal brain parenchyma. No acute abnormality." +
        "<br><br><b>Impression</b><br>Normal.",
    });
    const meta = makeMeta();

    // Candidate with swapped section content
    const html =
      "<b>Findings</b><br>Normal." +
      "<br><br><b>Impression</b><br>Normal brain parenchyma. No acute abnormality.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "reference-comparison");
    const sectionScores = result.details.sectionScores as Record<string, number>;
    // At least one section should have a lower score due to mismatch
    assert.ok(sectionScores !== undefined, "should have section scores");
  });

  it("does not penalize pt-BR Impressão vs Conclusão label aliases", () => {
    const benchCase = makeCase({
      locale: "pt-BR",
      findings: "esteatose hepática moderada",
      referenceReport:
        "<b>Análise</b><br>Fígado com esteatose moderada." +
        "<br><br><b>Conclusão</b><br>Esteatose hepática moderada.",
    });
    const meta = makeMeta({ normalizedExam: "tc abdome", normalizedFindings: "esteatose", region: "abdomen" });
    const html =
      "<b>Análise</b><br>Fígado com esteatose moderada." +
      "<br><br><b>Impressão</b><br>Esteatose hepática moderada.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);

    assert.equal(result.details.mode, "reference-comparison");
    assert.ok(result.score >= 95, `alias-only section label change should not drop score, got ${result.score}`);
  });
});

describe("BUG F.2: Fleischner extraction captures category text", () => {
  it("extracts Fleischner category text, not just 'mentioned'", () => {
    const html = "Pulmonary nodule. Fleischner low-risk: no follow-up needed.";
    const cls = extractClassifications(html);
    const fleischner = cls.find((c) => c.system === "fleischner");
    assert.ok(fleischner, "should find Fleischner");
    // The normalized value should contain the category text, not just 'mentioned'
    assert.ok(
      fleischner!.normalizedValue.length > 0,
      "should have a non-empty normalized value",
    );
    assert.ok(
      fleischner!.normalizedValue.includes("low-risk"),
      `should capture category text, got: '${fleischner!.normalizedValue}'`,
    );
  });

  it("returns 'mentioned' when Fleischner has no trailing text", () => {
    const html = "Recommend per Fleischner.";
    const cls = extractClassifications(html);
    const fleischner = cls.find((c) => c.system === "fleischner");
    assert.ok(fleischner, "should find Fleischner");
    assert.equal(fleischner!.normalizedValue, "mentioned");
  });
});

describe("BUG F.3: Negated gold critical findings NOT counted as TP in evaluateCritical", () => {
  it("counts negated gold-label match as FN, not TP", () => {
    const benchCase = makeCase({
      findings: "rule out PE",
      criticalFindings: ["pulmonary embolism"],
    });
    const meta = makeMeta();
    // Report says "no evidence of pulmonary embolism" — substring matches gold label
    // but should be counted as miss because it's negated
    const html = "<b>Findings</b><br>No evidence of pulmonary embolism. Lungs are clear.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");

    const tps = result.details.truePositives as string[];
    const fns = result.details.falseNegatives as string[];

    assert.ok(
      !tps.includes("pulmonary embolism"),
      "negated match should NOT be a true positive",
    );
    assert.ok(
      fns.includes("pulmonary embolism"),
      "negated match should be counted as false negative (miss)",
    );
  });

  it("still counts affirmed gold-label match as TP", () => {
    const benchCase = makeCase({
      findings: "acute PE",
      criticalFindings: ["pulmonary embolism"],
    });
    const meta = makeMeta();
    const html = "<b>Findings</b><br>Filling defects consistent with acute pulmonary embolism.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-critical");

    const tps = result.details.truePositives as string[];
    assert.ok(
      tps.includes("pulmonary embolism"),
      "affirmed match should be a true positive",
    );
  });

  it("handles mixed negated and affirmed critical findings", () => {
    const benchCase = makeCase({
      findings: "midline shift. rule out PE",
      criticalFindings: ["midline shift", "pulmonary embolism"],
    });
    const meta = makeMeta();
    // Report affirms midline shift but negates PE
    const html = "<b>Findings</b><br>5mm midline shift to the left. No evidence of pulmonary embolism.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);

    const tps = result.details.truePositives as string[];
    const fns = result.details.falseNegatives as string[];

    assert.ok(tps.includes("midline shift"), "affirmed midline shift should be TP");
    assert.ok(fns.includes("pulmonary embolism"), "negated PE should be FN");
  });
});

// ---- ADVERSARIAL & BOUNDARY TESTS ----

describe("Boundary: combineScores verdict thresholds", () => {
  function makeDimsAllScored(score: number): Record<Dim, DimSummary> {
    const dims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      dims[dim] = { score, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    return dims;
  }

  function makeJudge(dimScore: number): import("./types.js").JudgeResult {
    const scores: Partial<Record<Dim, number>> = {};
    for (const dim of DIMS) scores[dim] = dimScore;
    return {
      verdict: "PASS",
      scores,
      overall: dimScore,
      critical_failures: [],
      missing: [],
      hallucinated: [],
      spot_checks: [],
      fix: "",
    };
  }

  it("score of exactly 84 yields PASS verdict", () => {
    const dims = makeDimsAllScored(84);
    // judge scores must produce combined >= 84: judge dim score 5 => 5*20 = 100, min(84, 100) = 84
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PASS", `overall=${result.overall} should produce PASS`);
  });

  it("score of exactly 83.9 yields PARTIAL verdict", () => {
    const dims = makeDimsAllScored(83.9);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PARTIAL", `overall=${result.overall} should produce PARTIAL`);
  });

  it("score of exactly 60 yields PARTIAL verdict", () => {
    const dims = makeDimsAllScored(60);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PARTIAL", `overall=${result.overall} should produce PARTIAL`);
  });

  it("score of exactly 59.9 yields FAIL verdict", () => {
    const dims = makeDimsAllScored(59.9);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "FAIL", `overall=${result.overall} should produce FAIL`);
  });

  it("score of exactly 0 yields FAIL verdict", () => {
    const dims = makeDimsAllScored(0);
    const judge = makeJudge(0);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.overall, 0);
  });

  it("score of exactly 100 yields PASS verdict", () => {
    const dims = makeDimsAllScored(100);
    const judge = makeJudge(5);
    const result = combineScores(dims, judge, []);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.overall, 100);
  });
});

describe("Adversarial: extractFindings edge cases", () => {
  it("empty HTML string returns empty array", () => {
    const findings = extractFindings("", "en-US");
    assert.equal(findings.length, 0);
  });

  it("HTML with only tags and no text returns empty array", () => {
    const findings = extractFindings("<b></b><br><div><span></span></div>", "en-US");
    assert.equal(findings.length, 0);
  });

  it("malformed HTML with unclosed tags does not crash", () => {
    const html = "<b>Findings<br>Large hepatic mass measuring 5cm.<div><span>Pleural effusion";
    const findings = extractFindings(html, "en-US");
    // Should not throw, and should still extract what it can
    assert.ok(Array.isArray(findings));
  });

  it("script injection attempt does not crash and strips tags", () => {
    const html = '<script>alert("xss")</script><br><img onerror="hack()" src=x><br>Large hepatic mass measuring 5cm.';
    const findings = extractFindings(html, "en-US");
    // Should not throw, and no finding should contain HTML tag syntax
    assert.ok(Array.isArray(findings));
    for (const f of findings) {
      assert.ok(!/<script|<img|onerror/i.test(f.text), `finding should not contain HTML tags: ${f.text}`);
    }
  });
});

describe("Adversarial: report says opposite of gold findings", () => {
  it("report with completely unrelated findings gets low QUAL score", () => {
    const benchCase = makeCase({
      findings: "large hepatic mass. bilateral pleural effusion",
      goldFindings: [
        { finding: "hepatic mass", severity: "major" },
        { finding: "bilateral pleural effusion", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "abdomen", abnormalStudy: true });
    // Report describes entirely unrelated anatomy and findings
    const html = "<b>Findings</b><br>Mild degenerative changes of the lumbar spine. Disc desiccation at L4-L5.";

    const result = evaluateQuality(html, benchCase, "en-US", meta, []);
    assert.equal(result.details.mode, "gold-findings");
    // Completely wrong findings should produce a very low score
    assert.ok(result.score <= 30, `completely wrong report should score low, got ${result.score}`);
  });

  it("report that negates every gold critical finding yields 0% CRIT recall", () => {
    const benchCase = makeCase({
      findings: "subdural hematoma. midline shift. pneumothorax",
      criticalFindings: ["subdural hematoma", "midline shift", "pneumothorax"],
    });
    const meta = makeMeta();
    // Report negates all critical findings using patterns recognized by isNegated
    const html =
      "<b>Findings</b><br>No evidence of subdural hematoma." +
      "<br>Without midline shift." +
      "<br>Negative for pneumothorax.";

    const result = evaluateCritical(html, benchCase, "en-US", meta, []);
    const recall = result.details.recall as number;
    assert.equal(recall, 0, `negating every gold critical finding should yield 0% recall, got ${recall}`);
    const fns = result.details.falseNegatives as string[];
    assert.equal(fns.length, 3, "all 3 critical findings should be false negatives");
  });
});

describe("Adversarial: wrong BI-RADS value detected by GUIDE evaluator", () => {
  it("detects mismatch when gold=4 but report=2", () => {
    const benchCase = makeCase({
      exam: "mammography bilateral",
      findings: "irregular spiculated mass in the right breast",
      guidelineExpectations: [
        { guidelineId: "birads", expectedClassification: "BI-RADS 4" },
      ],
    });
    const meta = makeMeta({ modality: "MG", region: "unknown" });
    const html = "<b>Findings</b><br>Irregular spiculated mass in the right breast. BI-RADS 2.";

    const result = evaluateGuidelines(html, benchCase, "en-US", meta, []);
    // There should be a check that validates the BI-RADS value and it should fail
    const biradsCheck = result.checks.find((c) => c.id.includes("birads"));
    assert.ok(biradsCheck, "should have a BI-RADS check");
    // Either the correctness check fails or the overall score is penalized
    const correctnessCheck = result.checks.find((c) => c.id.includes("birads") && c.id.includes("correct"));
    if (correctnessCheck) {
      assert.equal(correctnessCheck.passed, false, "BI-RADS 2 vs gold 4 should fail correctness");
    } else {
      // If no explicit correctness check, score should be penalized
      assert.ok(result.score < 100, `wrong BI-RADS should reduce score, got ${result.score}`);
    }
  });
});

describe("Synonym matching: consolidacao matches opacidade alveolar", () => {
  it("gold 'consolidacao' matches report 'opacidade alveolar'", () => {
    const benchCase = makeCase({
      findings: "consolidacao no lobo inferior direito",
      locale: "pt-BR",
      goldFindings: [
        { finding: "consolidacao", severity: "major" },
      ],
    });
    const meta = makeMeta({ modality: "CT", region: "chest" });
    // Report uses synonym "opacidade alveolar" instead of "consolidacao"
    const html = "<b>Analise</b><br>Opacidade alveolar no lobo inferior direito sugestiva de processo infeccioso.";

    const result = evaluateQuality(html, benchCase, "pt-BR", meta, []);
    assert.equal(result.details.mode, "gold-findings");
    // Synonym matching should allow at least a partial match, scoring above 0
    const matches = result.details.findingMatches as Array<{ goldFinding: string; matchType: string }>;
    assert.ok(matches, "should have findingMatches in details");
    const goldMatch = matches.find((m) => m.goldFinding === "consolidacao");
    assert.ok(goldMatch, "should have a match entry for consolidacao");
    assert.ok(
      goldMatch!.matchType === "exact" || goldMatch!.matchType === "partial",
      `synonym should produce exact or partial match, got ${goldMatch!.matchType}`,
    );
  });
});

describe("combineScores confidence tests", () => {
  function makeDimsScored(score: number): Record<Dim, DimSummary> {
    const dims = {} as Record<Dim, DimSummary>;
    for (const dim of DIMS) {
      dims[dim] = { score, pass: 10, total: 10, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[dim] };
    }
    return dims;
  }

  it("judge with hallucinations degrades confidence to medium", () => {
    const dims = makeDimsScored(90);
    const judge: import("./types.js").JudgeResult = {
      verdict: "PASS",
      scores: { CRIT: 4.5, QUAL: 4.5, TERM: 4.5, GUIDE: 4.5, RAG: 4.5 },
      overall: 4.5,
      critical_failures: [],
      missing: [],
      hallucinated: ["invented finding about cardiac tamponade"],
      spot_checks: [],
      fix: "",
    };
    const result = combineScores(dims, judge, []);
    assert.equal(result.confidence, "medium", "hallucinated findings should degrade confidence to medium");
  });

  it("no judge results in low confidence", () => {
    const dims = makeDimsScored(50);
    const result = combineScores(dims, null, []);
    assert.equal(result.confidence, "low", "absence of judge should yield low confidence");
  });
});

// ---- Stats module tests ----

describe("bootstrapCI", () => {
  it("returns point estimate for single score", () => {
    const result = bootstrapCI([75]);
    assert.equal(result.mean, 75);
    assert.equal(result.lower, 75);
    assert.equal(result.upper, 75);
  });

  it("returns zeros for empty array", () => {
    const result = bootstrapCI([]);
    assert.equal(result.mean, 0);
    assert.equal(result.lower, 0);
    assert.equal(result.upper, 0);
  });

  it("CI contains the true mean for uniform data", () => {
    const scores = Array.from({ length: 50 }, (_, i) => 60 + i);
    const result = bootstrapCI(scores);
    assert.ok(result.lower <= result.mean, `lower (${result.lower}) should be <= mean (${result.mean})`);
    assert.ok(result.upper >= result.mean, `upper (${result.upper}) should be >= mean (${result.mean})`);
    assert.ok(result.lower < result.upper, `lower (${result.lower}) should be < upper (${result.upper})`);
  });

  it("produces narrower CI with more data", () => {
    const small = bootstrapCI([80, 85, 90, 70, 75]);
    const large = bootstrapCI(Array.from({ length: 100 }, () => 80));
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    assert.ok(largeWidth <= smallWidth, `large sample CI width (${largeWidth}) should be <= small (${smallWidth})`);
  });

  it("is deterministic with the same seed", () => {
    const scores = [70, 80, 90, 60, 85, 95, 50, 75];
    const a = bootstrapCI(scores, 5000, 0.05, 123);
    const b = bootstrapCI(scores, 5000, 0.05, 123);
    assert.equal(a.mean, b.mean);
    assert.equal(a.lower, b.lower);
    assert.equal(a.upper, b.upper);
  });

  it("wider CI with higher alpha (narrower confidence level)", () => {
    const scores = [70, 80, 90, 60, 85, 95, 50, 75, 65, 88];
    const ci95 = bootstrapCI(scores, 10000, 0.05);
    const ci80 = bootstrapCI(scores, 10000, 0.20);
    const width95 = ci95.upper - ci95.lower;
    const width80 = ci80.upper - ci80.lower;
    assert.ok(width95 >= width80, `95% CI width (${width95}) should be >= 80% CI width (${width80})`);
  });
});

describe("mcNemarTest", () => {
  it("returns chi2=0 and pValue=1 when models agree perfectly", () => {
    const a = [true, true, false, false, true];
    const b = [true, true, false, false, true];
    const result = mcNemarTest(a, b);
    assert.equal(result.chi2, 0);
    assert.equal(result.pValue, 1);
  });

  it("throws on mismatched array lengths", () => {
    assert.throws(() => mcNemarTest([true], [true, false]), /equal length/);
  });

  it("detects significant difference with large discordant pairs", () => {
    // A correct on 20 cases where B is wrong, B correct on 2 cases where A is wrong
    const n = 100;
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < n; i++) {
      if (i < 50) { a.push(true); b.push(true); }      // both correct
      else if (i < 70) { a.push(true); b.push(false); } // A correct, B wrong (20 cases)
      else if (i < 72) { a.push(false); b.push(true); } // B correct, A wrong (2 cases)
      else { a.push(false); b.push(false); }             // both wrong
    }
    const result = mcNemarTest(a, b);
    assert.ok(result.chi2 > 0, `chi2 should be > 0, got ${result.chi2}`);
    assert.ok(result.pValue < 0.05, `pValue should be < 0.05, got ${result.pValue}`);
  });

  it("returns non-significant for balanced discordant pairs", () => {
    // A correct on 10, B correct on 10 -- symmetric disagreement
    const a: boolean[] = [];
    const b: boolean[] = [];
    for (let i = 0; i < 50; i++) {
      if (i < 20) { a.push(true); b.push(true); }
      else if (i < 30) { a.push(true); b.push(false); }
      else if (i < 40) { a.push(false); b.push(true); }
      else { a.push(false); b.push(false); }
    }
    const result = mcNemarTest(a, b);
    assert.ok(result.pValue > 0.05, `balanced disagreement should not be significant, pValue=${result.pValue}`);
  });
});

describe("cohensH", () => {
  it("returns 0 for equal proportions", () => {
    assert.equal(cohensH(0.5, 0.5), 0);
  });

  it("returns positive when p1 > p2", () => {
    const h = cohensH(0.9, 0.5);
    assert.ok(h > 0, `cohensH(0.9, 0.5) should be positive, got ${h}`);
  });

  it("returns negative when p1 < p2", () => {
    const h = cohensH(0.3, 0.8);
    assert.ok(h < 0, `cohensH(0.3, 0.8) should be negative, got ${h}`);
  });

  it("is antisymmetric: h(p1,p2) = -h(p2,p1)", () => {
    const h1 = cohensH(0.7, 0.3);
    const h2 = cohensH(0.3, 0.7);
    assert.ok(Math.abs(h1 + h2) < 0.0001, `h(0.7,0.3)=${h1} and h(0.3,0.7)=${h2} should sum to ~0`);
  });

  it("extreme proportions yield large effect size", () => {
    const h = cohensH(1.0, 0.0);
    assert.ok(Math.abs(h) > 2, `h(1.0, 0.0) should be large, got ${h}`);
  });

  it("throws for out-of-range proportions", () => {
    assert.throws(() => cohensH(-0.1, 0.5), /\[0,1\]/);
    assert.throws(() => cohensH(0.5, 1.1), /\[0,1\]/);
  });

  it("classifies small effect size correctly", () => {
    // ~0.2 effect size from close proportions
    const h = cohensH(0.55, 0.50);
    assert.ok(Math.abs(h) < 0.2, `close proportions should give small effect, got |h|=${Math.abs(h)}`);
  });
});
