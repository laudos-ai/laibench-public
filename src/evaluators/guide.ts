/**
 * Guideline evaluator with modular engine.
 * Registry of guideline modules, each checking applicability → presence → correctness.
 * Built-in modules: Fleischner, BI-RADS, TI-RADS, LI-RADS, PI-RADS, Bosniak, Lung-RADS.
 * If case has guidelineExpectations gold: validate against gold.
 * If no gold: detect from context and check presence.
 * Falls back to anatomy coverage if no guidelines apply.
 */

import { extractClassifications, normalizeClassificationValue } from "../extract.js";
import { normalizeLoose, stripTags } from "../normalize.js";
import type { BenchCase, Check, EvaluatorResult, ExamMeta, GuidelineExpectation, LocaleKey } from "../types.js";

function weightedCheckScore(checks: Check[], floor = 0): number {
  if (checks.length === 0) return 100;
  const weight = (check: Check): number => check.severity === "critical" ? 4 : check.severity === "major" ? 2 : 1;
  const total = checks.reduce((sum, check) => sum + weight(check), 0);
  const passed = checks.reduce((sum, check) => sum + (check.passed ? weight(check) : 0), 0);
  return Math.max(floor, Math.round((passed / total) * 100));
}

function anatomyCoverageScore(checks: Check[]): number {
  if (checks.length === 0) return 100;
  const passCount = checks.filter((c) => c.passed).length;
  const ratio = passCount / checks.length;
  return Math.round(75 + ratio * 25);
}

// ---- Valid value ranges per classification system ----

const VALID_VALUES: Record<string, Set<string>> = {
  birads: new Set(["0", "1", "2", "3", "4", "4A", "4B", "4C", "5", "6"]),
  tirads: new Set(["1", "2", "3", "4", "5", "TR1", "TR2", "TR3", "TR4", "TR5"]),
  pirads: new Set(["1", "2", "3", "4", "5"]),
  lirads: new Set(["1", "2", "3", "4", "5", "M", "TNC", "LR1", "LR2", "LR3", "LR4", "LR5", "LRM", "LR-TNC"]),
  bosniak: new Set(["1", "2", "2F", "3", "4", "I", "II", "IIF", "III", "IV"]),
  lungrads: new Set(["0", "1", "2", "3", "4A", "4B", "4X", "S"]),
  // Fleischner has no specific classification values — just presence
};

/**
 * Validate that a classification value is within the allowed set for the given system.
 * Returns true if valid or if no valid-value-set is defined (e.g. Fleischner).
 */
function isValidClassificationValue(system: string, normalizedValue: string): boolean {
  const validSet = VALID_VALUES[system];
  if (!validSet) return true; // no constraints (e.g. Fleischner)
  return validSet.has(normalizedValue);
}

// ---- Guideline module interface ----

type GuidelineEvaluation = {
  applicable: boolean;
  present: boolean;
  correct: boolean | null; // null if no gold to check correctness against
  foundClassification?: string;
  expectedClassification?: string;
  recommendationPresent?: boolean;
  recommendationExpected?: boolean;
  details: string;
};

type GuidelineModule = {
  id: string;
  name: string;
  appliesTo(benchCase: BenchCase, reportHtml: string, meta: ExamMeta, locale: LocaleKey): boolean;
  evaluate(
    benchCase: BenchCase,
    reportHtml: string,
    meta: ExamMeta,
    locale: LocaleKey,
    goldExpectation?: GuidelineExpectation,
  ): GuidelineEvaluation;
};

// ---- Helper functions ----

function reportContains(reportHtml: string, rx: RegExp): boolean {
  return rx.test(stripTags(reportHtml));
}

function findingsContain(benchCase: BenchCase, rx: RegExp): boolean {
  return rx.test(normalizeLoose(benchCase.findings));
}

function sourceContextContains(benchCase: BenchCase, rx: RegExp): boolean {
  const goldContext = (benchCase.goldFindings ?? [])
    .map((g) => [g.finding, g.location, ...(g.measurements ?? [])].filter(Boolean).join(" "))
    .join(" ");
  const referenceContext = benchCase.referenceReport ? stripTags(benchCase.referenceReport) : "";
  const combined = normalizeLoose(`${benchCase.exam} ${benchCase.findings} ${goldContext} ${referenceContext}`);
  return rx.test(combined);
}

// ---- Built-in guideline modules ----

const fleischnerModule: GuidelineModule = {
  id: "fleischner",
  name: "Fleischner Society Guidelines (Pulmonary Nodules)",
  appliesTo(benchCase, reportHtml, meta) {
    if (meta.modality !== "CT") return false;
    return sourceContextContains(benchCase, /nodulo.*pulmon|pulmon.*nodulo|pulmonary\s+nodule|lung\s+nodule/i);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /fleischner/i.test(reportText);
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification) {
      // Fleischner doesn't have numeric classifications, just "mentioned" or specific recommendations
      correct = present;
    }

    const recPresent = /(?:follow[\s-]?up|controle|acompanhamento|seguimento)\s+(?:em|in|after|após)?\s*\d+\s*(?:month|mes|year|ano)/i.test(reportText);

    return {
      applicable: true,
      present,
      correct,
      details: present ? "Fleischner referenced" : "Fleischner not mentioned for pulmonary nodule",
      recommendationPresent: recPresent,
      recommendationExpected: goldExpectation?.recommendationRequired,
    };
  },
};

const biradsModule: GuidelineModule = {
  id: "birads",
  name: "BI-RADS (Breast Imaging)",
  appliesTo(benchCase, reportHtml, meta) {
    // BUG D FIX: Include MG (mammography) and MX (digital mammography) alongside US and MRI
    if (meta.modality !== "US" && meta.modality !== "MRI" && meta.modality !== "MG" && meta.modality !== "MX") return false;
    return sourceContextContains(benchCase, /nodulo.*mama|mama.*nodulo|lesao.*mama|breast.*(?:nodule|mass|lesion)|(?:nodule|mass|lesion).*breast/i);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /bi-?rads/i.test(reportText);
    const classifications = extractClassifications(reportHtml).filter((c) => c.system === "birads");
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification && classifications.length > 0) {
      const expectedNorm = normalizeClassificationValue(goldExpectation.expectedClassification);
      correct = classifications.some((c) => c.normalizedValue === expectedNorm);
    }

    const recPresent = /biops|punç|follow[\s-]?up|controle|acompanhamento/i.test(reportText);

    return {
      applicable: true,
      present,
      correct,
      foundClassification: classifications[0]?.rawText,
      expectedClassification: goldExpectation?.expectedClassification,
      details: present
        ? `BI-RADS found: ${classifications.map((c) => c.rawText).join(", ") || "mentioned without value"}`
        : "BI-RADS not mentioned for breast finding",
      recommendationPresent: recPresent,
      recommendationExpected: goldExpectation?.recommendationRequired,
    };
  },
};

const tiradsModule: GuidelineModule = {
  id: "tirads",
  name: "TI-RADS (Thyroid Imaging)",
  appliesTo(benchCase, reportHtml, meta) {
    if (meta.modality !== "US") return false;
    return sourceContextContains(benchCase, /nodulo.*tireoide|tireoide.*nodulo|thyroid.*nodule|nodule.*thyroid/i);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /ti-?rads/i.test(reportText);
    const classifications = extractClassifications(reportHtml).filter((c) => c.system === "tirads");
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification && classifications.length > 0) {
      const expectedNorm = normalizeClassificationValue(goldExpectation.expectedClassification);
      correct = classifications.some((c) => c.normalizedValue === expectedNorm);
    }

    const recPresent = /biops|punç|follow[\s-]?up|controle|acompanhamento/i.test(reportText);

    return {
      applicable: true,
      present,
      correct,
      foundClassification: classifications[0]?.rawText,
      expectedClassification: goldExpectation?.expectedClassification,
      details: present
        ? `TI-RADS found: ${classifications.map((c) => c.rawText).join(", ") || "mentioned without value"}`
        : "TI-RADS not mentioned for thyroid nodule",
      recommendationPresent: recPresent,
      recommendationExpected: goldExpectation?.recommendationRequired,
    };
  },
};

const liradsModule: GuidelineModule = {
  id: "lirads",
  name: "LI-RADS (Liver Imaging)",
  appliesTo(benchCase, reportHtml, meta) {
    if (meta.modality !== "CT" && meta.modality !== "MRI") return false;
    const combined = normalizeLoose(`${benchCase.exam} ${benchCase.findings}`);
    return /nodulo.*figado|figado.*nodulo|lesao.*hepat|hepat.*lesion|liver.*(?:nodule|mass|lesion)|(?:nodule|mass|lesion).*liver/i.test(combined) &&
      /cirros|hepatopat|cronico|cirrhosis|chronic\s+liver/i.test(combined);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /li-?rads/i.test(reportText);
    const classifications = extractClassifications(reportHtml).filter((c) => c.system === "lirads");
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification && classifications.length > 0) {
      const expectedNorm = normalizeClassificationValue(goldExpectation.expectedClassification);
      correct = classifications.some((c) => c.normalizedValue === expectedNorm);
    }

    return {
      applicable: true,
      present,
      correct,
      foundClassification: classifications[0]?.rawText,
      expectedClassification: goldExpectation?.expectedClassification,
      details: present
        ? `LI-RADS found: ${classifications.map((c) => c.rawText).join(", ") || "mentioned without value"}`
        : "LI-RADS not mentioned for hepatic lesion in chronic liver disease",
    };
  },
};

const piradsModule: GuidelineModule = {
  id: "pirads",
  name: "PI-RADS (Prostate Imaging)",
  appliesTo(benchCase, reportHtml, meta) {
    if (meta.modality !== "MRI") return false;
    return sourceContextContains(benchCase, /prostata|prostate/i);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /pi-?rads/i.test(reportText);
    const classifications = extractClassifications(reportHtml).filter((c) => c.system === "pirads");
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification && classifications.length > 0) {
      const expectedNorm = normalizeClassificationValue(goldExpectation.expectedClassification);
      correct = classifications.some((c) => c.normalizedValue === expectedNorm);
    }

    return {
      applicable: true,
      present,
      correct,
      foundClassification: classifications[0]?.rawText,
      expectedClassification: goldExpectation?.expectedClassification,
      details: present
        ? `PI-RADS found: ${classifications.map((c) => c.rawText).join(", ") || "mentioned without value"}`
        : "PI-RADS not mentioned for prostate MRI",
    };
  },
};

const bosniakModule: GuidelineModule = {
  id: "bosniak",
  name: "Bosniak Classification (Renal Cysts)",
  appliesTo(benchCase, reportHtml, meta) {
    // BUG E FIX: Bosniak classification requires CT or MRI modality (not US or XR)
    if (meta.modality !== "CT" && meta.modality !== "MRI") return false;
    const combined = normalizeLoose(`${benchCase.exam} ${benchCase.findings}`);
    return /cisto.*ren|ren.*cisto|renal\s+cyst|kidney\s+cyst/i.test(combined) &&
      /complex|sept|solid|irregular|septated|heterogen/i.test(combined);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /bosniak/i.test(reportText);
    const classifications = extractClassifications(reportHtml).filter((c) => c.system === "bosniak");
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification && classifications.length > 0) {
      const expectedNorm = normalizeClassificationValue(goldExpectation.expectedClassification);
      correct = classifications.some((c) => c.normalizedValue === expectedNorm);
    }

    return {
      applicable: true,
      present,
      correct,
      foundClassification: classifications[0]?.rawText,
      expectedClassification: goldExpectation?.expectedClassification,
      details: present
        ? `Bosniak found: ${classifications.map((c) => c.rawText).join(", ") || "mentioned without value"}`
        : "Bosniak not mentioned for complex renal cyst",
    };
  },
};

const lungradsModule: GuidelineModule = {
  id: "lungrads",
  name: "Lung-RADS (Lung Cancer Screening)",
  appliesTo(benchCase, reportHtml, meta) {
    if (meta.modality !== "CT") return false;
    const combined = normalizeLoose(`${benchCase.exam} ${benchCase.findings}`);
    return /nodulo.*pulmon|pulmon.*nodulo|pulmonary\s+nodule|lung\s+nodule/i.test(combined) &&
      /screening|rastreamento|rastreio|low[\s-]?dose/i.test(combined);
  },
  evaluate(benchCase, reportHtml, _meta, _locale, goldExpectation) {
    const reportText = stripTags(reportHtml);
    const present = /lung-?rads/i.test(reportText);
    const classifications = extractClassifications(reportHtml).filter((c) => c.system === "lungrads");
    let correct: boolean | null = null;

    if (goldExpectation?.expectedClassification && classifications.length > 0) {
      const expectedNorm = normalizeClassificationValue(goldExpectation.expectedClassification);
      correct = classifications.some((c) => c.normalizedValue === expectedNorm);
    }

    const recPresent = /follow[\s-]?up|controle|acompanhamento|pet|biops/i.test(reportText);

    return {
      applicable: true,
      present,
      correct,
      foundClassification: classifications[0]?.rawText,
      expectedClassification: goldExpectation?.expectedClassification,
      details: present
        ? `Lung-RADS found: ${classifications.map((c) => c.rawText).join(", ") || "mentioned without value"}`
        : "Lung-RADS not mentioned for lung screening nodule",
      recommendationPresent: recPresent,
      recommendationExpected: goldExpectation?.recommendationRequired,
    };
  },
};

// ---- Guideline registry ----

const GUIDELINE_REGISTRY: GuidelineModule[] = [
  fleischnerModule,
  biradsModule,
  tiradsModule,
  liradsModule,
  piradsModule,
  bosniakModule,
  lungradsModule,
];

/**
 * Get all guideline modules. Allows external modules to be registered.
 */
export function getGuidelineModules(): GuidelineModule[] {
  return [...GUIDELINE_REGISTRY];
}

/**
 * Find a guideline module by ID.
 */
export function getGuidelineModule(id: string): GuidelineModule | undefined {
  return GUIDELINE_REGISTRY.find((m) => m.id === id);
}

// ---- Main evaluator ----

/**
 * Evaluate guideline compliance.
 * If gold guidelineExpectations exist: validate each expected guideline.
 * If no gold: detect applicable guidelines from context, check presence.
 * Fall back to anatomy coverage if no guidelines apply.
 */
export function evaluateGuidelines(
  reportHtml: string,
  benchCase: BenchCase,
  locale: LocaleKey,
  meta: ExamMeta,
  structuralChecks: Check[],
): EvaluatorResult {
  const checks: Check[] = [];
  const details: Record<string, unknown> = {};
  const evaluations: Array<{ moduleId: string; result: GuidelineEvaluation }> = [];

  // Strategy 1: Gold guideline expectations
  if (benchCase.guidelineExpectations && benchCase.guidelineExpectations.length > 0) {
    details.mode = "gold-expectations";

    for (const expectation of benchCase.guidelineExpectations) {
      const module = getGuidelineModule(expectation.guidelineId);
      if (!module) {
        checks.push({
          dim: "GUIDE",
          id: `GX-${expectation.guidelineId}`,
          name: `Unknown guideline: ${expectation.guidelineId}`,
          severity: "minor",
          passed: true,
          evidence: "guideline module not registered",
        });
        continue;
      }

      const result = module.evaluate(benchCase, reportHtml, meta, locale, expectation);
      evaluations.push({ moduleId: module.id, result });

      // Check 1: Guideline mentioned
      checks.push({
        dim: "GUIDE",
        id: `GE-${module.id}-presence`,
        name: `${module.name}: classification present`,
        severity: "major",
        passed: result.present,
        evidence: result.details,
      });

      // Check 1b: Valid classification value range
      if (result.present && result.foundClassification) {
        const foundClassifications = extractClassifications(reportHtml).filter((c) => c.system === module.id);
        for (const fc of foundClassifications) {
          const valid = isValidClassificationValue(module.id, fc.normalizedValue);
          if (!valid) {
            checks.push({
              dim: "GUIDE",
              id: `GE-${module.id}-valid-range`,
              name: `${module.name}: classification value in valid range`,
              severity: "critical",
              passed: false,
              evidence: `invalid value "${fc.rawText}" (normalized: "${fc.normalizedValue}") — not in allowed set for ${module.id}`,
            });
          }
        }
      }

      // Check 2: Classification correct (if gold specifies expected value)
      if (expectation.expectedClassification && result.correct !== null) {
        checks.push({
          dim: "GUIDE",
          id: `GE-${module.id}-correct`,
          name: `${module.name}: classification correct`,
          severity: "critical",
          passed: result.correct,
          evidence: result.correct
            ? `found=${result.foundClassification} expected=${expectation.expectedClassification}`
            : `found=${result.foundClassification ?? "none"} expected=${expectation.expectedClassification}`,
        });
      }

      // Check 3: Recommendation present (if required)
      if (expectation.recommendationRequired) {
        checks.push({
          dim: "GUIDE",
          id: `GE-${module.id}-recommendation`,
          name: `${module.name}: recommendation present`,
          severity: "minor",
          passed: result.recommendationPresent === true,
          evidence: result.recommendationPresent ? "recommendation found" : "recommendation missing",
        });
      }

      // Check 4: Specific expected recommendation
      if (expectation.expectedRecommendation) {
        const reportText = normalizeLoose(stripTags(reportHtml));
        const expectedNorm = normalizeLoose(expectation.expectedRecommendation);
        const tokens = expectedNorm.split(/\s+/).filter((t) => t.length > 3);
        const matched = tokens.filter((t) => reportText.includes(t));
        const ratio = tokens.length > 0 ? matched.length / tokens.length : 1;
        checks.push({
          dim: "GUIDE",
          id: `GE-${module.id}-rec-content`,
          name: `${module.name}: expected recommendation content`,
          severity: "minor",
          passed: ratio >= 0.5,
          evidence: `${matched.length}/${tokens.length} key terms matched`,
        });
      }
    }

    details.evaluations = evaluations.map((e) => ({ module: e.moduleId, ...e.result }));
    const score = weightedCheckScore(checks, 55);

    return { dim: "GUIDE", score, checks, details };
  }

  // Strategy 2: Auto-detect applicable guidelines (no gold expectations)
  details.mode = "auto-detect";

  let guidelinesApplied = false;

  for (const module of GUIDELINE_REGISTRY) {
    if (!module.appliesTo(benchCase, reportHtml, meta, locale)) continue;

    guidelinesApplied = true;
    const result = module.evaluate(benchCase, reportHtml, meta, locale);
    evaluations.push({ moduleId: module.id, result });

    // Only check presence when auto-detecting (no gold to check correctness against)
    checks.push({
      dim: "GUIDE",
      id: `GA-${module.id}`,
      name: `${module.name}: classification mentioned`,
      severity: "minor",
      passed: result.present,
      evidence: result.details,
    });

    // Valid classification value range check
    if (result.present && result.foundClassification) {
      const foundClassifications = extractClassifications(reportHtml).filter((c) => c.system === module.id);
      for (const fc of foundClassifications) {
        const valid = isValidClassificationValue(module.id, fc.normalizedValue);
        if (!valid) {
          checks.push({
            dim: "GUIDE",
            id: `GA-${module.id}-valid-range`,
            name: `${module.name}: classification value in valid range`,
            severity: "critical",
            passed: false,
            evidence: `invalid value "${fc.rawText}" (normalized: "${fc.normalizedValue}") — not in allowed set for ${module.id}`,
          });
        }
      }
    }
  }

  // Strategy 3: Fall back to structural anatomy coverage checks
  if (!guidelinesApplied) {
    details.mode = "anatomical-coverage-fallback";
    const guideChecks = structuralChecks.filter((c) => c.dim === "GUIDE");
    const score = anatomyCoverageScore(guideChecks);
    return { dim: "GUIDE", score, checks: guideChecks, details };
  }

  details.evaluations = evaluations.map((e) => ({ module: e.moduleId, ...e.result }));
  const score = weightedCheckScore(checks, 75);

  return { dim: "GUIDE", score, checks, details };
}
