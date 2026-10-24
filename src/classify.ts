import { normalizeLoose } from "./normalize.js";
import type { ExamMeta, LocaleKey, Modality } from "./types.js";
import { getLocale } from "./locales/index.js";

/** Modality named in a (normalized) exam string or title, or null when none is. */
export function detectModality(normalized: string): Modality | null {
  if (/\b(rm|rmn|mri|ressonancia|magnetic resonance)\b|\b\w+rressonancia\b|\bangio-?rm\b/.test(normalized)) return "MRI";
  if (/\b(us|usg|ultra|ultrassom|ultrassonografia|ultrassonografico|ecografia|ecodoppler|doppler|ultrasound|ultrasonography|sonography|sonogram)\b/.test(normalized)) return "US";
  if (/\b(rx|x-ray|xray|radiograph|radiographs|radiography|radiografia|radiografias)\b|\braios?[\s-]?x\b/.test(normalized)) return "XR";
  if (/\b(mamografia digital|digital mammography|mx)\b/.test(normalized)) return "MX";
  if (/\b(mamografia|mammography|mammogram|mg)\b/.test(normalized)) return "MG";
  if (/\b(tc|tcar|ct|cta|tomografia|angiotomografia|angio-?tc|angiotc|urotomografia|uro-?tc|computed tomography)\b|\w+tomografia\b/.test(normalized)) return "CT";
  return null;
}

/**
 * The exam string decides; when it names no modality (a user template called
 * "PUNHO", or no exam at all) the first sentence of the dictation may
 * ("Colangiorressonância magnética, ..."). Still nothing: CT as before, flagged
 * as not known so the title check does not demand a modality nobody stated.
 */
function deriveModality(normalizedExam: string, normalizedFindings: string): { modality: Modality; known: boolean } {
  const fromExam = detectModality(normalizedExam);
  if (fromExam) return { modality: fromExam, known: true };
  const lead = normalizedFindings.split(/(?<!\d)\.(?!\d)|[;\n]/)[0] ?? "";
  const fromLead = detectModality(lead);
  return fromLead ? { modality: fromLead, known: true } : { modality: "CT", known: false };
}

function deriveContrast(normalizedExam: string, normalizedFindings: string): boolean {
  // An angiotomography / CT angiography / CT urography is a contrast study by
  // definition, even when the exam name does not say "com contraste".
  const examIndicatesContrast = /\b(cc|c\/c|com contraste|contrastado|with contrast|contrast-enhanced|contrast enhanced)\b/.test(normalizedExam)
    || /\b(?:angiotomografia|angio-?tc|angiotc|ct angiograph\w*|cta|computed tomography angiograph\w*|ct pulmonary angiograph\w*|urotomografia|uro-?tc|ct urograph\w*)\b/.test(normalizedExam);
  // Strong, unambiguous contrast-administration cues — locale-SYMMETRIC (pt-BR and
  // en-US). The findings branch was previously pt-BR-only, so en-US enhancement /
  // phase language did not register contrast (false C01 penalty on correct reports).
  const strongCue =
    /\b(?:meio de contraste|com contraste|contrastad[oa]|contraste (?:administrad\w*|endovenos\w*|injetad\w*|venoso|iodado|intravenos\w*|ev)|pos[\s-]?contraste|post[\s-]?contrast|intravenous contrast|gadol[ií]nio|gadolineo|fase arterial|fase (?:porto[\s-]?)?venosa|fase portal|fase tardia|arterial phase|portal[\s-]?venous phase|portal phase|venous phase|delayed phase|washout|wash[\s-]out)\b/.test(normalizedFindings);
  // Ambiguous cues count ONLY when not negated: "ausência de realce" / "no
  // enhancement" describes a NON-contrast study and must not flip contrast=true
  // (which would silently disable the C01 hallucination gate).
  const ambiguousCue = /\b(?:realce|impregnacao|contrastacao|enhancement|enhancing|hyperenhanc\w*)\b/.test(normalizedFindings);
  const negatedAmbiguous = /\b(?:sem|ausencia de|nao (?:ha|apresenta|demonstra|se observa)|no|without|absent|negative for)\b[^.;]{0,24}\b(?:realce|impregnacao|contrastacao|enhancement|enhancing)\b/.test(normalizedFindings);
  const findingsIndicateContrast = strongCue || (ambiguousCue && !negatedAmbiguous);
  return examIndicatesContrast || findingsIndicateContrast;
}

function buildExpectedTitleTokens(modality: Modality, region: ExamMeta["region"], localeKey: LocaleKey): { modalityTokens: string[]; regionTokens: string[] } {
  const locale = getLocale(localeKey);
  return {
    modalityTokens: locale.titleModalityTokens[modality],
    regionTokens: locale.titleRegionTokens[region] ?? [],
  };
}

function isNormalStudy(findings: string, localeKey: LocaleKey): boolean {
  const locale = getLocale(localeKey);
  return locale.normalPatterns.some((pattern) => pattern.test(findings.trim()));
}

export function deriveExamMeta(examInput: string, findingsInput: string, localeKey: LocaleKey): ExamMeta {
  const locale = getLocale(localeKey);
  const normalizedExam = normalizeLoose(examInput);
  const normalizedFindings = normalizeLoose(findingsInput);
  const { modality, known: modalityKnown } = deriveModality(normalizedExam, normalizedFindings);
  const contrast = deriveContrast(normalizedExam, normalizedFindings);
  const region = locale.regionMap(normalizedExam);
  const { modalityTokens, regionTokens } = buildExpectedTitleTokens(modality, region, localeKey);

  return {
    modality,
    modalityKnown,
    contrast,
    region,
    normalizedExam,
    normalizedFindings,
    abnormalStudy: !isNormalStudy(findingsInput, localeKey),
    expectedTitleTokens: modalityTokens,
    expectedRegionTokens: regionTokens,
  };
}
