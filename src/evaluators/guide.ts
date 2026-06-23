/**
 * Guideline evaluator with modular engine.
 * Registry of guideline modules, each checking applicability → presence → correctness.
 * Built-in modules: Fleischner, BI-RADS, TI-RADS, LI-RADS, PI-RADS, Bosniak, Lung-RADS.
 * If case has guidelineExpectations gold: validate against gold.
 * If no explicit gold: derive narrow guideline expectations from reference
 * reports or clinically mandatory source context.
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
  return weightedCheckScore(checks);
}

function coverageToken(check: Check): string {
  const fromEvidence = /^missing:\s*(.+)$/i.exec(check.evidence);
  if (fromEvidence) return normalizeLoose(fromEvidence[1]);
  const fromName = /Anatomical coverage:\s*(.+)$/i.exec(check.name);
  return normalizeLoose(fromName?.[1] ?? "");
}

function scopedAnatomyCoverageChecks(checks: Check[], benchCase: BenchCase): Check[] {
  const goldContext = (benchCase.goldFindings ?? [])
    .map((g) => [g.finding, g.location, ...(g.measurements ?? [])].filter(Boolean).join(" "))
    .join(" ");
  const referenceContext = benchCase.referenceReport ? stripTags(benchCase.referenceReport) : "";
  const context = normalizeLoose(`${benchCase.findings} ${goldContext} ${referenceContext}`);
  if (!context) return checks;
  return checks.filter((check) => {
    const token = coverageToken(check);
    return token.length > 0 && context.includes(token);
  });
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

function expectationFromReference(
  module: GuidelineModule,
  benchCase: BenchCase,
  meta: ExamMeta,
  locale: LocaleKey,
): GuidelineExpectation | null {
  if (!benchCase.referenceReport) return null;
  if (!module.appliesTo(benchCase, benchCase.referenceReport, meta, locale)) return null;

  const referenceResult = module.evaluate(benchCase, benchCase.referenceReport, meta, locale);
  if (!referenceResult.present) return null;

  const referenceClassification = extractClassifications(benchCase.referenceReport)
    .find((c) => c.system === module.id);

  return {
    guidelineId: module.id,
    ...(referenceClassification ? { expectedClassification: referenceClassification.rawText } : {}),
    ...(referenceResult.recommendationPresent ? { recommendationRequired: true } : {}),
  };
}

function defaultClinicalExpectation(
  module: GuidelineModule,
  benchCase: BenchCase,
  meta: ExamMeta,
  locale: LocaleKey,
): GuidelineExpectation | null {
  if (benchCase.referenceReport) return null;
  if (!module.appliesTo(benchCase, "", meta, locale)) return null;
  if (module.id === "pirads" && !sourceContextContains(benchCase, /(?:lesao|les[aã]o|nodulo|n[oó]dulo|foco|area|[áa]rea|susp|neoplas|cancer|c[aâ]ncer).*(?:prostata|pr[oó]stata|prostate)|(?:prostata|pr[oó]stata|prostate).*(?:lesao|les[aã]o|nodulo|n[oó]dulo|foco|area|[áa]rea|susp|neoplas|cancer|c[aâ]ncer)/i)) {
    return null;
  }
  return { guidelineId: module.id };
}

function buildGuidelineExpectations(
  benchCase: BenchCase,
  meta: ExamMeta,
  locale: LocaleKey,
): { expectations: GuidelineExpectation[]; sources: Record<string, string> } {
  const expectations = new Map<string, GuidelineExpectation>();
  const sources: Record<string, string> = {};

  for (const expectation of benchCase.guidelineExpectations ?? []) {
    expectations.set(expectation.guidelineId, expectation);
    sources[expectation.guidelineId] = "explicit";
  }

  for (const module of GUIDELINE_REGISTRY) {
    if (expectations.has(module.id)) continue;
    const referenceExpectation = expectationFromReference(module, benchCase, meta, locale);
    if (referenceExpectation) {
      expectations.set(module.id, referenceExpectation);
      sources[module.id] = "referenceReport";
    }
  }

  for (const module of GUIDELINE_REGISTRY) {
    if (expectations.has(module.id)) continue;
    const inferredExpectation = defaultClinicalExpectation(module, benchCase, meta, locale);
    if (inferredExpectation) {
      expectations.set(module.id, inferredExpectation);
      sources[module.id] = "source-context";
    }
  }

  return { expectations: Array.from(expectations.values()), sources };
}

// ---- Built-in guideline modules ----

const fleischnerModule: GuidelineModule = {
  id: "fleischner",
  name: "Fleischner Society Guidelines (Pulmonary Nodules)",
  appliesTo(benchCase, reportHtml, meta) {
    if (meta.modality !== "CT") return false;
    // Fleischner governs INCIDENTAL nodules. In a screening/low-dose context the
    // correct framework is Lung-RADS, not Fleischner — they are mutually exclusive,
    // so do not also expect Fleischner on a screening case (which would penalize a
    // correct Lung-RADS-only report).
    if (sourceContextContains(benchCase, /screening|rastreamento|rastreio|low[\s-]?dose/i)) return false;
    return sourceContextContains(benchCase, /nodulo[\s\S]{0,50}pulmon|pulmon[\s\S]{0,50}nodulo|pulmonary\s+nodule|lung\s+nodule/i);
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
    return sourceContextContains(benchCase, /nodulo[\s\S]{0,50}mama|mama[\s\S]{0,50}nodulo|lesao[\s\S]{0,50}mama|mama[\s\S]{0,50}lesao|massa[\s\S]{0,50}mama|mama[\s\S]{0,50}massa|breast[\s\S]{0,50}(?:nodule|mass|lesion)|(?:nodule|mass|lesion)[\s\S]{0,50}breast/i);
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
    return sourceContextContains(benchCase, /nodulo[\s\S]{0,50}tireoide|tireoide[\s\S]{0,50}nodulo|thyroid[\s\S]{0,50}nodule|nodule[\s\S]{0,50}thyroid/i);
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
    return /nodulo[\s\S]{0,50}figado|figado[\s\S]{0,50}nodulo|lesao[\s\S]{0,50}hepat|hepat[\s\S]{0,50}lesion|liver[\s\S]{0,50}(?:nodule|mass|lesion)|(?:nodule|mass|lesion)[\s\S]{0,50}liver/i.test(combined) &&
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
    return /cisto[\s\S]{0,50}ren|ren[\s\S]{0,50}cisto|renal\s+cyst|kidney\s+cyst/i.test(combined) &&
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
    return /nodulo[\s\S]{0,50}pulmon|pulmon[\s\S]{0,50}nodulo|pulmonary\s+nodule|lung\s+nodule/i.test(combined) &&
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
 * If gold guidelineExpectations exist, or a narrow expectation can be derived
 * from the reference report/source context, validate each expected guideline.
 * Otherwise validate observed guideline classifications and fall back to
 * anatomy coverage.
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
  const guidelineExpectationSet = buildGuidelineExpectations(benchCase, meta, locale);

  // Strategy 1: Explicit, reference-derived, or narrow source-context expectations.
  if (guidelineExpectationSet.expectations.length > 0) {
    details.mode = "expected-guidelines";
    details.expectationSources = guidelineExpectationSet.sources;

    for (const expectation of guidelineExpectationSet.expectations) {
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
      } else if (expectation.expectedClassification && result.present && !result.foundClassification) {
        // qual-structural-guide-rag-1: the report named the guideline acronym
        // (present=true) but supplied NO actionable category, so the module left
        // result.correct null and no foundClassification. The presence check
        // above would otherwise award credit while the correctness gate is
        // silently dodged — a present-without-value report leaking free points.
        // An expected category that is never actually stated is a critical miss,
        // not a partial credit, so emit the correctness check as a hard FAIL.
        checks.push({
          dim: "GUIDE",
          id: `GE-${module.id}-correct`,
          name: `${module.name}: classification correct`,
          severity: "critical",
          passed: false,
          evidence: `guideline named but no actionable category supplied; expected=${expectation.expectedClassification}`,
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

  // Strategy 2: Auto-detect applicable guidelines (no gold expectations).
  // Without explicit gold expectations, context-only guideline inference is too
  // noisy for public scoring. We validate classifications that are actually
  // present, but absence remains unscored and falls through to anatomy coverage.
  details.mode = "auto-detect-observed";

  let guidelinesApplied = false;

  for (const module of GUIDELINE_REGISTRY) {
    if (!module.appliesTo(benchCase, reportHtml, meta, locale)) continue;

    const result = module.evaluate(benchCase, reportHtml, meta, locale);
    evaluations.push({ moduleId: module.id, result });
    if (!result.present) continue;

    guidelinesApplied = true;

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
    const guideChecks = scopedAnatomyCoverageChecks(
      structuralChecks.filter((c) => c.dim === "GUIDE"),
      benchCase,
    );
    details.scopedCoverage = {
      retained: guideChecks.length,
      total: structuralChecks.filter((c) => c.dim === "GUIDE").length,
    };
    const score = anatomyCoverageScore(guideChecks);
    return { dim: "GUIDE", score, checks: guideChecks, details };
  }

  details.evaluations = evaluations.map((e) => ({ module: e.moduleId, ...e.result }));
  const score = weightedCheckScore(checks, 75);

  return { dim: "GUIDE", score, checks, details };
}
