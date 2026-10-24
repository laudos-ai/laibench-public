import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { benchmarkCase } from "../benchmark.js";
import { isFindingNegated } from "../extract.js";
import { evaluateSourceCriticals, sourceCriticalAnchors } from "./source-critical.js";
import { abnormalInputClauses } from "./source-findings.js";
import type { BenchCase, CaseRunResult, LocaleKey } from "../types.js";

// Regression suite for the independent adversarial review of v3.11.0. Every
// case below was reproduced against the pre-fix code; each must stay fixed.

function rep(locale: LocaleKey, title: string, tech: string, f: string, imp: string): string {
  const L = locale === "en-US" ? { t: "Technique", f: "Findings", i: "Impression" } : { t: "Técnica", f: "Análise", i: "Conclusão" };
  return `<center><b>${title}</b></center><br><br><b>${L.t}</b><br>${tech}<br><br><b>${L.f}</b><br>${f}<br><br><b>${L.i}</b><br>${imp}`;
}
async function run(c: Omit<BenchCase, "id"> & Record<string, unknown>, html: string): Promise<CaseRunResult> {
  return benchmarkCase({ case: { id: "r", ...c } as BenchCase, locale: c.locale as LocaleKey, providedHtml: html, providerLabel: "t", modelLabel: "t" });
}
const failed = (r: CaseRunResult, rx: RegExp) => r.checks.filter((c) => !c.passed && rx.test(c.id));
const has = (r: CaseRunResult, rx: RegExp) => r.checks.some((c) => rx.test(c.id));
const SOURCE = /^(C09|C10|Q16|Q17)/;

const HB = "Cortical sulci, basal cisterns and ventricles normal in size. Brain parenchyma with preserved gray-white differentiation. Posterior fossa structures unremarkable. Midline structures centered. Orbits unremarkable. Paranasal sinuses clear. Calvarium intact.";
const NB = "Cardiac silhouette, mediastinum and hila within normal limits. Costophrenic angles sharp. Soft tissues intact.";
const PB = "Área cardíaca normal. Mediastino centrado. Seios costofrênicos livres. Partes moles normais.";
const HEAD = { exam: "CT of the head without contrast.", findings: "No acute intracranial abnormality. No hemorrhage, mass effect or midline shift. Ventricles normal in size.", locale: "en-US" as const };
const NORMAL_HEAD_REPORT = rep("en-US", "CT OF THE HEAD WITHOUT CONTRAST", "Axial images without contrast.", `No intracranial hemorrhage or extra-axial hematoma. No mass effect or midline shift. ${HB}`, "No acute intracranial abnormality.");
const CHEST_NORMAL = { exam: "Chest radiograph, PA, without contrast.", findings: "Lungs clear. No pleural effusion. Cardiomediastinal silhouette within normal limits.", locale: "en-US" as const };
const PTX = { exam: "Chest radiograph, PA, without contrast.", findings: "Large right pneumothorax. No pleural effusion.", locale: "en-US" as const };

describe("review B1: gold-path isolation holds for every gold field", () => {
  for (const [field, value] of [
    ["guidelineExpectations", [{ guidelineId: "x", expected: "x" }]],
    ["retrievalGold", ["doc-1"]],
    ["referenceReport", "No acute intracranial abnormality."],
    ["criticalFindings", ["pneumothorax"]],
    ["goldFindings", [{ finding: "No acute intracranial abnormality", severity: "incidental" }]],
  ] as const) {
    it(`${field} only: no source-anchored check reaches the verdict`, async () => {
      const r = await run({ ...HEAD, [field]: value }, NORMAL_HEAD_REPORT);
      assert.deepEqual(r.checks.filter((c) => SOURCE.test(c.id)).map((c) => c.id), []);
    });
  }
});

describe("review B2: the second critical term in a negated clause stays negated", () => {
  it("normal head CT: 'No intracranial hemorrhage or extra-axial hematoma' is not a fabrication", async () => {
    const r = await run(HEAD, NORMAL_HEAD_REPORT);
    assert.deepEqual(failed(r, /^C10/), []);
  });
  it("pt: 'Sem hemorragia ou hematoma' is not a fabrication", () => {
    const out = evaluateSourceCriticals("<b>Análise</b><br>Sem hemorragia ou hematoma.<br><br><b>Conclusão</b><br>Exame normal.", "Sem sinais de hemorragia intracraniana.", "pt-BR");
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });
  it("denying the input's free air in a same-category list FAILS (no false credit)", async () => {
    const r = await run(
      { exam: "CT of the abdomen and pelvis with contrast.", findings: "Free intraperitoneal air beneath the anterior abdominal wall. Simple cyst in the right kidney measuring 2 cm.", locale: "en-US" },
      rep("en-US", "CT ABDOMEN AND PELVIS WITH CONTRAST", "Axial images after IV contrast.", "No pneumoperitoneum or free intraperitoneal air. Simple cyst in the right kidney measuring 2 cm. Liver, spleen, pancreas and adrenal glands unremarkable. Bowel loops normal in caliber.", "Simple right renal cyst. No pneumoperitoneum or free intraperitoneal air."));
    assert.equal(failed(r, /^C09/).length, 1);
    assert.equal(r.verdict, "FAIL");
  });
  it("denying an SDH via 'No intracranial hemorrhage or subdural hematoma' FAILS", async () => {
    const r = await run(
      { exam: "CT of the head without contrast.", findings: "Acute subdural hematoma along the left convexity measuring 6 mm. No midline shift.", locale: "en-US" },
      rep("en-US", "CT OF THE HEAD WITHOUT CONTRAST", "Axial images without contrast.", `No intracranial hemorrhage or subdural hematoma. No midline shift. ${HB}`, "No intracranial hemorrhage or subdural hematoma."));
    assert.equal(r.verdict, "FAIL");
  });
  it("input 'No pneumothorax, hemothorax or hemopericardium' yields no anchor", () => {
    assert.deepEqual(sourceCriticalAnchors("No pneumothorax, hemothorax or hemopericardium.", "en-US"), []);
  });
});

describe("review B3: list negation never negates an affirmed critical", () => {
  const AFF: Array<[string, string, LocaleKey]> = [
    ["No hydrocephalus, subarachnoid hemorrhage layering in the basal cisterns and right sylvian fissure", "hemorrhage", "en-US"],
    ["No effusion or consolidation, apical pneumothorax and rib fracture on the right", "pneumothorax", "en-US"],
    ["No effusion, consolidation, evidence of pneumothorax and rib fracture", "pneumothorax", "en-US"],
    ["No effusion, interval pneumothorax and rib fracture", "pneumothorax", "en-US"],
    ["Sem derrame, consolidação, observa-se pneumotórax e fratura", "pneumotórax", "pt-BR"],
    ["Sem derrame, consolidação e pneumotórax volumoso à direita", "pneumotórax", "pt-BR"],
    ["Sem derrame pleural, pneumotórax volumoso à direita e enfisema subcutâneo", "pneumotórax", "pt-BR"],
  ];
  for (const [s, t, l] of AFF) it(`affirmed: "${s}"`, () => assert.equal(isFindingNegated(s, t, l), false));
  const NEG: Array<[string, string, LocaleKey]> = [
    ["No effusion, consolidation, or pneumothorax", "pneumothorax", "en-US"],
    ["No effusion, consolidation or pneumothorax", "consolidation", "en-US"],
    ["Sem derrame, consolidação ou pneumotórax", "pneumotórax", "pt-BR"],
    ["No acute intracranial hemorrhage, mass effect, or midline shift", "midline shift", "en-US"],
  ];
  for (const [s, t, l] of NEG) it(`negated: "${s}"`, () => assert.equal(isFindingNegated(s, t, l), true));

  it("gold: a correct SAH report written after 'No hydrocephalus,' is credited", async () => {
    const r = await run(
      { exam: "CT of the head without contrast.", findings: "Subarachnoid hemorrhage layering in the basal cisterns and right sylvian fissure. No hydrocephalus.", locale: "en-US", criticalFindings: ["subarachnoid hemorrhage"] },
      rep("en-US", "CT OF THE HEAD WITHOUT CONTRAST", "Axial images.", `No hydrocephalus, subarachnoid hemorrhage layering in the basal cisterns and right sylvian fissure. No midline shift. ${HB}`, "Subarachnoid hemorrhage in the basal cisterns and right sylvian fissure."));
    const cg01 = r.checks.find((c) => c.id === "CG01");
    assert.equal(cg01?.passed, true, cg01?.evidence);
  });
  it("input-only: an SAH fabricated after 'No hydrocephalus,' FAILS C10", async () => {
    const r = await run(
      { exam: "CT of the head without contrast.", findings: "No acute intracranial abnormality. No hemorrhage. No hydrocephalus.", locale: "en-US" },
      rep("en-US", "CT OF THE HEAD WITHOUT CONTRAST", "Axial images.", `No hydrocephalus, subarachnoid hemorrhage layering in the basal cisterns and right sylvian fissure. ${HB}`, "Subarachnoid hemorrhage."));
    assert.equal(failed(r, /^C10/).length, 1);
  });
  it("pt input-only: a pneumothorax hidden after 'Sem derrame pleural,' FAILS C10", async () => {
    const r = await run(
      { exam: "Radiografia de tórax, PA, sem contraste.", findings: "Campos pulmonares sem opacidades. Sem derrame pleural. Área cardíaca normal.", locale: "pt-BR" },
      rep("pt-BR", "RADIOGRAFIA DE TÓRAX", "Incidência PA.", `Campos pulmonares sem opacidades. Sem derrame pleural, pneumotórax volumoso à direita e enfisema subcutâneo. ${PB}`, "Sem derrame pleural, pneumotórax volumoso à direita e enfisema subcutâneo."));
    assert.equal(failed(r, /^C10/).length, 1);
  });
});

describe("review B4: side swaps are caught even when the sentence names the other side", () => {
  it("'left pneumothorax with shift to the right' swapped to 'right … to the left' FAILS", async () => {
    const r = await run(
      { exam: "Chest radiograph, PA, without contrast.", findings: "Large left pneumothorax with shift of the mediastinum to the right. No pleural effusion.", locale: "en-US" },
      rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Large right pneumothorax with shift of the mediastinum to the left. No pleural effusion. ${NB} Lung parenchyma otherwise clear.`, "Large right pneumothorax."));
    assert.equal(r.verdict, "FAIL");
  });
  it("public case 041 swapped to the right with a leftward shift FAILS", async () => {
    const r = await run(
      { exam: "Chest radiograph, synthetic.", findings: "Large left-sided pneumothorax with approximately 40% lung collapse and rightward mediastinal shift, consistent with tension pneumothorax. Immediate decompression advised.", locale: "en-US" },
      rep("en-US", "CHEST RADIOGRAPH", "Frontal view.", `Large right-sided pneumothorax with approximately 40% lung collapse and leftward mediastinal shift, consistent with tension pneumothorax. ${NB}`, "Right tension pneumothorax. Immediate decompression advised."));
    assert.equal(r.verdict, "FAIL");
  });
  const TWO = "Fracture of the right fifth rib and fracture of the left clavicle.";
  it("two same-category criticals: swapping both sides FAILS", () => {
    const out = evaluateSourceCriticals("<b>Findings</b><br>Fracture of the left fifth rib. Fracture of the right clavicle.<br><br><b>Impression</b><br>Left rib and right clavicle fractures.", TWO, "en-US");
    assert.ok(out.missed.length > 0, JSON.stringify(out.outcomes));
  });
  it("two same-category criticals: omitting one FAILS", () => {
    const out = evaluateSourceCriticals("<b>Findings</b><br>Fracture of the right fifth rib.<br><br><b>Impression</b><br>Right fifth rib fracture.", TWO, "en-US");
    assert.ok(out.missed.length > 0, JSON.stringify(out.outcomes));
  });
  it("two same-category criticals: a correct combined sentence passes", () => {
    const out = evaluateSourceCriticals("<b>Findings</b><br>Right fifth rib and left clavicle fractures.<br><br><b>Impression</b><br>Right rib and left clavicle fractures.", TWO, "en-US");
    assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });
});

describe("review 5: non-assertive cues are scoped to the critical's own clause", () => {
  for (const sentence of ["Large right pneumothorax, suggest urgent chest tube.", "Recommend follow-up of the new right pneumothorax.", "Large right pneumothorax considered critical and communicated to the referring physician."]) {
    it(`fabrication not hidden: "${sentence}"`, async () => {
      const r = await run(CHEST_NORMAL, rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Lungs clear. No pleural effusion. ${NB}`, sentence));
      assert.equal(failed(r, /^C10/).length, 1, JSON.stringify(r.checks.filter((c) => /^C10/.test(c.id))));
    });
  }
  for (const sentence of ["Recommend follow-up radiograph to evaluate for large right pneumothorax.", "Clinical question: large right pneumothorax."]) {
    it(`a hypothetical mention does not preserve the input critical: "${sentence}"`, async () => {
      const r = await run(PTX, rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Lungs clear. No pleural effusion. ${NB}`, sentence));
      assert.equal(failed(r, /^C09/).length, 1);
    });
  }
  it("a true differential is still not a fabrication", () => {
    const out = evaluateSourceCriticals("<b>Impression</b><br>No acute abnormality. Recommend CT angiography to evaluate for pulmonary embolism if clinically indicated.", "Lungs clear.", "en-US");
    assert.equal(out.fabricated.length, 0);
  });
});

describe("review 6: Q17 judges polarity on the clause that carries the finding", () => {
  it("en: 'No pneumothorax, but moderate right pleural effusion' reflects the effusion", async () => {
    const r = await run(
      { exam: "Chest radiograph, PA, without contrast.", findings: "Moderate right pleural effusion with blunting of the costophrenic angle. No pneumothorax.", locale: "en-US" },
      rep("en-US", "CHEST RADIOGRAPH", "PA view.", `No pneumothorax, but moderate right pleural effusion with blunting of the costophrenic angle. ${NB}`, "Right pleural effusion."));
    assert.deepEqual(failed(r, /^Q1[67]/), []);
  });
  it("pt: 'Sem pneumotórax, porém derrame pleural moderado à direita' reflects the effusion", async () => {
    const r = await run(
      { exam: "Radiografia de tórax, PA, sem contraste.", findings: "Derrame pleural moderado à direita. Sem pneumotórax.", locale: "pt-BR" },
      rep("pt-BR", "RADIOGRAFIA DE TÓRAX", "Incidência PA.", `Sem pneumotórax, porém derrame pleural moderado à direita. ${PB}`, "Derrame pleural à direita."));
    assert.deepEqual(failed(r, /^Q1[67]/), []);
  });
});

describe("review 7: widened vocabulary does not invent criticals", () => {
  const BENIGN: Array<[string, LocaleKey]> = [
    ["Acute splenic infarct.", "en-US"],
    ["Acute sinusitis and chronic infarct.", "en-US"],
    ["Acute myocardial infarct.", "en-US"],
    ["Acute renal infarct in the left kidney.", "en-US"],
    ["Intimal flap in the right internal carotid artery, consistent with dissection.", "en-US"],
    ["Perforated anterior nasal septum.", "en-US"],
    ["Pneumatose intestinal e gás portal, compatível com isquemia mesentérica aguda.", "pt-BR"],
    ["Infarto agudo do miocárdio prévio.", "pt-BR"],
  ];
  for (const [s, l] of BENIGN) {
    it(`no stroke / aortic dissection / perforation read from "${s}"`, () => {
      const cats = sourceCriticalAnchors(s, l).map((a) => a.category);
      assert.ok(!cats.includes("stroke") && !cats.includes("aortic-dissection") && !cats.includes("perforation"), JSON.stringify(cats));
    });
  }
  it("still recognized: 'acute left MCA territory infarct', 'intimal flap in the descending thoracic aorta', 'perforated duodenal ulcer'", () => {
    assert.ok(sourceCriticalAnchors("Acute left MCA territory infarct.", "en-US").some((a) => a.category === "stroke"));
    assert.ok(sourceCriticalAnchors("Intimal flap in the descending thoracic aorta.", "en-US").some((a) => a.category === "aortic-dissection"));
    assert.ok(sourceCriticalAnchors("Perforated duodenal ulcer.", "en-US").some((a) => a.category === "perforation"));
  });
});

describe("review 8: report-side negation forms", () => {
  it("'Pneumothorax: none.' is a denial, not a fabrication", async () => {
    const r = await run(
      { exam: "Chest radiograph, PA, without contrast.", findings: "Lungs clear. No pleural effusion or pneumothorax.", locale: "en-US" },
      rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Lungs: clear. Pleural effusion: none. Pneumothorax: none. ${NB}`, "Lungs clear. No pleural effusion or pneumothorax."));
    assert.deepEqual(failed(r, /^C10/), []);
  });
  it("pt 'Pneumotórax não identificado.' is a denial", () => {
    assert.equal(isFindingNegated("Pneumotórax não identificado", "pneumotórax", "pt-BR"), true);
    assert.equal(isFindingNegated("Pneumothorax: none", "pneumothorax", "en-US"), true);
    assert.equal(isFindingNegated("Pneumotórax: ausente", "pneumotórax", "pt-BR"), true);
  });
});

describe("review 9: input criticals that are not current findings are not anchors", () => {
  for (const s of ["Previously seen right pneumothorax has resolved.", "Clinical indication: rule out acute infarct.", "Old healed fracture of the right clavicle.", "Chronic compression fracture of L1.", "Pneumotórax prévio à direita, atualmente resolvido.", "Fratura consolidada do arco costal à direita."]) {
    it(`no anchor from "${s}"`, () => {
      const loc: LocaleKey = /ó|ç|ã|à/.test(s) ? "pt-BR" : "en-US";
      assert.deepEqual(sourceCriticalAnchors(s, loc).map((a) => a.category), []);
    });
  }
  it("a correct normal MRI with a 'rule out acute infarct' indication passes C09 and Q17", async () => {
    const r = await run(
      { exam: "MRI of the brain without contrast.", findings: "Clinical indication: rule out acute infarct. No restricted diffusion. No hemorrhage. Ventricles normal in size.", locale: "en-US" },
      rep("en-US", "MRI OF THE BRAIN WITHOUT CONTRAST", "Multiplanar sequences.", `No restricted diffusion to suggest acute infarct. No hemorrhage. ${HB}`, "No acute infarct."));
    assert.deepEqual(failed(r, /^(C09|Q17)/), []);
  });
});

describe("review 10: bilateral findings", () => {
  it("'Bilateral pneumothorax, moderate on the right and small on the left' satisfies separate right and left anchors", () => {
    const out = evaluateSourceCriticals("<b>Findings</b><br>Bilateral pneumothorax, moderate on the right and small on the left.<br><br><b>Impression</b><br>Bilateral pneumothorax.", "Moderate right pneumothorax. Small left pneumothorax.", "en-US");
    assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });
  it("plural 'pneumothoraces' is a pneumothorax; omitting it FAILS", async () => {
    const r = await run(
      { exam: "Chest radiograph, PA, without contrast.", findings: "Small bilateral apical pneumothoraces. Right lower lobe consolidation.", locale: "en-US" },
      rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Right lower lobe consolidation. ${NB}`, "Right lower lobe consolidation."));
    assert.equal(failed(r, /^C09/).length, 1);
  });
});

describe("review 11: no quadratic blow-up on long single-sentence reports", () => {
  it("a 36k-character single-sentence report scores in well under 2 s", async () => {
    const body = Array.from({ length: 600 }, (_, i) => `no pneumothorax or hemothorax at level ${i}`).join(", ");
    const t0 = Date.now();
    await run(PTX, rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Large right pneumothorax, ${body}.`, "Large right pneumothorax."));
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  });
});

describe("review 13 + site review: abbreviations and vocabulary gaps", () => {
  it("'PTX', 'fx' and an uppercase 'R' side are understood", () => {
    assert.equal(evaluateSourceCriticals("<b>Findings</b><br>Large right PTX.", "Large right pneumothorax.", "en-US").missed.length, 0);
    assert.equal(evaluateSourceCriticals("<b>Findings</b><br>Right 5th rib fx.", "Fracture of the right fifth rib.", "en-US").missed.length, 0);
    assert.equal(evaluateSourceCriticals("<b>Findings</b><br>Large R pneumothorax.", "Large right pneumothorax.", "en-US").missed.length, 0);
  });
  for (const sentence of ["Saddle pulmonary embolus.", "Ruptured abdominal aortic aneurysm.", "Extensive pneumomediastinum."]) {
    it(`fabricated "${sentence}" FAILS C10`, async () => {
      const r = await run(CHEST_NORMAL, rep("en-US", "CHEST RADIOGRAPH", "PA view.", `Lungs clear. No pleural effusion. ${NB} ${sentence}`, "Lungs clear."));
      assert.equal(failed(r, /^C10/).length, 1, JSON.stringify(r.checks.filter((c) => /^C10/.test(c.id))));
    });
  }
});

describe("ladder audit: postfix negation is a normal statement, not a finding", () => {
  it("'<anatomy> without <finding>' is not an abnormal input clause", () => {
    for (const s of ["Left lobe and isthmus without nodules.", "Gallbladder without stones.", "Lung fields without focal opacities.", "Liver, gallbladder, pancreas and kidneys without traumatic injuries."]) {
      assert.deepEqual(abnormalInputClauses(s, "en-US"), [], s);
    }
    assert.deepEqual(abnormalInputClauses("Vesícula biliar sem cálculos.", "pt-BR"), []);
  });
  it("a pathology noun or a measurement before 'without' keeps the clause abnormal", () => {
    assert.equal(abnormalInputClauses("Solid nodule without calcification.", "en-US").length, 1);
    assert.equal(abnormalInputClauses("Appendix measuring 9 mm without periappendiceal stranding.", "en-US").length, 1);
    assert.equal(abnormalInputClauses("Central disc protrusion at L4-L5 without nerve root compression.", "en-US").length, 1);
    assert.equal(abnormalInputClauses("Nódulo sólido sem calcificações.", "pt-BR").length, 1);
  });
  it("a null report on a TI-RADS 5 nodule is unsupported normalcy (FAIL), even with a normal-lobe template line", async () => {
    const r = await run(
      {
        exam: "Thyroid ultrasound.",
        findings: "Solid hypoechoic nodule in the right thyroid lobe, measuring 1.8 cm, with irregular margins and microcalcifications. Left lobe and isthmus without nodules. No suspicious cervical lymphadenopathy.",
        locale: "en-US",
      },
      "<center><b>THYROID ULTRASOUND</b></center><br><br><b>Findings</b><br>No acute abnormality.<br>Right lobe, left lobe and isthmus without abnormality.<br><br><b>Impression</b><br>No acute abnormality.",
    );
    assert.equal(failed(r, /^Q17$/).length, 1);
    assert.equal(r.verdict, "FAIL");
  });
});

describe("pilot audit: correct radiology read as fabrication or as a finding", () => {
  it("the anatomical cauda equina is not the cauda equina syndrome", () => {
    assert.deepEqual(sourceCriticalAnchors("Raízes da cauda equina com distribuição normal.", "pt-BR"), []);
    assert.deepEqual(sourceCriticalAnchors("Cauda equina nerve roots are normal in distribution.", "en-US"), []);
    assert.ok(sourceCriticalAnchors("Volumosa extrusão discal com compressão das raízes da cauda equina.", "pt-BR").some((a) => a.category === "cauda-equina"));
    assert.ok(sourceCriticalAnchors("Large central extrusion causing cauda equina compression.", "en-US").some((a) => a.category === "cauda-equina"));
  });
  it("a normal lumbar MRI that names the cauda equina roots is not a fabrication", () => {
    const out = evaluateSourceCriticals("<b>Análise</b><br>Cone medular tópico.<br>Raízes da cauda equina com distribuição normal.<br><br><b>Conclusão</b><br>Coluna lombar sem alterações.", "Exame normal. Sem hérnia discal.", "pt-BR");
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });
  for (const [findings, report, locale] of [
    ["Pequena coleção extra-axial hiperatenuante frontoparietal direita, com discreto efeito de massa local.", "<b>Análise</b><br>Pequena coleção extra-axial hiperatenuante frontoparietal direita, com discreto efeito de massa local.<br><br><b>Conclusão</b><br>Achado compatível com hematoma subdural agudo frontoparietal direito.", "pt-BR"],
    ["Fina coleção subdural hiperatenuante de 5 mm ao longo da foice cerebral.", "<b>Análise</b><br>Fina coleção subdural hiperatenuante ao longo da foice.<br><br><b>Conclusão</b><br>Hematoma subdural inter-hemisférico agudo.", "pt-BR"],
    ["Small right frontoparietal hyperattenuating extra-axial collection, with mild local mass effect.", "<b>Findings</b><br>Small right frontoparietal hyperattenuating extra-axial collection, with mild local mass effect.<br><br><b>Impression</b><br>Acute right subdural hematoma.", "en-US"],
  ] as Array<[string, string, LocaleKey]>) {
    it(`naming a hyperattenuating extra-axial collection a hematoma is not a fabrication (${locale})`, () => {
      const out = evaluateSourceCriticals(report, findings, locale);
      assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
      assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
    });
  }
  it("omitting the hyperattenuating subdural collection is a missed critical", () => {
    const out = evaluateSourceCriticals("<b>Análise</b><br>Infarto lacunar antigo na coroa radiada esquerda.<br><br><b>Conclusão</b><br>Infarto lacunar crônico.", "Fina coleção subdural hiperatenuante de 5 mm ao longo da foice cerebral. Infarto lacunar antigo na coroa radiada esquerda.", "pt-BR");
    assert.ok(out.missed.length > 0, JSON.stringify(out.outcomes));
  });
  it("a hypoattenuating (chronic) collection is not an acute bleed", () => {
    assert.deepEqual(sourceCriticalAnchors("Coleção subdural hipoatenuante laminar à direita, crônica.", "pt-BR").map((a) => a.category), []);
  });
  it("patient context and synthetic-harness lines are not abnormal findings (pt-BR)", () => {
    assert.deepEqual(abnormalInputClauses("Contexto de paciente de alto risco.", "pt-BR"), []);
    assert.deepEqual(abnormalInputClauses("Achados sintéticos classificados como categoria BI-RADS 4.", "pt-BR"), []);
  });
});

describe("pilot audit 2: conventions are not clinical errors", () => {
  const US = { exam: "Ultrassonografia do abdome superior.", findings: "Vesícula biliar com pequeno cálculo móvel. Sem espessamento parietal. Fígado com ecotextura preservada.", locale: "pt-BR" as const };
  it("findings under organ headings, without an 'Análise' header, are an analysis", async () => {
    const r = await run(US, "<center><b>ULTRASSONOGRAFIA DO ABDOME SUPERIOR</b></center><br><br><b>VESÍCULA BILIAR</b><br>Pequeno cálculo móvel.<br>Paredes sem espessamento.<br><br><b>FÍGADO</b><br>Ecotextura preservada, contornos regulares e dimensões normais.<br><br><b>IMPRESSÃO</b><br>Colelitíase.");
    assert.deepEqual(failed(r, /^Q08$/), []);
  });
  it("a missing </b> in the title and a one-letter typo still name the exam", async () => {
    const r1 = await run(US, "<center><b>ULTRASSONOGRAFIA DO ABDOME SUPERIOR</center><br><br><b>Análise</b><br>Vesícula biliar com pequeno cálculo móvel, sem espessamento parietal.<br>Fígado com ecotextura preservada.<br><br><b>Conclusão</b><br>Colelitíase.");
    const r2 = await run(US, "<center><b>ULTRASONOGRAFIA DO ABDOME SUPERIOR</b></center><br><br><b>Análise</b><br>Vesícula biliar com pequeno cálculo móvel, sem espessamento parietal.<br>Fígado com ecotextura preservada.<br><br><b>Conclusão</b><br>Colelitíase.");
    assert.deepEqual(failed(r1, /^R01$/), []);
    assert.deepEqual(failed(r2, /^R01$/), []);
  });
  it("a wrong exam in the title still fails", async () => {
    const r = await run(US, "<center><b>TOMOGRAFIA DE CRÂNIO</b></center><br><br><b>Análise</b><br>Vesícula biliar com pequeno cálculo móvel.<br><br><b>Conclusão</b><br>Colelitíase.");
    assert.equal(failed(r, /^R01$/).length, 1);
  });
  it("'sem hérnias discais' preserves 'sem hérnia discal'", async () => {
    const r = await run(
      { exam: "Ressonância magnética da coluna lombar, sem contraste.", findings: "Exame normal. Sem hérnia discal, estenose do canal ou redução dos forames neurais.", locale: "pt-BR" },
      "<center><b>RESSONÂNCIA MAGNÉTICA DA COLUNA LOMBAR</b></center><br><br><b>Análise</b><br>Discos intervertebrais com hidratação preservada, sem hérnias discais.<br>Canal vertebral sem estenose.<br>Forames neurais sem reduções.<br><br><b>Conclusão</b><br>Coluna lombar sem alterações.");
    assert.deepEqual(failed(r, /^(C07|R05)$/), []);
  });
  it("'isquemia aguda' for 'alterações isquêmicas precoces' is not a fabrication", () => {
    const out = evaluateSourceCriticals("<b>Análise</b><br>Oclusão do segmento M1 da artéria cerebral média esquerda.<br>Alterações isquêmicas precoces no território da ACM esquerda.<br><br><b>Conclusão</b><br>Oclusão de M1 à esquerda com isquemia aguda no território da ACM esquerda.", "Oclusão do segmento M1 da artéria cerebral média esquerda. Alterações isquêmicas precoces no território da ACM esquerda.", "pt-BR");
    assert.equal(out.fabricated.length, 0, JSON.stringify(out.fabricated));
  });
  it("style conventions and anatomical checklists are minor, never a FAIL on their own", async () => {
    const r = await run(US, "<center><b>ULTRASSONOGRAFIA DO ABDOME SUPERIOR</b></center><br><br><b>Análise</b><br>Vesícula biliar com pequeno cálculo móvel, sem evidências de espessamento parietal.<br>Fígado com ecotextura preservada.<br><br><b>Conclusão</b><br>Colelitíase.");
    for (const c of r.checks.filter((k) => /^(G\d|T\d|TO|Q10|C05)/.test(k.id))) assert.equal(c.severity, "minor", c.id);
    assert.notEqual(r.verdict, "FAIL");
  });
});

describe("pilot audit 3: pertinent negatives and brief normal reports", () => {
  const CHEST = { exam: "Radiografia de tórax, sem contraste.", findings: "Campos pulmonares sem opacidades focais. Silhueta cardiomediastinal normal. Sem derrame pleural ou pneumotórax.", locale: "pt-BR" as const };
  it("'espaços pleurais livres' for 'sem derrame pleural' is not a missing finding", async () => {
    const r = await run(CHEST, "<center><b>RADIOGRAFIA DE TÓRAX</b></center><br><br><b>Técnica</b><br>Incidências habituais.<br><br><b>Análise</b><br>Campos pulmonares sem opacidades focais.<br>Silhueta cardiomediastinal com dimensões normais.<br>Espaços pleurais livres.<br><br><b>Conclusão</b><br>Exame dentro da normalidade.");
    assert.deepEqual(failed(r, /^(C07|R05)$/), []);
    assert.deepEqual(r.checks.filter((c) => !c.passed && c.severity !== "minor").map((c) => c.id), []);
  });
  it("an affirmed finding that is dropped is still missing", async () => {
    const r = await run({ exam: "Radiografia de tórax, sem contraste.", findings: "Derrame pleural moderado à direita. Sem pneumotórax.", locale: "pt-BR" },
      "<center><b>RADIOGRAFIA DE TÓRAX</b></center><br><br><b>Técnica</b><br>Incidências habituais.<br><br><b>Análise</b><br>Campos pulmonares sem opacidades focais.<br>Silhueta cardiomediastinal normal.<br><br><b>Conclusão</b><br>Exame dentro da normalidade.");
    assert.equal(r.verdict, "FAIL");
  });
});

describe("pilot audit 4: denied lists with 'ou'/'nem', and organ-labelled sections", () => {
  const NEG: Array<[string, string]> = [
    ["Sem evidências de opacidade pulmonar focal, derrame pleural ou pneumotórax", "pneumotórax"],
    ["Não foram observados sinais de ruptura contida, tais como contraste extravasado, hematoma mediastinal focal ou sinais de sangramento ativo", "hematoma"],
    ["Espessamento parietal do sigmoide, sem evidência de abscesso, fístula ou perfuração", "perfuração"],
    ["Ausência de edema com desvio da linha média ou efeito de massa", "desvio da linha média"],
    ["Ausência de edema com desvio da linha média ou efeito de massa", "efeito de massa"],
    ["Não se identificam sinais de invasão parenquimatosa, de compressão do tecido cerebral nem de desvio da linha média", "desvio da linha média"],
    ["Não há sinais de hemorragia intraparenquimatosa, intraventricular ou de trauma craniano associado com fratura", "fratura"],
  ];
  for (const [s, t] of NEG) it(`denied: "${t}" in "${s.slice(0, 60)}…"`, () => assert.equal(isFindingNegated(s, t, "pt-BR"), true));
  const AFF: Array<[string, string, LocaleKey]> = [
    ["Sem derrame pleural, pneumotórax volumoso à direita ou à esquerda e enfisema", "enfisema", "pt-BR"],
    ["No effusion or consolidation, apical pneumothorax and rib fracture on the right", "pneumothorax", "en-US"],
    ["Sem derrame pleural, pneumotórax volumoso à direita e enfisema subcutâneo", "pneumotórax", "pt-BR"],
    ["Sem derrame pleural; pneumotórax ou hidropneumotórax à direita", "pneumotórax", "pt-BR"],
  ];
  for (const [s, t, l] of AFF) it(`affirmed: "${t}" in "${s}"`, () => assert.equal(isFindingNegated(s, t, l), false));
  it("organ labels inside 'Análise' and numbered conclusion items keep their sections", async () => {
    const r = await run(
      { exam: "Tomografia computadorizada do abdome com contraste.", findings: "Laceração esplênica grau III com profundidade de 4,2 cm. Hemoperitônio moderado.", locale: "pt-BR" },
      "<center><b>TOMOGRAFIA COMPUTADORIZADA DO ABDOME</b></center><br><br><b>Análise:</b><br><br><b>Baço:</b> laceração parenquimatosa grau III, com profundidade de 4,2 cm.<br><br><b>Espaços peritoneais:</b> hemoperitônio de volume moderado.<br><br><b>Conclusão:</b><br><br><b>1.</b> Laceração esplênica grau III.<br><br><b>2.</b> Hemoperitônio moderado.");
    assert.deepEqual(failed(r, /^(Q11|Q12|Q08)$/), []);
  });
});

describe("pilot audit 5: long denied lists and patient risk context", () => {
  for (const [s, t] of [
    ["Não se identificam sinais de ruptura contida, sangramento ativo, hematoma mediastinal ou hemomediastino", "sangramento ativo"],
    ["Não há sinais de transformação hemorrágica, hematoma intraparenquimatoso, micro-hemorragia ou depósito de hemossiderina", "hematoma"],
    ["Sem evidência de edema ósseo, fraturas, lesões osteocondrais ou neoplasias", "fraturas"],
    ["O intestino delgado e o grosso não mostram sinais de obstrução ou perfuração", "perfuração"],
  ] as Array<[string, string]>) it(`denied: "${t}"`, () => assert.equal(isFindingNegated(s, t, "pt-BR"), true));
  it("a list closed with 'e' stays affirmed even with commas", () => {
    assert.equal(isFindingNegated("Sem derrame pleural, pneumotórax volumoso à direita, enfisema subcutâneo e fratura costal", "pneumotórax", "pt-BR"), false);
  });
  it("'Paciente de alto risco' is context, not a finding", () => {
    assert.deepEqual(abnormalInputClauses("Paciente de alto risco. Nódulo sólido de 7 mm no lobo superior direito.", "pt-BR"), ["Nódulo sólido de 7 mm no lobo superior direito"]);
  });
  it("an angiotomography is a contrast exam: 'contrastação habitual' is allowed", async () => {
    const r = await run({ exam: "Angiotomografia de crânio e pescoço.", findings: "Oclusão do segmento M1 da artéria cerebral média esquerda.", locale: "pt-BR" },
      "<center><b>ANGIOTOMOGRAFIA DE CRÂNIO E PESCOÇO</b></center><br><br><b>Técnica</b><br>Aquisição após contraste iodado endovenoso.<br><br><b>Análise</b><br>Oclusão do segmento M1 da artéria cerebral média esquerda.<br>Demais artérias com calibre e contrastação habituais.<br><br><b>Conclusão</b><br>Oclusão de M1 à esquerda.");
    assert.deepEqual(failed(r, /^C01$/), []);
  });
  it("'cauda equina de distribuição habitual' is anatomy, not the syndrome", () => {
    for (const s of ["Cauda equina de distribuição habitual.", "Cauda equina sem alterações.", "Cone medular e cauda equina com topografia e sinal preservados, sem compressões."]) {
      assert.deepEqual(sourceCriticalAnchors(s, "pt-BR").map((a) => a.category), [], s);
    }
  });
});

describe("pilot audit 6: conventions never block PASS", () => {
  it("a correct, focused report missing only checklist anatomy can PASS", async () => {
    const r = await run(
      { exam: "Tomografia computadorizada de crânio sem contraste.", findings: "Pequena coleção extra-axial hiperdensa frontoparietal direita, com discreto efeito de massa local. Sem desvio da linha média.", locale: "pt-BR" },
      "<center><b>TOMOGRAFIA COMPUTADORIZADA DE CRÂNIO</b></center><br><br><b>Método:</b><br>Aquisição volumétrica sem contraste.<br><br><b>Análise:</b><br>Pequena coleção extra-axial hiperdensa frontoparietal direita, determinando discreto efeito de massa local.<br>Ausência de desvio das estruturas da linha média.<br>Sistema ventricular de forma e dimensões preservadas.<br>Cisternas e sulcos corticais de amplitude normal.<br>Parênquima encefálico com atenuação habitual.<br><br><b>Impressão:</b><br>Hematoma subdural agudo frontoparietal direito, com discreto efeito de massa local.");
    assert.equal(r.checks.filter((c) => !c.passed && c.severity !== "minor").length, 0, JSON.stringify(r.checks.filter((c) => !c.passed)));
    assert.equal(r.verdict, "PASS", r.gateReasons.join("; "));
  });
});

describe("real-input audit: dictations as radiologists actually send them", () => {
  // Phrasings modelled on real (de-identified) inputs; none is copied from a user.
  it("exam names, technique, global-normal lines and instructions are not findings", () => {
    for (const s of [
      "Radiografia de tórax normal.",
      "Ultrassonografia pélvica transvaginal.",
      "Restante do exame para idoso.",
      "Com contraste venoso.",
      "Laudo de crânio normal.",
      "O restante tudo igual.",
      "Pode tirar a indicação clínica.",
      "E daqui a pouco passo mais.",
    ]) assert.deepEqual(abnormalInputClauses(s, "pt-BR"), [], s);
  });
  it("a finding before a normal cue stays a finding; suffix diagnoses count", () => {
    assert.equal(abnormalInputClauses("Cisto simples no rim direito, restante normal.", "pt-BR").length, 1);
    for (const s of ["Apendicite aguda.", "Varicocele bilateral.", "Cirrose hepática.", "Sinais de espondilose torácica.", "Broncopatia inflamatória."]) {
      assert.equal(abnormalInputClauses(s, "pt-BR").length, 1, s);
    }
    assert.equal(abnormalInputClauses("Rim esquerdo mede 11,7 cm, normal.", "pt-BR").length, 0);
  });
  it("modality comes from the exam, else from the dictation's first sentence, else is unknown", async () => {
    const { deriveExamMeta } = await import("../classify.js");
    const m1 = deriveExamMeta("", "Colangiorressonância magnética, coledocolitíase distal.", "pt-BR");
    assert.equal(m1.modality, "MRI");
    assert.equal(m1.modalityKnown, true);
    assert.equal(deriveExamMeta("PUNHO", "Tenossinovite de De Quervain.", "pt-BR").modalityKnown, false);
  });
  it("a missing or generic title is minor; a title naming another exam is critical", async () => {
    const body = "<br><br><b>Técnica</b><br>Sequências multiplanares.<br><br><b>Análise</b><br>Rotura completa do ligamento cruzado anterior. Meniscos íntegros. Derrame articular pequeno.<br><br><b>Conclusão</b><br>Rotura completa do LCA.";
    const c = { exam: "Ressonância magnética do joelho esquerdo.", findings: "Rotura completa do ligamento cruzado anterior. Derrame articular pequeno.", locale: "pt-BR" as const };
    const generic = await run(c, `<center><b>LAUDO</b></center>${body}`);
    assert.equal(failed(generic, /^R01$/)[0]?.severity, "minor");
    const wrong = await run(c, `<center><b>TOMOGRAFIA COMPUTADORIZADA DO TÓRAX</b></center>${body}`);
    assert.equal(failed(wrong, /^R01$/)[0]?.severity, "critical");
    const unknownExam = await run({ ...c, exam: "PUNHO", findings: "Tenossinovite de De Quervain." }, `<center><b>ULTRASSONOGRAFIA DO PUNHO</b></center><br><br><b>Análise</b><br>Tenossinovite de De Quervain.<br><br><b>Conclusão</b><br>Tenossinovite de De Quervain.`);
    assert.deepEqual(failed(unknownExam, /^R01$/), []);
  });
  it("'Opinião' is a conclusion section", async () => {
    const r = await run({ exam: "Ultrassonografia de bolsas escrotais com Doppler.", findings: "Varicocele bilateral com refluxo à manobra de Valsalva.", locale: "pt-BR" },
      "<center><b>ULTRASSONOGRAFIA DE BOLSAS ESCROTAIS COM DOPPLER</b></center><br><br><b>Relatório</b><br>Testículos tópicos e homogêneos. Plexo pampiniforme ectasiado bilateralmente, com refluxo à manobra de Valsalva.<br><br><b>Opinião:</b><br>Varicocele bilateral.");
    assert.deepEqual(failed(r, /^Q11$/), []);
  });
});

describe("real-input audit 2: report layouts general models actually produce", () => {
  const C = { exam: "Tomografia computadorizada do tórax.", findings: "Leve enfisema pulmonar apical à direita. Ateromatose aórtica.", locale: "pt-BR" as const };
  it("an unbolded DESCRIÇÃO after the technique is still the report body", async () => {
    const r = await run(C, "<center><b>TOMOGRAFIA COMPUTADORIZADA DO TÓRAX</b></center><br><br><b>Técnica</b><br>Aquisição volumétrica sem contraste.<br><br>Descrição:<br>Leve enfisema pulmonar apical à direita. Traqueia e brônquios pérvios. Mediastino sem linfonodomegalias. Ateromatose aórtica. Sem derrame pleural.<br><br><b>Conclusão</b><br>Leve enfisema apical à direita. Ateromatose aórtica.");
    assert.deepEqual(failed(r, /^(Q16|Q17|Q08)/), []);
  });
  it("findings written right under the technique line, with no header, are the body", async () => {
    const r = await run(C, "<center><b>TOMOGRAFIA COMPUTADORIZADA DO TÓRAX</b></center><br><br><b>Técnica</b><br>Aquisição volumétrica sem contraste.<br>Leve enfisema pulmonar apical à direita.<br>Ateromatose aórtica.<br>Sem derrame pleural.<br><br><b>Conclusão</b><br>Leve enfisema apical à direita. Ateromatose aórtica.");
    assert.deepEqual(failed(r, /^(Q16|Q17)/), []);
  });
  it("'não exclui apendicite' and an indication line are not fabricated criticals", async () => {
    const r = await run({ exam: "Tomografia computadorizada do abdome.", findings: "Indicação: dor na fossa ilíaca direita. Apêndice cecal não caracterizado.", locale: "pt-BR" },
      "<center><b>TOMOGRAFIA COMPUTADORIZADA DO ABDOME</b></center><br><br><b>Indicação</b><br>Dor na fossa ilíaca direita. Suspeita de apendicite aguda.<br><br><b>Análise</b><br>Apêndice cecal não caracterizado. Fígado, baço e rins sem alterações. Ausência de líquido livre.<br><br><b>Conclusão</b><br>Apêndice não caracterizado; isso não exclui apendicite em fase inicial.");
    assert.deepEqual(failed(r, /^C10$/), []);
    assert.deepEqual(failed(r, /^R02$/), [], "the side of the complaint is not a finding side");
  });
  it("'Com contraste venoso' in the dictation makes it a contrast exam", async () => {
    const r = await run({ exam: "Crânio.", findings: "Com contraste venoso. Pequeno espessamento mucoso no seio maxilar esquerdo.", locale: "pt-BR" },
      "<center><b>TOMOGRAFIA COMPUTADORIZADA DO CRÂNIO</b></center><br><br><b>Técnica</b><br>Após contraste iodado endovenoso.<br><br><b>Análise</b><br>Sem áreas de realce anômalo. Pequeno espessamento mucoso no seio maxilar esquerdo.<br><br><b>Conclusão</b><br>Pequeno espessamento mucoso no seio maxilar esquerdo.");
    assert.deepEqual(failed(r, /^C01$/), []);
  });
  it("signature placeholders are minor; a placeholder in the findings is critical", async () => {
    const base = "<center><b>TOMOGRAFIA COMPUTADORIZADA DO TÓRAX</b></center><br><br><b>Técnica</b><br>Sem contraste.<br><br><b>Análise</b><br>Leve enfisema pulmonar apical à direita. Ateromatose aórtica. Sem derrame pleural. Mediastino sem linfonodomegalias.<br><br><b>Conclusão</b><br>Leve enfisema apical à direita. Ateromatose aórtica.";
    const sig = await run(C, `${base}<br><br>Médico radiologista: ____________<br>CRM: [UF] [Número]`);
    assert.deepEqual(failed(sig, /^Q07$/), []);
    assert.equal(failed(sig, /^Q18$/)[0]?.severity, "minor");
    const hole = await run(C, base.replace("Ateromatose aórtica. Sem", "Nódulo de [MEDIDA] mm. Ateromatose aórtica. Sem"));
    assert.equal(failed(hole, /^Q07$/)[0]?.severity, "critical");
    const todo = await run(C, base.replace("Ateromatose aórtica. Sem", "[Completar: padrão, distribuição e extensão.] Ateromatose aórtica. Sem"));
    assert.equal(failed(todo, /^Q07$/)[0]?.severity, "critical", "a bracketed instruction left in the findings is unfinished");
  });
  it("a centred title that contains a section word is not that section", async () => {
    const r = await run({ exam: "Radiografia das mãos.", findings: "Mão esquerda sem alterações. Amputação da falange distal do segundo raio à direita.", locale: "pt-BR" },
      "<center><b>RELATÓRIO DE EXAME RADIOGRÁFICO</b></center><br><br><b>Técnica</b><br>Incidências de rotina.<br><br><b>Descrição</b><br>Mão esquerda sem alterações. Mão direita com amputação da falange distal do segundo raio. Demais estruturas ósseas preservadas. Partes moles sem alterações.<br><br><b>Conclusão</b><br>Amputação da falange distal do segundo raio à direita.");
    assert.deepEqual(failed(r, /^Q12$/), []);
  });
});
