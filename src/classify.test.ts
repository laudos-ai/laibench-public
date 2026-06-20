import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveExamMeta } from "./classify.js";
import { runStructuralChecks } from "./evaluators/structural.js";

describe("deriveExamMeta modality detection", () => {
  it("classifies pt-BR radiografia as XR, not CT", () => {
    const meta = deriveExamMeta("Radiografia de torax, demonstracao sintetica, sem contraste.", "", "pt-BR");
    assert.equal(meta.modality, "XR");
    assert.equal(meta.region, "chest");
  });

  it("classifies raio-x variants as XR", () => {
    assert.equal(deriveExamMeta("Raio-X de torax", "", "pt-BR").modality, "XR");
    assert.equal(deriveExamMeta("Raios X de torax", "", "pt-BR").modality, "XR");
  });

  it("classifies pt-BR ultrassonografia as US, not CT", () => {
    const meta = deriveExamMeta("Ultrassonografia de abdomen superior, demonstracao sintetica.", "", "pt-BR");
    assert.equal(meta.modality, "US");
    assert.equal(meta.region, "abdomen");
  });

  it("classifies ultrassom and doppler as US", () => {
    assert.equal(deriveExamMeta("Ultrassom de abdome total", "", "pt-BR").modality, "US");
    assert.equal(deriveExamMeta("Doppler de carotidas", "", "pt-BR").modality, "US");
  });

  it("keeps en-US radiograph and ultrasound classification", () => {
    assert.equal(deriveExamMeta("Chest radiograph, synthetic demonstration.", "", "en-US").modality, "XR");
    assert.equal(deriveExamMeta("Upper abdominal ultrasound, synthetic demonstration.", "", "en-US").modality, "US");
  });

  it("still classifies tomografia as CT", () => {
    assert.equal(deriveExamMeta("Tomografia computadorizada de cranio, sem contraste.", "", "pt-BR").modality, "CT");
    assert.equal(deriveExamMeta("Angiotomografia computadorizada de cranio e pescoco.", "", "pt-BR").modality, "CT");
  });

  it("maps breast and thyroid regions in both locales", () => {
    assert.equal(deriveExamMeta("Mamografia diagnostica, demonstracao sintetica.", "", "pt-BR").region, "breast");
    assert.equal(deriveExamMeta("Diagnostic mammography, synthetic demonstration.", "", "en-US").region, "breast");
    assert.equal(deriveExamMeta("Ultrassonografia de tireoide.", "", "pt-BR").region, "thyroid");
    assert.equal(deriveExamMeta("Thyroid ultrasound.", "", "en-US").region, "thyroid");
  });
});

describe("report language contract (T-LANG)", () => {
  const ptReport =
    "<center><b>RADIOGRAFIA DE TÓRAX</b></center><br><br><b>Análise:</b><br>" +
    "Campos pulmonares sem opacidades focais. Ausência de derrame pleural ou pneumotórax. " +
    "Índice cardiotorácico dentro dos limites da normalidade. Seios costofrênicos livres. Demais estruturas de aspecto habitual." +
    "<br><br><b>Conclusão:</b><br>Exame radiográfico do tórax sem alterações significativas.";
  const enReport =
    "<center><b>CHEST RADIOGRAPH</b></center><br><br><b>Findings:</b><br>" +
    "The lungs are clear without focal opacities. There is no pleural effusion or pneumothorax. " +
    "The cardiomediastinal silhouette is within normal limits. The costophrenic angles are clear." +
    "<br><br><b>Impression:</b><br>No acute findings in the chest.";

  it("fails a Portuguese report on the en-US suite with explicit evidence", () => {
    const meta = deriveExamMeta("Chest radiograph, synthetic demonstration.", "", "en-US");
    const checks = runStructuralChecks(ptReport, meta, "No pleural effusion or pneumothorax.", "en-US");
    const lang = checks.find((c) => c.id === "T-LANG");
    assert.ok(lang, "T-LANG check must exist");
    assert.equal(lang!.passed, false);
    assert.match(String(lang!.evidence), /pt-BR/);
  });

  it("fails an English report on the pt-BR suite", () => {
    const meta = deriveExamMeta("Radiografia de torax, demonstracao sintetica.", "", "pt-BR");
    const checks = runStructuralChecks(enReport, meta, "Sem derrame pleural ou pneumotorax.", "pt-BR");
    const lang = checks.find((c) => c.id === "T-LANG");
    assert.equal(lang!.passed, false);
  });

  it("passes matched-language reports in both locales", () => {
    const ptMeta = deriveExamMeta("Radiografia de torax, demonstracao sintetica.", "", "pt-BR");
    const ptLang = runStructuralChecks(ptReport, ptMeta, "Sem derrame pleural.", "pt-BR").find((c) => c.id === "T-LANG");
    assert.equal(ptLang!.passed, true);

    const enMeta = deriveExamMeta("Chest radiograph, synthetic demonstration.", "", "en-US");
    const enLang = runStructuralChecks(enReport, enMeta, "No pleural effusion.", "en-US").find((c) => c.id === "T-LANG");
    assert.equal(enLang!.passed, true);
  });
});
