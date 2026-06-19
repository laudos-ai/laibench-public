import type { ExamMeta } from "../types.js";
import type { LocaleSpec } from "./types.js";

export const ptBR: LocaleSpec = {
  key: "pt-BR",
  name: "Portuguese (Brazil)",
  sections: {
    analysis: /An[áa]lise|Achados/i,
    conclusion: /Conclus[ãa]o|Impress[ãa]o/i,
    technique: /T[ée]cnica/i,
  },
  sectionLabels: {
    analysis: "Análise",
    conclusion: "Conclusão",
    technique: "Técnica",
  },
  titleAbbrev: [/^TC\s/i, /^RM\s/i, /^US\s/i, /^USG\s/i, /^RX\s/i],
  forbiddenTerms: [
    [/\bcolônic[oa]\b/gi, "colônico→cólico"],
    [/\bpatente\b/gi, "patente→pérvia"],
    [/\blinfadenopatia\b/gi, "linfadenopatia→linfonodomegalia"],
    [/(?:não há|sem)\s+evidências?\s+de/gi, "sem evidência de→Ausência de"],
    [/por\s+(?:conta|causa)\s+de/gi, "por conta de→decorrente de"],
    [/\bao\s+menos\b/gi, "ao menos→pelo menos"],
    [/\bespessação\b/gi, "espessação→espessamento"],
    [/\badelgaçamento\b/gi, "adelgaçamento→afilamento"],
    [/\bfluido\b/gi, "fluido→líquido"],
    [/\bnodulação\b/gi, "nodulação→nódulo"],
    [/processo\s+col[ií]tico/gi, "processo colítico→colite"],
    [/aumentad[oa]\s+de\s+dimensões/gi, "aumentado de dimensões→com dimensões aumentadas"],
    // Historical T12 slot kept as a no-op for stable check IDs. "Intravenoso"
    // is acceptable clinical Portuguese; the prompt may prefer "endovenoso",
    // but the benchmark should not score that house-style preference.
    [/(?!)/gi, "intravenoso→endovenoso"],
    [/estriações?\s+(?:de|da|na)\s+gordura/gi, "estriações gordura→densificação gordura"],
  ],
  forbiddenOpeners: ["Presença de", "Observa-se", "Nota-se", "Identifica-se", "Evidencia-se", "Visualiza-se", "Detecta-se", "Constata-se", "Demonstra-se"],
  contrastTerms: /\brealce\b|\bimpregnação\b|\bcontrastação\b|\bcontrastacao\b|\bwash[\s-]?out\b|\bfase\s+(?:arterial|portal|tardia|venosa)\b|\bcaptação\s+(?:de|do|pelo)\s+contraste\b/gi,
  umbrellaTerms: /demais\s+estruturas|outras\s+alterações\s+avaliáveis|sem\s+outros?\s+achados/gi,
  bannedPhrases: [/ausência de outras alterações avaliáveis/gi],
  normalPatterns: [/^normal$/i, /^sem\s+alterações/i, /^sem\s+achados/i, /^dentro\s+da\s+normalidade/i],
  modalityVocab: {
    US_forbidden: /\bdensidade\b|\bhipersinal\b/gi,
    MRI_forbidden: /\becogenicidade\b|\bhipoecoic\b|\banecoic\b/gi,
    // BUG 7 FIX: "densidade" is legitimate CT terminology (e.g., "densidade espontanea",
    // "densidade de partes moles"). It is only wrong in US context where the US_forbidden
    // already catches it. Removing the CT-level ban.
    CT_forbidden: /(?!)/gi,  // never matches - no CT-specific forbidden terms for pt-BR
    CT_fix: "",
  },
  titleModalityTokens: {
    // Each entry is a slot of pipe-separated variants; isTitleMatch requires every
    // slot to be satisfied by at least one variant. Standard Brazilian title
    // abbreviations (TC, RM, USG, RX, angio-TC) are accepted alongside full forms.
    CT: ["tomografia|angiotomografia|angio-tc|tc"],
    MRI: ["ressonancia|rm"],
    US: ["ultrassonografia|ultrassom|usg|ecografia|doppler"],
    XR: ["radiografia|defecografia|cinedefecograma|raio x|raios x|raio-x|rx"],
    MG: ["mamografia"],
    MX: ["mamografia"],
  },
  titleRegionTokens: {
    head: ["cranio", "encefalo", "intracrani"],
    chest: ["torax"],
    abdomen: ["abdome", "abdominal"],
    spine: ["coluna", "lombar", "cervical", "toracica"],
    urinary: ["vias urinarias", "uro", "urinario"],
    pelvis: ["pelve", "pelv"],
    breast: ["mama", "mamografia"],
    thyroid: ["tireoide"],
    neck: ["pescoco", "cervical"],
    unknown: [],
  },
  coverage: {
    "CT:head": ["ventricul", "sulcos", "cisternas", "parenquima", "calota", "fossa posterior", "linha media", "orbit", "seios paranasal"],
    "CT:chest": ["pulmon", "traque", "mediast", "linfonod", "pleura", "coracao", "pericard", "aorta", "esofago"],
    "CT:abdomen": ["figado", "vesicula", "vias biliares", "pancreas", "baco", "adren", "rins", "alcas", "aorta", "linfonod"],
    "CT:pelvis": ["bexiga", "reto", "linfonod", "osso", "musculatura", "gordura"],
    "CT:urinary": ["rins", "ureter", "bexiga"],
    "CT:spine": ["alinhamento", "vertebra", "canal", "partes moles"],
    "MRI:head": ["ventricul", "sulcos", "parenquima", "sinal", "difusao", "fossa posterior", "linha media"],
    "MRI:abdomen": ["figado", "vias biliares", "pancreas", "baco", "rins", "adren"],
    "MRI:spine": ["alinhamento", "vertebra", "disco", "canal", "medula", "forame"],
    "MRI:pelvis": ["bexiga", "reto", "mesoreto", "linfonod", "musculatura"],
    "US:abdomen": ["figado", "vesicula", "vias biliares", "pancreas", "baco", "rins", "aorta"],
    "US:pelvis": ["bexiga", "endometrio", "douglas"],
    "US:urinary": ["rins", "bexiga"],
    "US:thyroid": ["lobo direito", "lobo esquerdo", "istmo", "nodulo"],
    "US:breast": ["nodulo", "pele", "axilar"],
    "MG:breast": ["nodulo", "pele", "axilar"],
    "XR:chest": ["area cardiac", "mediast", "hilos", "parenquima", "seios costofren", "partes moles"],
  },
  negationPatterns: [
    /\bsem evidencia de\b/,
    /\bausencia de\b/,
    /\bnao ha\b/,
    /\bnao foram\b/,
    /\bsem sinais de\b/,
    /\bnao se identifica\b/,
    /\bnao se observa\b/,
    /\bnao se detecta\b/,
    /\bafastado\b/,
    /\bexcluido\b/,
  ],
  preservationPatterns: [
    { id: "steatosis", input: /esteatose/gi, report: /esteatose/gi, label: "esteatose" },
    { id: "gallstone", input: /c[aá]lculo\s+(?:na\s+)?ves[ií]cula|colecistolit/i, report: /c[aá]lculo\s+(?:na\s+)?ves[ií]cula|colecistolit/i, label: "cálculo vesicular" },
    { id: "sludge", input: /lama\s+biliar/i, report: /lama\s+biliar/i, label: "lama biliar" },
    { id: "renalCyst", input: /cisto\s+renal/i, report: /cisto\s+renal/i, label: "cisto renal" },
    { id: "pleuralEffusion", input: /derrame\s+pleural/i, report: /derrame\s+pleural/i, label: "derrame pleural" },
    { id: "cvc", input: /\bCVC\b|cateter\s+venoso\s+central/i, report: /\bCVC\b|cateter\s+venoso\s+central/i, label: "CVC" },
    { id: "discHernia", input: /h[eé]rnia\s+discal/i, report: /h[eé]rnia\s+discal/i, label: "hérnia discal" },
    { id: "foraminalStenosis", input: /estenose\s+foraminal/i, report: /estenose\s+foraminal/i, label: "estenose foraminal" },
    { id: "subduralHematoma", input: /hematoma\s+subdural/i, report: /hematoma\s+subdural/i, label: "hematoma subdural" },
    { id: "hydronephrosis", input: /hidronefrose/i, report: /hidronefrose/i, label: "hidronefrose" },
    { id: "umbilicalHernia", input: /h[eé]rnia\s+umbilical/i, report: /h[eé]rnia\s+umbilical/i, label: "hérnia umbilical" },
    { id: "calculus", input: /c[aá]lculo/i, report: /c[aá]lculo/i, label: "cálculo" },
    { id: "normal", input: /^normal$/i, report: /sem\s+alteracoes|sem\s+alterações|dentro\s+dos\s+limites|sem\s+achados/i, label: "normalidade" }
  ],
  regionMap: (exam) => {
    if (/tireoid/.test(exam)) return "thyroid";
    if (/mama|mamograf/.test(exam)) return "breast";
    if (/vias\s+urin|uro|urinari/.test(exam)) return "urinary";
    if (/pelv/.test(exam)) return "pelvis";
    if (/crani|encefal|cerebr|cabeca/.test(exam)) return "head";
    if (/coluna|lombar|cervical/.test(exam)) return "spine";
    if (/torax|torac|pulm/.test(exam)) return "chest";
    if (/abd/.test(exam)) return "abdomen";
    if (/pescoco/.test(exam)) return "neck";
    return "unknown";
  },
  buildSystemPrompt(meta: ExamMeta): string {
    const maybeTechnique = meta.modality === "US" ? "Do not include a Técnica section for ultrasound." : "Use Técnica, Análise, Conclusão sections.";
    const contrastRule = meta.contrast
      ? "Contrast exam: enhancement language is allowed only if supported by the findings."
      : "Non-contrast exam: do not mention enhancement, phases, washout, or contrast uptake.";
    return [
      "You are laudAI, a senior radiologist writing in Brazilian Portuguese.",
      "Output only HTML. Allowed tags: <center>, <b>, <br>.",
      "Start with <center><b>FULL EXAM TITLE</b></center>.",
      "Use <br><br> only between sections. Use single <br> within sections.",
      maybeTechnique,
      contrastRule,
      "Never hallucinate findings.",
      "Conclusion must contain only diagnoses and key impressions, not measurements or boilerplate normal statements.",
      "Forbidden openers: Presença de, Observa-se, Nota-se, Identifica-se, Evidencia-se, Visualiza-se, Detecta-se.",
      "Use PT-BR radiology terminology: atenuação (CT), sinal (MRI), ecogenicidade (US), pérvia, linfonodomegalia, endovenoso.",
    ].join("\n");
  },
  judgeInstructions: "Review in Brazilian Portuguese. Be adversarial. Verify every material claim against the findings. Penalize hallucinations, omitted findings, wrong modality terminology, wrong sectioning, and conclusion content drift."
};
