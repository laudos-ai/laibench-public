/**
 * Deterministic, locale-aware TEMPLATE REFERENCE agent (v3.11.0).
 *
 * Restructures the input findings into the LAIBench report contract — title,
 * Technique (not for ultrasound), Findings, Impression — keeping every input
 * sentence, its polarity and laterality. The impression is synthesized from the
 * affirmed abnormal sentences ("consistent with X" → "X"), with measurements
 * removed. For structures the expected anatomical coverage lists but the
 * findings never mention, it appends one neutral normal statement.
 *
 * It is a harness baseline for smoke runs and the public discrimination ladder,
 * NOT a clinical report generator: it cannot see images and only re-states the
 * provided text. Usage (command provider):
 *
 *   npm run bench -- suite --suite suites/lite-public.en-US.json \
 *     --provider command --cmd "node examples/reference-agent.mjs" \
 *     --run-name reference --track agent --out runs/reference.json
 *
 * It also exports `buildReferenceReport(job)` so other scripts (the public
 * ladder, the website playground) produce byte-identical reports.
 */
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const META_SENTENCE = /\b(?:synthetic|harness|demonstration|for testing|testing\b|example\b|high-risk patient context)/i;
const META_PHRASE = /\s*(?:,\s*)?\b(?:in|for|of)\s+the\s+example\b/gi;

const L = {
  "en-US": {
    technique: "Technique", findings: "Findings", impression: "Impression",
    protocol: (exam) => `${exam}, acquired per standard protocol.`,
    normalStudy: "No acute abnormality.",
    consistent: /\b(?:consistent with|compatible with|most consistent with|suggestive of|in keeping with)\s+/i,
    negLead: /^(?:no|without|negative for|absent)\b/i,
    normalLead: /^normal study\b/i,
    normalWords: /\b(?:unremarkable|within (?:normal|expected) limits|normal in size|preserved|clear(?: bilaterally)?\.?$|intact|not dilated|homogeneous|stable|scattered fibroglandular)\b/i,
    measurement: /\s*(?:,\s*)?(?:measuring|up to|of)?\s*(?:approximately\s+)?\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)*\s*(?:cm|mm|%)(?:\s+in\s+(?:maximal|the largest)\s+(?:diameter|axis))?/gi,
    sides: [[/\bright\b/i, "right"], [/\bleft\b/i, "left"], [/\bbilateral(?:ly)?\b/i, "bilateral"]],
    normal: (items) => `${cap(join(items, "en-US"))} without abnormality.`,
    and: "and",
  },
  "pt-BR": {
    technique: "Técnica", findings: "Análise", impression: "Conclusão",
    protocol: (exam) => `${exam}, realizado conforme protocolo padrão.`,
    normalStudy: "Exame dentro dos limites da normalidade.",
    consistent: /\b(?:compat[ií]vel com|sugestivo de|aspecto (?:sugestivo|compat[ií]vel) (?:de|com))\s+/i,
    negLead: /^(?:sem|n[ãa]o\s+(?:h[áa]|se|foram|foi)|aus[êe]ncia de)\b/i,
    normalLead: /^exame normal\b/i,
    normalWords: /\b(?:sem altera[çc][õo]es|dentro dos limites|preservad[oa]s?|habitua(?:l|is)|normais?|[íi]ntegr[oa]s?|n[ãa]o dilatad[oa]s?|homog[êe]ne[oa])\b/i,
    measurement: /\s*(?:,\s*)?(?:medindo|com|de)?\s*(?:cerca de\s+)?\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)*\s*(?:cm|mm|%)/gi,
    sides: [[/\bdireit[ao]s?\b/i, "à direita"], [/\besquerd[ao]s?\b/i, "à esquerda"], [/\bbilaterai?s?\b/i, "bilateral"]],
    normal: (items) => `${cap(join(items, "pt-BR"))} sem alterações.`,
    and: "e",
  },
};

// Coverage stems (from the locale contract) → a readable structure name, plus
// the words that mean the findings already talk about that structure.
const COVER_EN = {
  ventricl: ["ventricular system", /ventric|hydroceph|intraventricular/], sulci: ["cortical sulci", /sulc/], cistern: ["basal cisterns", /cistern/],
  calvari: ["calvarium", /calvar|skull|fractur/], "posterior fossa": ["posterior fossa", /posterior fossa|cerebell/],
  midline: ["midline structures", /midline/], orbit: ["orbits", /orbit/], "paranasal sinus": ["paranasal sinuses", /sinus/],
  pulmon: ["pulmonary parenchyma", /pulmon|lung|nodul|consolidat|opacit|ground-glass|lobe|pneumon|edema|embol/], trache: ["trachea", /trache/],
  mediast: ["mediastinum", /mediast/], lymph: ["lymph nodes", /lymph|adenopath/], pleura: ["pleural spaces", /pleur|effusion|pneumothorax/],
  heart: ["heart", /heart|cardi|ventric|strain/], pericardi: ["pericardium", /pericardi/], aorta: ["aorta", /aort/], esophag: ["esophagus", /esophag/],
  liver: ["liver", /liver|hepat|steatosis/], gallbladder: ["gallbladder", /gallbladder|cholecyst|gallstone/], "bile duct": ["bile ducts", /bile|biliar|choledoch/],
  pancreas: ["pancreas", /pancrea/], spleen: ["spleen", /splen/], adrenal: ["adrenal glands", /adrenal/], kidney: ["kidneys", /kidney|renal|nephr|hydroneph|ureter/],
  bowel: ["bowel loops", /bowel|colon|sigmoid|append|duoden|ileum|jejun|viscus/], bladder: ["urinary bladder", /bladder/], rectum: ["rectum", /rect/],
  bone: ["bone structures", /bone|osseous|fractur|vertebra|lytic|sclerotic/], musculature: ["musculature", /muscl/], fat: ["fat planes", /fat\b|stranding/],
  ureter: ["ureters", /ureter/], alignment: ["vertebral alignment", /alignment|listhesis/], vertebra: ["vertebral bodies", /vertebra/],
  canal: ["spinal canal", /canal|stenosis/], disc: ["intervertebral discs", /disc|disk/], cord: ["spinal cord", /cord|myelopath|conus/],
  foramen: ["neural foramen at each level", /foramin|foramen/], signal: ["parenchymal signal", /signal|hyperintens|flair|t2/], diffusion: ["diffusion", /diffusion/],
  parenchym: ["parenchyma", /parenchym|lung|brain|white matter|consolidat|opacit|nodul|pneumon|atelecta|edema|ground-glass|lobe|infarct|hemorrhag|hematoma|lesion|mass/], mesorect: ["mesorectum", /mesorect/], endometri: ["endometrium", /endometri|uter/],
  "cul-de-sac": ["cul-de-sac", /cul-de-sac|free fluid/], "right lobe": ["right lobe", /right (?:thyroid )?lobe/], "left lobe": ["left lobe", /left (?:thyroid )?lobe/],
  isthmus: ["isthmus", /isthmus/], nodule: [null, /nodul/], skin: ["skin", /skin/], axilla: ["axillae", /axill/],
  cardiac: ["cardiac silhouette", /cardi|heart|cardiomegaly/], hila: ["hila", /hil/], costophrenic: ["costophrenic angles", /costophrenic|effusion/],
  "soft tissue": ["soft tissues", /soft[- ]tissue/],
};

// Expected anatomical coverage, mirrored from src/locales/en-US.ts (`coverage`)
// so this file runs with plain `node` (no TypeScript loader).
const COVERAGE_EN = {
  "CT:head": ["ventricl", "sulci", "cistern", "parenchym", "calvari", "posterior fossa", "midline", "orbit", "paranasal sinus"],
  "CT:chest": ["pulmon", "trache", "mediast", "lymph", "pleura", "heart", "pericardi", "aorta", "esophag"],
  "CT:abdomen": ["liver", "gallbladder", "bile duct", "pancreas", "spleen", "adrenal", "kidney", "bowel", "aorta", "lymph"],
  "CT:pelvis": ["bladder", "rectum", "lymph", "bone", "musculature", "fat"],
  "CT:urinary": ["kidney", "ureter", "bladder"],
  "CT:spine": ["alignment", "vertebra", "canal", "soft tissue"],
  "MRI:head": ["ventricl", "sulci", "parenchym", "signal", "diffusion", "posterior fossa", "midline"],
  "MRI:abdomen": ["liver", "bile duct", "pancreas", "spleen", "kidney", "adrenal"],
  "MRI:spine": ["alignment", "vertebra", "disc", "canal", "cord", "foramen"],
  "MRI:pelvis": ["bladder", "rectum", "mesorect", "lymph", "musculature"],
  "US:abdomen": ["liver", "gallbladder", "bile duct", "pancreas", "spleen", "kidney", "aorta"],
  "US:pelvis": ["bladder", "endometri", "cul-de-sac"],
  "US:urinary": ["kidney", "bladder"],
  "US:thyroid": ["right lobe", "left lobe", "isthmus", "nodule"],
  "US:breast": ["nodule", "skin", "axilla"],
  "MG:breast": ["nodule", "skin", "axilla"],
  "MX:breast": ["nodule", "skin", "axilla"],
  "XR:chest": ["cardiac", "mediast", "hila", "parenchym", "costophrenic", "soft tissue"],
};

function fold(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

/** Same rules as src/classify.ts deriveModality + en-US regionMap. */
export function coverageFor(exam) {
  const e = fold(exam);
  let modality = "CT";
  if (/\b(rm|mri|ressonancia|magnetic resonance)\b/.test(e)) modality = "MRI";
  else if (/\b(us|usg|ultra|ultrassom|ultrassonografia|ecografia|ecodoppler|doppler|ultrasound|ultrasonography|sonography|sonogram)\b/.test(e)) modality = "US";
  else if (/\b(rx|x-ray|xray|radiograph|radiographs|radiography|radiografia|radiografias)\b|\braios?[\s-]?x\b/.test(e)) modality = "XR";
  else if (/\b(mamografia digital|digital mammography|mx)\b/.test(e)) modality = "MX";
  else if (/\b(mamografia|mammography|mammogram|mg)\b/.test(e)) modality = "MG";
  let region = "unknown";
  if (/thyroid/.test(e)) region = "thyroid";
  else if (/breast|mammo/.test(e)) region = "breast";
  else if (/urinary|uro|urolog/.test(e)) region = "urinary";
  else if (/pelv/.test(e)) region = "pelvis";
  else if (/head|brain|cranial/.test(e)) region = "head";
  else if (/chest|thorax|lung|pulmonary|mediastin|thoracic\s+aort/.test(e)) region = "chest";
  else if (/abd/.test(e)) region = "abdomen";
  else if (/spine|lumbar|cervical|thoracic/.test(e)) region = "spine";
  else if (/neck/.test(e)) region = "neck";
  return COVERAGE_EN[`${modality}:${region}`] ?? [];
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function join(items, locale) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${L[locale].and} ${items[items.length - 1]}`;
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }

function cleanExam(exam) {
  return String(exam || "")
    .replace(/\.$/, "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/synthetic|demonstra|example/i.test(p))
    .join(", ");
}

function sentencesOf(findings) {
  return String(findings || "")
    .replace(META_PHRASE, "")
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !META_SENTENCE.test(s))
    .map((s) => (s.endsWith(".") ? s : `${s}.`));
}

function sideOf(text, locale) {
  const hits = L[locale].sides.filter(([rx]) => rx.test(text)).map(([, side]) => side);
  return hits.length === 1 ? hits[0] : null;
}

function impressionLine(sentence, locale) {
  const spec = L[locale];
  let core = sentence.replace(/\.$/, "");
  const m = spec.consistent.exec(core);
  if (m) core = core.slice(m.index + m[0].length);
  else core = core.split(/[,;]/)[0];
  core = core.replace(spec.measurement, "").replace(/\s{2,}/g, " ").replace(/\(\s*\)/g, "").trim();
  // Keep the side of the finding in the impression when the diagnosis lost it.
  const side = sideOf(sentence, locale);
  if (side && !sideOf(core, locale)) core = locale === "en-US" ? `${side} ${core}` : `${core} ${side}`;
  return cap(core.replace(/\s+([.,])/g, "$1")) + ".";
}

/** Build the report HTML for a job { exam, findings, locale }. */
export function buildReferenceReport(job, coverage = coverageFor(job.exam)) {
  const locale = job.locale === "pt-BR" ? "pt-BR" : "en-US";
  const spec = L[locale];
  const exam = cleanExam(job.exam);
  const spelled = locale === "en-US"
    ? exam.replace(/^CT pulmonary angiography\b/i, "Computed tomography pulmonary angiography")
        .replace(/^CT angiography\b/i, "Computed tomography angiography")
        .replace(/^CTA\b/, "Computed tomography angiography")
        .replace(/^CT\b/, "Computed tomography")
        .replace(/^MRI\b/, "Magnetic resonance imaging")
        .replace(/^US\b/, "Ultrasound")
    : exam.replace(/^TC\b/, "Tomografia computadorizada").replace(/^RM\b/, "Ressonância magnética").replace(/^US\b/, "Ultrassonografia");
  const title = (spelled || (locale === "en-US" ? "Radiology report" : "Laudo radiológico")).toUpperCase();
  const isUS = /ultrasound|ultrassom|ultrassonografia|ecografia|doppler|sonogra/i.test(job.exam || "");
  const sentences = sentencesOf(job.findings);
  const findingsText = sentences.join(" ").toLowerCase();

  const isNormalSentence = (s) => spec.negLead.test(s) || spec.normalLead.test(s) || spec.normalWords.test(s);
  const abnormalSentences = sentences.filter((s) => !isNormalSentence(s));

  const body = [...sentences];
  if (locale === "en-US" && Array.isArray(coverage) && coverage.length) {
    // A normal statement is added for a structure only when no sentence says
    // something ABNORMAL about it (never contradict the findings).
    const missing = coverage
      .map((stem) => [stem, COVER_EN[stem]])
      .filter(([stem, entry]) => entry && entry[0] && !findingsText.includes(stem)
        && !abnormalSentences.some((s) => entry[1].test(s.toLowerCase())))
      .map(([, entry]) => entry[0]);
    if (missing.length) body.push(spec.normal(missing));
  }

  const abnormal = abnormalSentences;
  const impression = abnormal.length
    ? abnormal.slice(0, 2).map((s) => impressionLine(s, locale)).join("<br>")
    : spec.normalStudy;

  const parts = [`<center><b>${esc(title)}</b></center>`];
  if (!isUS) parts.push(`<br><br><b>${spec.technique}</b><br>${esc(spec.protocol(exam || title))}`);
  parts.push(`<br><br><b>${spec.findings}</b><br>${body.map(esc).join("<br>")}`);
  parts.push(`<br><br><b>${spec.impression}</b><br>${impression.split("<br>").map(esc).join("<br>")}`);
  return parts.join("");
}

// ---- command-provider entry point ----
const isCli = typeof process !== "undefined" && Array.isArray(process.argv) && process.argv[1]
  && (() => { try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isCli) {
  let input = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (c) => { input += c; });
  stdin.on("end", () => {
    const job = JSON.parse(input);
    stdout.write(JSON.stringify({ html: buildReferenceReport(job) }));
  });
}
