import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { benchmarkCase } from "../benchmark.js";
import { evaluateSourceCriticals, sourceCriticalAnchors } from "./source-critical.js";
import type { BenchCase, CaseRunResult, Check, LocaleKey } from "../types.js";

// Contract-shaped report: <center><b>TITLE</b></center> + <b>Section</b><br> blocks.
function report(locale: LocaleKey, title: string, technique: string, findings: string, impression: string): string {
  const L = locale === "en-US"
    ? { t: "Technique", f: "Findings", i: "Impression" }
    : { t: "Técnica", f: "Análise", i: "Conclusão" };
  return `<center><b>${title}</b></center><br><br><b>${L.t}</b><br>${technique}<br><br><b>${L.f}</b><br>${findings}<br><br><b>${L.i}</b><br>${impression}`;
}

async function run(c: Omit<BenchCase, "id">, html: string): Promise<CaseRunResult> {
  return benchmarkCase({ case: { id: "t", ...c } as BenchCase, locale: c.locale as LocaleKey, providedHtml: html, providerLabel: "test", modelLabel: "test" });
}
const check = (r: CaseRunResult, id: string): Check | undefined => r.checks.find((c) => c.id === id);

const PTX_CASE = {
  exam: "Chest radiograph, PA and lateral, without contrast.",
  findings: "Large right pneumothorax with partial collapse of the right lung. No pleural effusion. Cardiomediastinal silhouette within normal limits.",
  locale: "en-US" as const,
};
const CHEST_NORMAL_BODY = "Cardiac silhouette, mediastinum and hila within normal limits. Costophrenic angles sharp. Soft tissues intact.";

describe("C09/C10 source-anchored critical gate (input-only path)", () => {
  it("a polished report that omits the stated pneumothorax FAILS (the prime directive)", async () => {
    const r = await run(PTX_CASE, report("en-US", "CHEST RADIOGRAPH, PA AND LATERAL",
      "Frontal and lateral projections of the chest were acquired.",
      `${CHEST_NORMAL_BODY} Lung parenchyma clear bilaterally.`,
      "No acute cardiopulmonary abnormality."));
    const c09 = check(r, "C09");
    assert.ok(c09, "C09 must be emitted when the input affirms a critical");
    assert.equal(c09!.passed, false);
    assert.match(c09!.evidence, /omitted: right pneumothorax/);
    assert.equal(r.verdict, "FAIL");
    assert.ok(r.combinedOverall <= 59.9);
  });

  it("a plain report that preserves it PASSES", async () => {
    const r = await run(PTX_CASE, report("en-US", "CHEST RADIOGRAPH", "PA and lateral views.",
      `Large right pneumothorax with partial collapse of the right lung. No pleural effusion. ${CHEST_NORMAL_BODY} Left lung parenchyma clear.`,
      "Large right pneumothorax."));
    assert.equal(check(r, "C09")!.passed, true, check(r, "C09")!.evidence);
    assert.equal(check(r, "C10")!.passed, true, check(r, "C10")!.evidence);
    assert.equal(r.verdict, "PASS");
  });

  it("a right→left swap FAILS in C09 (swap), C10 (contralateral) and R02 (swap)", async () => {
    const r = await run(PTX_CASE, report("en-US", "CHEST RADIOGRAPH", "PA and lateral views.",
      `Large left pneumothorax with partial collapse of the left lung. No pleural effusion. ${CHEST_NORMAL_BODY} Right lung parenchyma clear.`,
      "Large left pneumothorax."));
    assert.match(check(r, "C09")!.evidence, /laterality swap/);
    assert.equal(check(r, "C10")!.passed, false);
    assert.match(check(r, "R02")!.evidence, /SWAP/);
    assert.equal(r.verdict, "FAIL");
  });

  it("denying the stated critical ('No pneumothorax') FAILS as negated", async () => {
    const r = await run(PTX_CASE, report("en-US", "CHEST RADIOGRAPH", "PA and lateral views.",
      `No pneumothorax. No pleural effusion. ${CHEST_NORMAL_BODY} Right lung parenchyma clear.`,
      "Normal chest radiograph."));
    assert.match(check(r, "C09")!.evidence, /negated in report: right pneumothorax/);
    assert.equal(r.verdict, "FAIL");
  });

  it("omitting a side-required critical's side FAILS (laterality missing)", async () => {
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Displaced rib fracture.<br><br><b>Impression</b><br>Rib fracture.",
      "Displaced fracture of the right sixth rib.", "en-US");
    assert.equal(out.missed[0]?.status, "laterality-missing");
  });

  it("side is not demanded for non-lateral criticals (free air)", () => {
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Free intraperitoneal air beneath the diaphragm.<br><br><b>Impression</b><br>Pneumoperitoneum.",
      "Free intraperitoneal air under both hemidiaphragms.", "en-US");
    assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
    assert.equal(out.fabricated.length, 0);
  });

  it("free air is extracted as a critical (v3.10 anchored it as a keyword but never extracted it)", async () => {
    const r = await run(
      { exam: "Abdominal radiograph, upright, without contrast.", findings: "Free intraperitoneal air under both hemidiaphragms. Nonobstructive bowel gas pattern.", locale: "en-US" },
      report("en-US", "ABDOMINAL RADIOGRAPH, UPRIGHT", "Upright frontal radiograph of the abdomen.",
        "Nonobstructive bowel gas pattern. No abnormal calcifications. Visualized osseous structures intact.",
        "Nonobstructive bowel gas pattern."));
    assert.match(check(r, "C09")!.evidence, /omitted: free intraperitoneal air/);
    assert.equal(r.verdict, "FAIL");
  });

  it("a critical fabricated into a normal study FAILS C10", async () => {
    const r = await run(
      { exam: "Chest radiograph, PA, without contrast.", findings: "Lungs clear. No pleural effusion or pneumothorax. Cardiomediastinal silhouette within normal limits.", locale: "en-US" },
      report("en-US", "CHEST RADIOGRAPH", "PA view.",
        `Small right apical pneumothorax. ${CHEST_NORMAL_BODY} Lung parenchyma clear.`,
        "Small right apical pneumothorax."));
    assert.equal(check(r, "C09"), undefined, "no input critical → no C09");
    assert.equal(check(r, "C10")!.passed, false);
    assert.match(check(r, "C10")!.evidence, /critical not in input: right pneumothorax/);
    assert.equal(r.verdict, "FAIL");
  });

  it("recommendation / differential sentences are not counted as fabrication", () => {
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Lungs clear.<br><br><b>Impression</b><br>No acute abnormality. Recommend CT angiography to evaluate for pulmonary embolism if clinically indicated.",
      "Lungs clear. No pleural effusion.", "en-US");
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });

  it("same-category synonyms are accepted (hematoma ↔ hemorrhage)", () => {
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Acute left subdural hemorrhage along the convexity.<br><br><b>Impression</b><br>Acute left subdural hemorrhage.",
      "Acute subdural hematoma along the left cerebral convexity.", "en-US");
    assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
  });

  it("downgrading a tension pneumothorax to 'pneumothorax' FAILS (tension omitted)", () => {
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Large right pneumothorax.<br><br><b>Impression</b><br>Large right pneumothorax.",
      "Large right tension pneumothorax with mediastinal shift to the left.", "en-US");
    assert.ok(out.missed.some((o) => o.anchor.category === "tension-pneumothorax" && o.status === "omitted"), JSON.stringify(out.outcomes));
  });

  it("an entailed broader critical is not fabrication (midline shift ⇒ mass effect)", () => {
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Acute left subdural hematoma with mass effect and 6 mm midline shift to the right.<br><br><b>Impression</b><br>Acute left subdural hematoma with midline shift.",
      "Acute left subdural hematoma with 6 mm midline shift to the right.", "en-US");
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
    assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
  });

  it("a source sentence naming both sides never yields a false swap or fabrication", () => {
    const src = "Fracture of the right fifth rib and of the left clavicle.";
    const out = evaluateSourceCriticals(
      "<b>Findings</b><br>Right fifth rib fracture. Left clavicle fracture.<br><br><b>Impression</b><br>Right rib and left clavicle fractures.",
      src, "en-US");
    assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });

  it("repeated term: the affirmed mention after a negated one is still found", () => {
    const anchors = sourceCriticalAnchors("No pneumothorax on the left, small pneumothorax on the right.", "en-US");
    assert.equal(anchors.length, 1, JSON.stringify(anchors));
    assert.equal(anchors[0].side, "right");
  });

  it("pt-BR: swap and denial are caught", () => {
    const src = "Pneumotórax volumoso à direita. Sem derrame pleural.";
    const swap = evaluateSourceCriticals("<b>Análise</b><br>Pneumotórax volumoso à esquerda.<br><br><b>Conclusão</b><br>Pneumotórax à esquerda.", src, "pt-BR");
    assert.equal(swap.missed[0]?.status, "laterality-swap", JSON.stringify(swap.outcomes));
    const denied = evaluateSourceCriticals("<b>Análise</b><br>Sem pneumotórax. Sem derrame pleural.<br><br><b>Conclusão</b><br>Exame sem alterações.", src, "pt-BR");
    assert.equal(denied.missed[0]?.status, "negated", JSON.stringify(denied.outcomes));
    const ok = evaluateSourceCriticals("<b>Análise</b><br>Pneumotórax volumoso à direita.<br><br><b>Conclusão</b><br>Pneumotórax volumoso à direita.", src, "pt-BR");
    assert.equal(ok.missed.length, 0, JSON.stringify(ok.outcomes));
  });

  it("cases without any critical keep their v3.10 criterion set (no C09/C10 emitted)", async () => {
    const r = await run(
      { exam: "Chest radiograph, PA, without contrast.", findings: "Lungs clear. No pleural effusion or pneumothorax.", locale: "en-US" },
      report("en-US", "CHEST RADIOGRAPH", "PA view.", `${CHEST_NORMAL_BODY} Lung parenchyma clear. No pneumothorax.`, "Normal chest radiograph."));
    assert.equal(check(r, "C09"), undefined);
    assert.equal(check(r, "C10"), undefined);
  });
});

describe("gold path isolation: C09/C10 never reach a gold-labelled verdict", () => {
  it("with criticalFindings gold, the CRIT evaluator owns CRIT and C09/C10 are dropped", async () => {
    const r = await run(
      { ...PTX_CASE, criticalFindings: ["right pneumothorax"] },
      report("en-US", "CHEST RADIOGRAPH", "PA and lateral views.",
        `Large right pneumothorax with partial collapse of the right lung. No pleural effusion. ${CHEST_NORMAL_BODY} Left lung parenchyma clear.`,
        "Large right pneumothorax."));
    assert.equal(check(r, "C09"), undefined);
    assert.equal(check(r, "C10"), undefined);
    assert.ok(check(r, "CG01"), "gold CRIT evaluator ran");
  });
});

describe("list-negation consequences on the gold path (v3.11.0)", () => {
  it("pt-BR: 'Sem derrame pleural, consolidação ou pneumotórax' is not a fabricated critical", async () => {
    const r = await benchmarkCase({
      case: {
        id: "g1", locale: "pt-BR",
        exam: "Radiografia de tórax, PA, sem contraste.",
        // Source states the negatives separately; the report uses the common list.
        findings: "Campos pulmonares sem opacidades. Sem derrame pleural. Sem pneumotórax.",
        goldFindings: [{ finding: "Campos pulmonares sem opacidades", severity: "incidental" }],
      } as BenchCase,
      locale: "pt-BR",
      providedHtml: report("pt-BR", "RADIOGRAFIA DE TÓRAX", "Incidência PA.", "Campos pulmonares sem opacidades. Sem derrame pleural, consolidação ou pneumotórax.", "Exame dentro da normalidade."),
      providerLabel: "test", modelLabel: "test",
    });
    const cg00 = r.checks.find((c) => c.id === "CG00");
    assert.ok(!cg00 || cg00.passed, cg00?.evidence);
  });

  it("en-US: a report that denies the gold critical inside a list is NOT credited with it", async () => {
    const r = await benchmarkCase({
      case: { id: "g2", ...PTX_CASE, criticalFindings: ["pneumothorax"] } as BenchCase,
      locale: "en-US",
      providedHtml: report("en-US", "CHEST RADIOGRAPH", "PA and lateral views.", `No effusion, consolidation, or pneumothorax. ${CHEST_NORMAL_BODY}`, "Normal chest radiograph."),
      providerLabel: "test", modelLabel: "test",
    });
    const cg01 = r.checks.find((c) => c.id === "CG01");
    assert.ok(cg01);
    assert.equal(cg01!.passed, false, cg01!.evidence);
    assert.equal(r.verdict, "FAIL");
  });
});

describe("Q16/Q17 abnormal-finding preservation and unsupported normalcy (input-only path)", () => {
  const KNEE = {
    exam: "Magnetic resonance imaging of the left knee, without contrast.",
    findings: "Left knee. Complete tear of the anterior cruciate ligament, with fibers not visualized in their expected location. Bucket-handle tear of the medial meniscus, with a fragment displaced into the intercondylar notch. Moderate joint effusion.",
    locale: "en-US" as const,
  };
  const KNEE_TITLE = "MAGNETIC RESONANCE IMAGING OF THE LEFT KNEE";

  it("a 'No acute abnormality' report on an abnormal study FAILS (Q17 unsupported normalcy)", async () => {
    const r = await run(KNEE, report("en-US", KNEE_TITLE, "Standard protocol.", "No acute abnormality. Ligaments and menisci intact.", "No acute abnormality."));
    const q17 = check(r, "Q17");
    assert.ok(q17);
    assert.equal(q17!.passed, false, q17!.evidence);
    assert.equal(r.verdict, "FAIL");
  });

  it("omitting ONE non-critical finding costs a major (Q16-1), not a veto", async () => {
    const r = await run(KNEE, report("en-US", KNEE_TITLE, "Standard protocol.",
      "Complete tear of the anterior cruciate ligament, with fibers not visualized in their expected location. Moderate joint effusion.",
      "Complete anterior cruciate ligament tear."));
    const q16 = r.checks.filter((c) => c.id.startsWith("Q16"));
    assert.equal(q16.filter((c) => !c.passed).length, 1, JSON.stringify(q16));
    assert.match(q16[0].evidence, /Bucket-handle tear/);
    assert.equal(check(r, "Q17")!.passed, true);
    assert.notEqual(r.verdict, "FAIL");
  });

  it("a concise diagnosis-level paraphrase is accepted (consistent with X → X)", async () => {
    const r = await run(
      { exam: "Abdominal ultrasound.", findings: "Diffusely increased hepatic echogenicity with posterior beam attenuation, consistent with moderate hepatic steatosis. No focal lesion.", locale: "en-US" },
      report("en-US", "ABDOMINAL ULTRASOUND", "", "Moderate hepatic steatosis. No focal liver mass. Gallbladder, bile ducts, pancreas, spleen, kidney and aorta unremarkable.", "Moderate hepatic steatosis.").replace("<br><br><b>Technique</b><br>", ""));
    const q16 = r.checks.filter((c) => c.id.startsWith("Q16"));
    assert.ok(q16.length > 0 && q16.every((c) => c.passed), JSON.stringify(q16));
  });

  it("denying an input finding does not count as reflecting it", async () => {
    const r = await run(KNEE, report("en-US", KNEE_TITLE, "Standard protocol.",
      "No tear of the anterior cruciate ligament. No bucket-handle tear of the medial meniscus. No joint effusion.",
      "No internal derangement."));
    assert.equal(check(r, "Q17")!.passed, false, check(r, "Q17")!.evidence);
  });

  it("harness / context sentences are not findings", () => {
    // "Synthetic text for ... testing" and "High-risk patient context" lines.
    const r = evaluateSourceCriticals("<b>Findings</b><br>x", "Synthetic text for harness testing. High-risk patient context.", "en-US");
    assert.equal(r.anchors.length, 0);
  });
});

describe("C09: the title and Technique restate the exam and must not credit a critical", () => {
  it("'CT angiography for pulmonary embolism' in the title does not preserve an omitted PE", async () => {
    const r = await run(
      { exam: "Computed tomography angiography of the chest for pulmonary embolism, with contrast.", findings: "Filling defect in a segmental pulmonary artery branch of the right lower lobe, consistent with segmental pulmonary embolism.", locale: "en-US" },
      report("en-US", "COMPUTED TOMOGRAPHY ANGIOGRAPHY OF THE CHEST FOR PULMONARY EMBOLISM",
        "Computed tomography angiography of the chest for pulmonary embolism, acquired per standard protocol.",
        "Pulmonary arteries opacified to the subsegmental level without filling defect. Lungs clear. No pleural effusion. Heart normal in size.",
        "No acute cardiopulmonary abnormality."));
    assert.equal(check(r, "C09")!.passed, false, check(r, "C09")!.evidence);
    assert.equal(r.verdict, "FAIL");
  });
});
