import { normalizeLoose } from "./normalize.js";
import type { ExamMeta, LocaleKey, Modality } from "./types.js";
import { getLocale } from "./locales/index.js";

function deriveModality(normalizedExam: string): Modality {
  if (/\b(rm|mri|ressonancia|magnetic resonance)\b/.test(normalizedExam)) return "MRI";
  if (/\b(us|usg|ultra|ecografia|ultrasound)\b/.test(normalizedExam)) return "US";
  if (/\b(rx|x-ray|radiograph)\b/.test(normalizedExam)) return "XR";
  if (/\b(mamografia digital|digital mammography|mx)\b/.test(normalizedExam)) return "MX";
  if (/\b(mamografia|mammography|mammogram|mg)\b/.test(normalizedExam)) return "MG";
  return "CT";
}

function deriveContrast(normalizedExam: string, normalizedFindings: string): boolean {
  const examIndicatesContrast = /\b(cc|c\/c|com contraste|contrastado|with contrast|contrast-enhanced|contrast enhanced)\b/.test(normalizedExam);
  const findingsIndicateContrast = /\b(?:meio de contraste|contraste administrado|pos contraste|gadol[ií]nio|gadolinio|realce|impregnacao|wash out|fase arterial|fase portal|fase venosa|fase tardia)\b/.test(normalizedFindings);
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
  const modality = deriveModality(normalizedExam);
  const contrast = deriveContrast(normalizedExam, normalizedFindings);
  const region = locale.regionMap(normalizedExam);
  const { modalityTokens, regionTokens } = buildExpectedTitleTokens(modality, region, localeKey);

  return {
    modality,
    contrast,
    region,
    normalizedExam,
    normalizedFindings,
    abnormalStudy: !isNormalStudy(findingsInput, localeKey),
    expectedTitleTokens: modalityTokens,
    expectedRegionTokens: regionTokens,
  };
}
