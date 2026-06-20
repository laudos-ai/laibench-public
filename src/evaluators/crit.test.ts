import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCritical } from "./crit.js";
import { CRITICAL_KEYWORDS_EN, CRITICAL_KEYWORDS_PT } from "../extract.js";
import type { BenchCase, Check, ExamMeta, GoldFinding, LocaleKey } from "../types.js";

const META: ExamMeta = {
  modality: "CT", contrast: false, region: "head",
  normalizedExam: "", normalizedFindings: "", abnormalStudy: true,
  expectedTitleTokens: [], expectedRegionTokens: [],
};

function critChecks(gold: GoldFinding[], reportHtml: string, locale: LocaleKey): Check[] {
  const benchCase: BenchCase = { id: "c", exam: "ct head", findings: gold.map((g) => g.finding).join(". "), locale, goldFindings: gold };
  return evaluateCritical(reportHtml, benchCase, locale, META, []).checks;
}
const cg01 = (checks: Check[]) => checks.find((c) => c.id === "CG01");

// A compound AFFIRMED critical gold label that appends an unrelated pertinent
// negative ("Acute hemorrhage, no midline shift") must still gate: omitting the
// affirmed critical must produce a failed critical-recall check (CG01). A whole
// label hasNegationCue() check used to drop these from the gate entirely.

describe("evaluateCritical: compound affirmed critical labels are gated (clause-scoped)", () => {
  it("en-US: omitting an affirmed compound critical fails CG01", () => {
    const checks = critChecks([{ finding: "Acute hemorrhage, no midline shift", severity: "critical" }], "<b>Findings</b><br>No acute intracranial abnormality.", "en-US");
    const c = cg01(checks);
    assert.ok(c, "CG01 must be emitted (label is gated)");
    assert.equal(c!.severity, "critical");
    assert.equal(c!.passed, false, c!.evidence);
  });

  it("pt-BR: omitting an affirmed compound critical fails CG01", () => {
    const checks = critChecks([{ finding: "Hematoma subdural agudo, sem desvio da linha media", severity: "critical" }], "<b>Achados</b><br>Sem alteracoes agudas.", "pt-BR");
    const c = cg01(checks);
    assert.ok(c);
    assert.equal(c!.passed, false, c!.evidence);
  });

  it("catches the negation-first ordering too", () => {
    const checks = critChecks([{ finding: "No midline shift, acute subdural hematoma", severity: "critical" }], "<b>Findings</b><br>No acute abnormality.", "en-US");
    assert.equal(cg01(checks)?.passed, false);
  });

  it("detection intact: a correctly reported compound critical passes CG01", () => {
    const checks = critChecks([{ finding: "Acute hemorrhage, no midline shift", severity: "critical" }], "<b>Findings</b><br>Acute hemorrhage in the right frontal lobe. No midline shift.", "en-US");
    assert.equal(cg01(checks)?.passed, true, JSON.stringify(checks));
  });
});

describe("evaluateCritical CG05: source-backing is polarity-aware (crit-extract-1)", () => {
  // The source NEGATED a critical as a pertinent negative ("No subarachnoid
  // hemorrhage"); the report FABRICATES it as present. Source-backing uses
  // lexical token coverage that strips negation tokens as stopwords, so the OLD
  // polarity-blind check treated the fabricated critical as source-backed and
  // suppressed it (scoring 100). It must NOT be suppressed: the fabricated
  // critical must incur the critical penalty.
  const META_HEAD = META;
  it("en-US: source 'No subarachnoid hemorrhage' + report 'subarachnoid hemorrhage present' is NOT source-backed", () => {
    const benchCase: BenchCase = {
      id: "cg05", exam: "ct head", locale: "en-US",
      findings: "No subarachnoid hemorrhage. No acute infarct.",
      goldFindings: [{ finding: "No subarachnoid hemorrhage", severity: "critical", negated: true }],
    };
    const html = "<center><b>CT HEAD</b></center><br><b>Findings</b><br>Subarachnoid hemorrhage present.<br><b>Impression</b><br>Subarachnoid hemorrhage.";
    const result = evaluateCritical(html, benchCase, "en-US", META_HEAD, []);
    const cg00 = result.checks.find((c) => c.id === "CG00");
    assert.ok(cg00, "CG00 must be emitted on the gold-critical-none path");
    assert.equal(cg00!.passed, false, JSON.stringify(result.details));
    assert.equal(cg00!.severity, "critical");
    assert.equal(result.score, 0, "fabricated critical the source only negated must score 0");
    assert.deepEqual((result.details as Record<string, unknown>).excludedSourceBackedFalsePositives, []);
  });

  it("pt-BR: source 'Sem hemorragia subaracnóidea' + report fabricating it is NOT source-backed", () => {
    const benchCase: BenchCase = {
      id: "cg05pt", exam: "tc cranio", locale: "pt-BR",
      findings: "Sem hemorragia subaracnoidea. Sem infarto agudo.",
      goldFindings: [{ finding: "Sem hemorragia subaracnoidea", severity: "critical", negated: true }],
    };
    const html = "<center><b>TC DE CRANIO</b></center><br><b>Achados</b><br>Hemorragia subaracnoidea presente.<br><b>Conclusao</b><br>Hemorragia subaracnoidea.";
    const result = evaluateCritical(html, benchCase, "pt-BR", META_HEAD, []);
    const cg00 = result.checks.find((c) => c.id === "CG00");
    assert.ok(cg00);
    assert.equal(cg00!.passed, false, JSON.stringify(result.details));
    assert.equal(result.score, 0);
  });

  it("control: when the source AFFIRMS the same critical, a matching report mention is still suppressed", () => {
    // Affirmed pertinent negative gold keeps the gold-critical-none path active,
    // but the source ALSO affirms the critical elsewhere, so the report mention
    // is genuinely source-backed and must be excluded (score 100, no false gate).
    const benchCase: BenchCase = {
      id: "ctrl", exam: "ct head", locale: "en-US",
      findings: "Acute subarachnoid hemorrhage in the basal cisterns. No midline shift.",
      goldFindings: [{ finding: "No midline shift", severity: "critical", negated: true }],
    };
    const html = "<center><b>CT HEAD</b></center><br><b>Findings</b><br>Subarachnoid hemorrhage present.<br><b>Impression</b><br>Subarachnoid hemorrhage.";
    const result = evaluateCritical(html, benchCase, "en-US", META_HEAD, []);
    const cg00 = result.checks.find((c) => c.id === "CG00");
    assert.ok(cg00);
    assert.equal(cg00!.passed, true, JSON.stringify(result.details));
    assert.equal(result.score, 100);
  });
});

describe("evaluateCritical: pure pertinent negatives are NOT gated (no over-gating)", () => {
  it("en-US negated critical with a recognized anchor is excluded", () => {
    assert.equal(cg01(critChecks([{ finding: "No acute hemorrhage", severity: "critical" }], "<b>Findings</b><br>Normal study.", "en-US")), undefined);
  });

  it("pt-BR negated critical with a recognized anchor is excluded", () => {
    assert.equal(cg01(critChecks([{ finding: "Sem hemorragia", severity: "critical" }], "<b>Achados</b><br>Estudo normal.", "pt-BR")), undefined);
  });

  it("negated critical (with or without a recognized anchor) is excluded (no opposite-direction regression)", () => {
    // After crit-extract-3 these emergencies ARE recognized critical anchors, so
    // the clause-anchor path applies: the lone anchor is negated, so the label is
    // still correctly dropped. (Before the fix they had no anchor and fell to the
    // whole-label fallback; either way a pure pertinent negative must not gate.)
    assert.equal(cg01(critChecks([{ finding: "No testicular torsion", severity: "critical" }], "<b>Findings</b><br>Normal.", "en-US")), undefined);
    assert.equal(cg01(critChecks([{ finding: "No acute appendicitis", severity: "critical" }], "<b>Findings</b><br>Normal.", "en-US")), undefined);
    assert.equal(cg01(critChecks([{ finding: "Sem torcao ovariana", severity: "critical" }], "<b>Achados</b><br>Normal.", "pt-BR")), undefined);
  });
});

// crit-extract-3: classic emergencies that ARE in CRITICAL_CATEGORIES were
// omitted from CRITICAL_KEYWORDS_PT/EN, so the critical-anchor logic could not
// recognize them as scored critical anchors. Each must now anchor in BOTH
// locales (additive, safe-direction: more criticals recognized).
describe("crit-extract-3: omitted emergencies are recognized critical anchors (both locales)", () => {
  // Representative new emergencies from the audit, one PT and one EN phrasing each.
  const EN_SAMPLES = [
    "cauda equina",
    "pneumoperitoneum",
    "testicular torsion",
    "ovarian torsion",
    "mesenteric ischemia",
    "necrotizing fasciitis",
    "acute appendicitis",
    "bowel obstruction",
    "spinal cord compression",
    "intussusception",
    "ectopic pregnancy",
    "contrast extravasation",
    "subarachnoid hemorrhage",
  ];
  const PT_SAMPLES = [
    "cauda equina",
    "pneumoperitônio",
    "torção testicular",
    "torção ovariana",
    "isquemia mesentérica",
    "fasciíte necrotizante",
    "apendicite aguda",
    "obstrução intestinal",
    "compressão medular",
    "intussuscepção",
    "gravidez ectópica",
    "extravasamento de contraste",
    "hemorragia subaracnóidea",
  ];

  for (const sample of EN_SAMPLES) {
    it(`EN anchor recognizes "${sample}"`, () => {
      assert.ok(CRITICAL_KEYWORDS_EN.test(sample), `CRITICAL_KEYWORDS_EN must match "${sample}"`);
    });
  }
  for (const sample of PT_SAMPLES) {
    it(`PT anchor recognizes "${sample}"`, () => {
      assert.ok(CRITICAL_KEYWORDS_PT.test(sample), `CRITICAL_KEYWORDS_PT must match "${sample}"`);
    });
  }

  // End-to-end proof the anchor is actually USED: a compound AFFIRMED critical
  // that appends an unrelated pertinent negative ("Cauda equina syndrome, no
  // fracture") only gates when the emergency itself is a recognized anchor.
  // Before the fix the only anchor in the label was "fracture" (negated), so the
  // label was dropped and omitting the affirmed emergency did NOT gate — the
  // exact unsafe failure. After the fix the emergency anchors and omitting it
  // fails CG01.
  it("EN: omitting an affirmed cauda equina (compound with a pertinent negative) fails CG01", () => {
    const checks = critChecks(
      [{ finding: "Cauda equina syndrome, no fracture", severity: "critical" }],
      "<b>Findings</b><br>No acute abnormality.",
      "en-US",
    );
    const c = cg01(checks);
    assert.ok(c, "CG01 must be emitted (emergency anchor recognized)");
    assert.equal(c!.passed, false, c!.evidence);
  });

  it("PT: omitting an affirmed pneumoperitônio (compound with a pertinent negative) fails CG01", () => {
    const checks = critChecks(
      [{ finding: "Pneumoperitônio, sem fratura", severity: "critical" }],
      "<b>Achados</b><br>Sem alteracoes agudas.",
      "pt-BR",
    );
    const c = cg01(checks);
    assert.ok(c, "CG01 must be emitted (emergency anchor recognized)");
    assert.equal(c!.passed, false, c!.evidence);
  });

  it("EN: omitting an affirmed testicular torsion (compound with a pertinent negative) fails CG01", () => {
    const checks = critChecks(
      [{ finding: "Testicular torsion, no fracture", severity: "critical" }],
      "<b>Findings</b><br>No acute abnormality.",
      "en-US",
    );
    assert.equal(cg01(checks)?.passed, false);
  });
});
