import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasNegationCue, isFindingNegated, extractCriticalMentions } from "./extract.js";
import { getDefaultCriticalExtractor } from "./extractors/critical-extractor.js";
import { deriveExamMeta } from "./classify.js";
import { runStructuralChecks } from "./evaluators/structural.js";

describe("clause-scoped negation (isFindingNegated)", () => {
  it("keeps a positive finding positive when a later clause is negated", () => {
    const s = "Grade III splenic laceration, without active contrast extravasation.";
    assert.equal(isFindingNegated(s, "splenic laceration", "en-US"), false);
    assert.equal(isFindingNegated(s, "active contrast extravasation", "en-US"), true);
  });

  it("handles pt-BR prefix negation per clause", () => {
    const s = "Pequena colecao subdural hiperatenue ao longo da foice. Sem desvio da linha media.";
    assert.equal(isFindingNegated("Pequena colecao subdural hiperatenue ao longo da foice", "colecao subdural", "pt-BR"), false);
    assert.equal(isFindingNegated("Sem desvio da linha media", "desvio da linha media", "pt-BR"), true);
  });
});

describe("isFindingNegated: bare-negation fallback when gold label is not a substring (negation-matching-1)", () => {
  // When the multi-token gold label is not a literal substring of the sentence,
  // isFindingNegated falls back to whole-sentence scoping. The OLD fallback used
  // isNegated(), whose locale patterns omit bare "no X"/"sem X", so a report that
  // DENIES a critical was wrongly treated as non-negated (critical credited).
  it("en-US: bare 'No pneumothorax.' is negated even when the gold label is multi-token", () => {
    assert.equal(isFindingNegated("No pneumothorax.", "tension pneumothorax", "en-US"), true);
    assert.equal(isFindingNegated("No subarachnoid hemorrhage", "acute hemorrhage", "en-US"), true);
  });

  it("pt-BR: bare 'Sem pneumotórax.' is negated even when the gold label is multi-token", () => {
    assert.equal(isFindingNegated("Sem pneumotórax.", "pneumotorax hipertensivo", "pt-BR"), true);
    assert.equal(isFindingNegated("Sem hemorragia subaracnoidea", "hemorragia aguda", "pt-BR"), true);
  });
});

describe("isFindingNegated: a leading negation does not bleed across conjunctions (crit-extract-2)", () => {
  // A leading negation must scope only to its own clause: an affirmed compound
  // critical after a contrast/conjunction marker stays AFFIRMED. The OLD clause
  // window used only ',' ';' ':' so "No effusion but acute hemorrhage present"
  // wrongly read the hemorrhage as negated.
  it("en-US: 'No effusion but acute hemorrhage present' leaves the hemorrhage affirmed", () => {
    assert.equal(isFindingNegated("No effusion but acute hemorrhage present", "acute hemorrhage", "en-US"), false);
  });
  it("en-US: 'with' (accompaniment) stops the negation scope", () => {
    assert.equal(isFindingNegated("No effusion with acute hemorrhage", "acute hemorrhage", "en-US"), false);
  });
  it("pt-BR: 'mas com' conjunction stops the negation scope", () => {
    assert.equal(isFindingNegated("Sem derrame mas com hematoma agudo", "hematoma", "pt-BR"), false);
  });
  it("does not over-relax: a genuine in-clause negation is still detected", () => {
    assert.equal(isFindingNegated("No pneumothorax", "pneumothorax", "en-US"), true);
    assert.equal(isFindingNegated("Sem desvio da linha media", "desvio da linha media", "pt-BR"), true);
  });
  it("coordinating 'or'/'and' do NOT close the scope (coordinated pertinent negatives stay negated)", () => {
    // "no hemorrhage or mass effect" denies BOTH; treating 'or' as a boundary
    // would fabricate a 'mass effect' critical. Same for 'and'.
    assert.equal(isFindingNegated("No hemorrhage or mass effect", "mass effect", "en-US"), true);
    assert.equal(isFindingNegated("Sem hemorragia ou efeito de massa", "efeito de massa", "pt-BR"), true);
    assert.equal(isFindingNegated("No hemorrhage and mass effect", "mass effect", "en-US"), true);
  });
});

describe("hasNegationCue", () => {
  it("detects pt-BR and en-US negation openers", () => {
    assert.equal(hasNegationCue("Sem desvio da linha media", "pt-BR"), true);
    assert.equal(hasNegationCue("No intracranial hemorrhage", "en-US"), true);
    assert.equal(hasNegationCue("Left lobe and isthmus without nodules", "en-US"), true);
  });
  it("does not flag positive statements", () => {
    assert.equal(hasNegationCue("Occlusion of the M1 segment of the left MCA", "en-US"), false);
  });

  it("does not treat uncertainty phrases as absent findings", () => {
    assert.equal(hasNegationCue("Não sendo possível afastar pequeno trombo associado", "pt-BR"), false);
    assert.equal(hasNegationCue("Nefrolitíase não obstrutiva à direita", "pt-BR"), false);
  });
});

describe("critical extractor: pertinent negatives are not false positives", () => {
  const ex = getDefaultCriticalExtractor();
  it("does not count 'no intracranial hemorrhage' as a hallucinated critical", () => {
    const html =
      "<center><b>CT ANGIOGRAPHY OF THE HEAD</b></center><br><b>Findings</b><br>" +
      "Occlusion of the M1 segment of the left middle cerebral artery. No intracranial hemorrhage." +
      "<br><b>Impression</b><br>Left M1 occlusion.";
    const r = ex.detect(["occlusion of the M1 segment of the left middle cerebral artery"], html, "en-US");
    assert.equal(r.falsePositives.length, 0);
    assert.equal(r.truePositives.length, 1);
  });

  it("pt-BR: 'Sem desvio da linha media' is not a false positive", () => {
    const html =
      "<center><b>TC DE CRANIO</b></center><br><b>Achados</b><br>" +
      "Pequena colecao subdural hiperatenue ao longo da foice cerebral. Sem desvio da linha media." +
      "<br><b>Conclusao</b><br>Colecao subdural.";
    const r = ex.detect(["colecao subdural hiperatenue ao longo da foice cerebral"], html, "pt-BR");
    assert.equal(r.falsePositives.length, 0);
  });
});

describe("R02 laterality: negated contralateral side is not a swap", () => {
  it("passes when the report documents the normal opposite lobe", () => {
    const meta = deriveExamMeta("Thyroid ultrasound, synthetic demonstration.", "Solid hypoechoic nodule in the right thyroid lobe.", "en-US");
    const html =
      "<center><b>THYROID ULTRASOUND</b></center><br><b>Findings</b><br>" +
      "Solid hypoechoic nodule in the right thyroid lobe, measuring 1.8 cm. " +
      "Left lobe and isthmus without nodules." +
      "<br><b>Impression</b><br>Right thyroid nodule, ACR TI-RADS 5.";
    const findings = "Solid hypoechoic nodule in the right thyroid lobe. Left lobe and isthmus without nodules.";
    const checks = runStructuralChecks(html, meta, findings, "en-US");
    const r02 = checks.find((c) => c.id === "R02");
    assert.ok(r02, "R02 must run when laterality present");
    assert.equal(r02!.passed, true, `R02 should pass, got: ${r02!.evidence}`);
  });

  it("still catches a real laterality swap on a positive finding", () => {
    const meta = deriveExamMeta("Chest CT", "Large right pleural effusion.", "en-US");
    const html =
      "<center><b>CHEST CT</b></center><br><b>Findings</b><br>" +
      "Large left pleural effusion." +
      "<br><b>Impression</b><br>Left pleural effusion.";
    const checks = runStructuralChecks(html, meta, "Large right pleural effusion.", "en-US");
    const r02 = checks.find((c) => c.id === "R02");
    assert.equal(r02!.passed, false);
    assert.match(String(r02!.evidence), /SWAP/);
  });
});

describe("extractCriticalMentions clause-scoped negation", () => {
  it("filters pt-BR bare pertinent negatives (Sem hemorragia / Sem fratura)", () => {
    const m = extractCriticalMentions("<b>Achados</b><br>Parenquima cerebral sem hemorragia ou efeito de massa. Sem hematoma.", "pt-BR");
    assert.equal(m.length, 0, JSON.stringify(m));
  });

  it("filters en-US bare pertinent negatives (without hemorrhage)", () => {
    const m = extractCriticalMentions("<b>Findings</b><br>Brain parenchyma without hemorrhage or mass effect.", "en-US");
    assert.equal(m.length, 0, JSON.stringify(m));
  });

  it("still detects an affirmed critical sharing a sentence with a negated one (pt-BR, no over-suppression)", () => {
    const m = extractCriticalMentions("<b>Achados</b><br>Sem desvio da linha media, mas com hematoma subdural agudo.", "pt-BR");
    assert.equal(m.some((x) => x.category === "acute-bleed"), true, JSON.stringify(m));
  });

  it("still detects an affirmed critical sharing a sentence with a negated one (en-US, no over-suppression)", () => {
    const m = extractCriticalMentions("<b>Findings</b><br>No midline shift, but with acute hemorrhage.", "en-US");
    assert.equal(m.some((x) => x.category === "acute-bleed"), true, JSON.stringify(m));
  });

  it("detects a plainly affirmed critical (detection not over-suppressed)", () => {
    const m = extractCriticalMentions("<b>Achados</b><br>Hematoma subdural agudo.", "pt-BR");
    assert.equal(m.some((x) => x.category === "acute-bleed"), true, JSON.stringify(m));
  });
});

describe("R02 pt-BR laterality swap (vowel-ending stems)", () => {
  it("catches a pt-BR swap masked by contralateral-normal documentation", () => {
    // Input: nodule on the RIGHT. Report: nodule moved to the LEFT, with the
    // right lobe documented as normal - so the presence check passes (both sides
    // appear) and only swap detection can catch the error. This was dead on
    // pt-BR because the swap regexes required a boundary after a consonant stem.
    const meta = deriveExamMeta("Ultrassonografia da tireoide", "Nodulo solido no lobo direito da tireoide.", "pt-BR");
    const html =
      "<center><b>ULTRASSONOGRAFIA DA TIREOIDE</b></center><br><b>Analise</b><br>" +
      "Nodulo solido no lobo esquerdo da tireoide, medindo 1,8 cm. Lobo direito sem nodulos." +
      "<br><b>Conclusao</b><br>Nodulo no lobo esquerdo da tireoide.";
    const checks = runStructuralChecks(html, meta, "Nodulo solido no lobo direito da tireoide.", "pt-BR");
    const r02 = checks.find((c) => c.id === "R02");
    assert.ok(r02, "R02 must run when laterality present");
    assert.equal(r02!.passed, false, `R02 should catch the swap, got: ${r02!.evidence}`);
    assert.match(String(r02!.evidence), /SWAP/);
  });

  it("does not invent a pt-BR swap when the correct side is reported with a contralateral normal", () => {
    const meta = deriveExamMeta("Ultrassonografia da tireoide", "Nodulo solido no lobo direito da tireoide.", "pt-BR");
    const html =
      "<center><b>ULTRASSONOGRAFIA DA TIREOIDE</b></center><br><b>Analise</b><br>" +
      "Nodulo solido no lobo direito da tireoide, medindo 1,8 cm. Lobo esquerdo sem nodulos." +
      "<br><b>Conclusao</b><br>Nodulo no lobo direito da tireoide.";
    const checks = runStructuralChecks(html, meta, "Nodulo solido no lobo direito da tireoide.", "pt-BR");
    const r02 = checks.find((c) => c.id === "R02");
    assert.ok(r02);
    assert.equal(r02!.passed, true, `R02 should pass, got: ${r02!.evidence}`);
  });

  it("catches a swap even when the finding sentence carries an unrelated negation", () => {
    // Swap (direita -> esquerda) in a sentence that also contains a pertinent
    // negative ("sem realce"). The old whole-sentence negation skip hid the
    // swap; clause-scoped negation on the finding noun catches it.
    const meta = deriveExamMeta("Ultrassonografia", "Nodulo solido na mama direita.", "pt-BR");
    const html =
      "<center><b>ULTRASSONOGRAFIA</b></center><br><b>Analise</b><br>" +
      "Nodulo solido na mama esquerda, sem realce significativo ao Doppler." +
      "<br><b>Conclusao</b><br>Nodulo na mama esquerda.";
    const checks = runStructuralChecks(html, meta, "Nodulo solido na mama direita.", "pt-BR");
    const r02 = checks.find((c) => c.id === "R02");
    assert.ok(r02);
    assert.equal(r02!.passed, false, `R02 should catch the swap, got: ${r02!.evidence}`);
    assert.match(String(r02!.evidence), /SWAP/);
  });
});
