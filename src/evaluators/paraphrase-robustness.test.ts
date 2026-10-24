import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { benchmarkCase } from "../benchmark.js";
import { evaluateSourceCriticals } from "./source-critical.js";
import type { BenchCase } from "../types.js";

// Paraphrase robustness (v3.11.0). Correct reports written the way a radiologist
// or a capable model would — different wording, merged sentences, abbreviations
// (ACL, MCA, UVJ), diagnosis-first impressions — must never trip the
// source-anchored gates (C09/C10/Q16/Q17). A false critical FAIL on a correct
// report is as damaging to trust as a false PASS on a wrong one.
const repoRoot = resolve(new URL(".", import.meta.url).pathname, "../..");
const cases: Record<string, BenchCase> = Object.fromEntries(
  (JSON.parse(readFileSync(resolve(repoRoot, "cases/public/synthetic-demo.en-US.json"), "utf8")) as BenchCase[]).map((c) => [c.id.slice(-3), c]),
);
const R = (t: string, tech: string | null, f: string, i: string) =>
  `<center><b>${t}</b></center>${tech ? `<br><br><b>Technique</b><br>${tech}` : ""}<br><br><b>Findings</b><br>${f}<br><br><b>Impression</b><br>${i}`;
const P: Record<string,string> = {
 "002": R("COMPUTED TOMOGRAPHY OF THE HEAD WITHOUT CONTRAST","Axial noncontrast images of the head.","Small hyperdense extra-axial collection over the right frontoparietal convexity, producing mild local mass effect. Midline structures are not shifted. Basal cisterns are patent. Ventricles and sulci otherwise normal.","Small right frontoparietal acute extra-axial collection with mild local mass effect."),
 "005": R("CT ANGIOGRAPHY OF THE HEAD AND NECK","CTA of the cervical and intracranial vessels with contrast.","Abrupt occlusion of the left MCA M1 segment. Early ischemic change in the left MCA territory with loss of gray-white differentiation. Cervical carotid and vertebral arteries patent. Incidental right thyroid nodule.","Acute left M1 occlusion with early left MCA territory ischemia."),
 "007": R("COMPUTED TOMOGRAPHY ANGIOGRAPHY OF THE CHEST","CT pulmonary angiography with intravenous contrast.","Segmental pulmonary embolism in the right lower lobe. RV/LV ratio is normal without signs of right heart strain. Small right pleural effusion. Remaining pulmonary arteries patent.","Right lower lobe segmental pulmonary embolism without right heart strain."),
 "013": R("CT PULMONARY ANGIOGRAPHY","Contrast-enhanced CT pulmonary angiography.","Large filling defect in the right main pulmonary artery extending into right lower lobe segmental branches. RV/LV ratio 1.1, compatible with mild right heart strain. No pleural effusion.","Acute right-sided pulmonary embolism with mild right heart strain."),
 "016": R("CT ANGIOGRAPHY OF THE THORACIC AORTA","CTA of the thoracic aorta.","Dissection flap in the descending thoracic aorta from the left subclavian artery origin to the diaphragmatic hiatus. No contained rupture. Left pleural effusion.","Stanford type B aortic dissection."),
 "017": R("CT ABDOMEN AND PELVIS WITH CONTRAST","Contrast-enhanced CT of the abdomen and pelvis.","Appendix dilated to 11 mm with periappendiceal inflammatory stranding and an appendicolith. No free air or drainable abscess.","Acute appendicitis with appendicolith, uncomplicated."),
 "018": R("CT ABDOMEN AND PELVIS WITHOUT CONTRAST","Noncontrast CT of the abdomen and pelvis.","Pneumoperitoneum along the anterior abdominal wall with a focal defect of the duodenal bulb wall. Moderate pelvic free fluid.","Perforated duodenal bulb with pneumoperitoneum."),
 "020": R("CT ABDOMEN AND PELVIS WITH CONTRAST","Contrast-enhanced CT.","Dilated small bowel loops up to 3.8 cm with a transition point in the right lower quadrant and collapsed distal loops. No pneumatosis.","Mechanical small bowel obstruction with right lower quadrant transition point."),
 "024": R("MAGNETIC RESONANCE IMAGING OF THE BRAIN","Multiplanar multisequence MRI without contrast.","Restricted diffusion with FLAIR hyperintensity in the left MCA territory. No hemorrhagic transformation. No midline shift.","Acute left MCA territory infarct."),
 "027": R("CT HEAD WITHOUT CONTRAST","Noncontrast CT of the head.","Acute subarachnoid hemorrhage in the basal cisterns and right sylvian fissure. Ventricles not enlarged. No midline shift.","Acute subarachnoid hemorrhage, right sylvian predominant."),
 "028": R("MRI OF THE CERVICAL SPINE","MRI without contrast.","C5-C6 disc-osteophyte complex with severe central canal stenosis, cord compression and intramedullary T2 hyperintensity.","C5-C6 cord compression with compressive myelopathy."),
 "031": R("ABDOMINAL ULTRASOUND",null,"Multiple mobile shadowing gallstones. Gallbladder wall thickened to 5 mm with pericholecystic collection and positive sonographic Murphy sign.","Acute calculous cholecystitis."),
 "041": R("CHEST RADIOGRAPH","Single frontal view.","Large left pneumothorax with about 40% collapse of the left lung and mediastinal shift to the right.","Left tension pneumothorax. Immediate decompression advised."),
 "043": R("CHEST RADIOGRAPH","PA and lateral.","Right lower lobe consolidation with air bronchograms. No effusion or pneumothorax.","Right lower lobe pneumonia."),
 "046": R("CHEST RADIOGRAPH","PA and lateral views.","Acute displaced fractures of the left lateral sixth and seventh ribs. No pneumothorax or hemothorax. Lungs clear.","Acute displaced left 6th and 7th rib fractures."),
 "049": R("CT HEAD WITHOUT CONTRAST","Noncontrast CT.","Acute intraparenchymal hemorrhage in the right basal ganglia, 3.0 x 2.4 cm, with mild perilesional edema and 4 mm midline shift to the left. No intraventricular extension.","Acute right basal ganglia intraparenchymal hemorrhage with leftward midline shift."),
 "010": R("MAGNETIC RESONANCE IMAGING OF THE LEFT KNEE","MRI without contrast.","Complete ACL tear. Bucket-handle tear of the medial meniscus with a fragment flipped into the intercondylar notch. Small joint effusion.","Complete ACL tear and displaced bucket-handle medial meniscal tear."),
 "019": R("CT ABDOMEN AND PELVIS WITHOUT CONTRAST","Noncontrast CT.","6 mm obstructing stone at the left UVJ causing moderate left hydronephrosis and hydroureter. No perinephric abscess.","Obstructing left UVJ calculus with moderate hydronephrosis."),
 "033": R("ABDOMINAL AORTIC ULTRASOUND",null,"Fusiform infrarenal abdominal aortic aneurysm measuring 5.1 cm. No free fluid.","Infrarenal abdominal aortic aneurysm."),
 "036": R("THYROID ULTRASOUND",null,"Right lobe: solid hypoechoic taller-than-wide nodule, 1.4 cm, with microcalcifications. No abnormal cervical lymph nodes.","Suspicious right thyroid nodule, TI-RADS 5."),
};

describe("paraphrase robustness: correct paraphrases never trip C09/C10/Q16/Q17", () => {
  for (const [k, html] of Object.entries(P)) {
    it(`${cases[k].id}`, async () => {
      const r = await benchmarkCase({ case: cases[k], locale: "en-US", providedHtml: html, providerLabel: "p", modelLabel: "p" });
      const bad = r.checks.filter((c) => !c.passed && /^(C09|C10|Q16|Q17)/.test(c.id));
      assert.deepEqual(bad.map((c) => `${c.id}: ${c.evidence}`), []);
    });
  }
});

describe("critical paraphrases are recognized (no false omission)", () => {
  const cases2: Array<[string, string]> = [
    ["Restricted diffusion in the left MCA territory, consistent with acute infarct.", "Acute left MCA territory infarct."],
    ["Intimal flap in the descending thoracic aorta, consistent with Stanford type B aortic dissection.", "Dissection of the descending thoracic aorta, Stanford type B."],
    ["Dilated appendix with periappendiceal stranding, consistent with acute appendicitis.", "Acute uncomplicated appendicitis."],
    ["Transition point in the right lower quadrant, consistent with small bowel obstruction.", "Obstruction of the small bowel with right lower quadrant transition point."],
    ["Severe canal stenosis at C5-C6 with cord compression.", "Compression of the spinal cord at C5-C6."],
    ["Free intraperitoneal air with a duodenal bulb defect, consistent with perforated viscus.", "Perforated duodenal bulb."],
    ["Right subdural hematoma with 6 mm midline shift.", "Right subdural hematoma with shift of the midline by 6 mm."],
  ];
  for (const [input, report] of cases2) {
    it(report, () => {
      const out = evaluateSourceCriticals(`<b>Findings</b><br>${report}<br><br><b>Impression</b><br>${report}`, input, "en-US");
      assert.equal(out.missed.length, 0, JSON.stringify(out.outcomes));
    });
  }
});
