import type { ExamMeta } from "../types.js";
import type { LocaleSpec } from "./types.js";

export const enUS: LocaleSpec = {
  key: "en-US",
  name: "English (US)",
  sections: {
    analysis: /Findings|Analysis/i,
    conclusion: /Impression|Conclusion/i,
    technique: /Technique/i,
  },
  sectionLabels: {
    analysis: "Findings",
    conclusion: "Impression",
    technique: "Technique",
  },
  titleAbbrev: [/^CT\s/i, /^MRI?\s/i, /^US\s/i, /^XR\s/i],
  forbiddenTerms: [
    [/\bno evidence of\b/gi, "no evidence of→absent/no"],
    [/\bfluid\b/gi, "fluid→collection/effusion when specific"],
    [/\blesion\b/gi, "lesion→use more specific term when possible"],
    [/\bappears to\b/gi, "appears to→state directly"],
    [/\bcannot be excluded\b/gi, "cannot be excluded→state uncertainty more explicitly"],
  ],
  forbiddenOpeners: ["There is", "There are", "The patient has", "This is a"],
  contrastTerms: /\benhancement\b|\bwash[\s-]?out\b|\barterial\s+phase\b|\bportal\s+phase\b|\bdelayed\s+phase\b|\bhyperenhanc/gi,
  umbrellaTerms: /remaining\s+structures|otherwise\s+(?:un)?remarkable|no\s+other\s+(?:significant\s+)?findings/gi,
  bannedPhrases: [/no other significant findings/gi],
  normalPatterns: [/^normal$/i, /^no\s+acute\s+abnormality/i, /^unremarkable$/i],
  modalityVocab: {
    US_forbidden: /\battenuation\b|\bdensity\b|\bsignal\s+intensity\b|\benhancement\b/gi,
    MRI_forbidden: /\bechogenicity\b|\bhypoechoic\b|\banechoic\b|\bechogenic\b/gi,
    CT_forbidden: /\bsignal\s+intensity\b/gi,
    CT_fix: "signal intensity→attenuation",
  },
  titleModalityTokens: {
    // Each entry is a slot of pipe-separated variants; isTitleMatch requires every
    // slot to be satisfied by at least one variant. Standard abbreviations
    // (CT, MRI, MR, CTA) are accepted alongside full forms.
    CT: ["computed tomography|ct angiography|cta|ct"],
    MRI: ["magnetic resonance|mri|mr "],
    US: ["ultrasound|sonogra|doppler"],
    XR: ["radiograph|x-ray|xray"],
    MG: ["mammography|mammogram"],
    MX: ["mammography|mammogram"],
  },
  titleRegionTokens: {
    head: ["head", "brain", "cranial"],
    chest: ["chest", "thorax"],
    abdomen: ["abdomen", "abdominal"],
    spine: ["spine", "lumbar", "cervical", "thoracic"],
    urinary: ["urinary", "urogra", "urinary tract"],
    pelvis: ["pelvis", "pelvic"],
    breast: ["breast", "mammogra"],
    thyroid: ["thyroid"],
    neck: ["neck", "cervical"],
    unknown: [],
  },
  coverage: {
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
  },
  negationPatterns: [
    /\bno evidence of\b/,
    /\bwithout\b/,
    /\babsent\b/,
    /\bnegative for\b/,
    /\bruled out\b/,
    /\bexcluded\b/,
    /\bno (?:signs?|findings?) of\b/,
    /\bnot (?:identified|seen|detected|demonstrated|observed)\b/,
  ],
  preservationPatterns: [
    { id: "steatosis", input: /steatosis|fatty liver/gi, report: /steatosis|fatty liver/gi, label: "steatosis" },
    { id: "gallstone", input: /gallstone|cholelith/gi, report: /gallstone|cholelith/gi, label: "gallstone" },
    { id: "sludge", input: /biliary sludge/gi, report: /biliary sludge/gi, label: "biliary sludge" },
    { id: "renalCyst", input: /renal cyst|kidney cyst/gi, report: /renal cyst|kidney cyst/gi, label: "renal cyst" },
    { id: "pleuralEffusion", input: /pleural effusion/gi, report: /pleural effusion/gi, label: "pleural effusion" },
    { id: "cvc", input: /\bCVC\b|central venous catheter/gi, report: /\bCVC\b|central venous catheter/gi, label: "CVC" },
    { id: "discHernia", input: /disc herniation|herniated disc/gi, report: /disc herniation|herniated disc/gi, label: "disc herniation" },
    { id: "foraminalStenosis", input: /foraminal stenosis/gi, report: /foraminal stenosis/gi, label: "foraminal stenosis" },
    { id: "subduralHematoma", input: /subdural hematoma/gi, report: /subdural hematoma/gi, label: "subdural hematoma" },
    { id: "hydronephrosis", input: /hydronephrosis/gi, report: /hydronephrosis/gi, label: "hydronephrosis" },
    { id: "umbilicalHernia", input: /umbilical hernia/gi, report: /umbilical hernia/gi, label: "umbilical hernia" },
    { id: "calculus", input: /calculus|stone/gi, report: /calculus|stone/gi, label: "calculus" },
    { id: "normal", input: /^normal$/i, report: /no acute abnormality|unremarkable|within normal limits/i, label: "normality" }
  ],
  regionMap: (exam) => {
    if (/thyroid/.test(exam)) return "thyroid";
    if (/breast|mammo/.test(exam)) return "breast";
    if (/urinary|uro|urolog/.test(exam)) return "urinary";
    if (/pelv/.test(exam)) return "pelvis";
    if (/head|brain|cranial/.test(exam)) return "head";
    if (/chest|thorax|lung/.test(exam)) return "chest";
    if (/abd/.test(exam)) return "abdomen";
    if (/spine|lumbar|cervical|thoracic/.test(exam)) return "spine";
    if (/neck/.test(exam)) return "neck";
    return "unknown";
  },
  buildSystemPrompt(meta: ExamMeta): string {
    const maybeTechnique = meta.modality === "US" ? "Do not include a Technique section for ultrasound." : "Use Technique, Findings, Impression sections.";
    const contrastRule = meta.contrast
      ? "Contrast exam: enhancement language is allowed only if supported by the findings."
      : "Non-contrast exam: do not mention enhancement, phases, washout, or contrast uptake.";
    return [
      "You are laudAI, a senior radiologist writing in English.",
      "Output only HTML. Allowed tags: <center>, <b>, <br>.",
      "Start with <center><b>FULL EXAM TITLE</b></center>.",
      "Use <br><br> only between sections. Use single <br> within sections.",
      maybeTechnique,
      contrastRule,
      "Never hallucinate findings.",
      "Impression must contain diagnoses or concise impressions only, not measurements or generic normal restatements.",
      "Forbidden openers: There is, There are, The patient has, This is a.",
      "Use modality-appropriate vocabulary.",
    ].join("\n");
  },
  judgeInstructions: "Review in English. Be adversarial. Verify every material claim against the findings. Penalize hallucinations, omitted findings, wrong modality terminology, wrong sectioning, and impression drift."
};
