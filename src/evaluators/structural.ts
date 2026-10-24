/**
 * Structural compliance evaluator.
 * Contains the original checks.ts logic reorganized as a clear structural compliance layer.
 * These are format/structure checks, not clinical content checks.
 */

import { getLocale } from "../locales/index.js";
import { hasNegationCue, isFindingNegated } from "../extract.js";
import { describeFabricated, describeSourceCriticalOutcomes, evaluateSourceCriticals } from "./source-critical.js";
import { describeMissingFindings, evaluateSourceFindings } from "./source-findings.js";
import { escapeRegExp, extractLateralityTokens, extractLevelTokens, extractMeasurements, matchAll, normalizeLoose, stripTags } from "../normalize.js";
import type { Check, ExamMeta, LocaleKey, Severity } from "../types.js";

/** Copy a regex without the g flag so .test() never sees stale lastIndex state. */
function nonGlobal(rx: RegExp): RegExp {
  return rx.flags.includes("g") ? new RegExp(rx.source, rx.flags.replace("g", "")) : rx;
}

// Function-word inventories for report-language detection. Radiology pt-BR and
// en-US share Latin clinical roots, so detection leans on closed-class words
// (articles, prepositions) plus locale-exclusive section labels, never on
// clinical vocabulary.
const PT_FUNCTION_WORDS = /\b(?:de|da|do|das|dos|sem|com|nao|para|em|os|as|uma|seios|analise|conclusao|achados|ausencia|presenca|aspecto|demais)\b/g;
const EN_FUNCTION_WORDS = /\b(?:the|of|with|without|no|in|is|are|and|there|within|findings|impression|technique|unremarkable|normal limits)\b/g;
// Morphology + bare organ names. Telegraphic radiology prose (noun phrases, no
// articles/verbs) emits ~zero function words, so function-word counting collapses
// and an English report can slip through a pt-BR suite. These locale-exclusive
// content signals (PT -ção/-ões/-ência/-ose endings + PT organ names vs English
// -tion/-osis endings + English organ names) keep detection alive on terse prose.
// Text is already accent-folded/lowercased, so PT "-ção" appears as "-cao".
const PT_CONTENT_WORDS = /\b\w{4,}(?:cao|coes|oes|encia|ose|agem)\b|\b(?:figado|rim|rins|baco|bexiga|cranio|torax|abdome|abdomen|coluna|utero|ovario|ovarios|prostata|mama|mamas|pulmoes|rins|rincao)\b/g;
const EN_CONTENT_WORDS = /\b\w{4,}(?:tion|osis|emia)\b|\b(?:liver|kidney|kidneys|spleen|lung|lungs|chest|spine|brain|breast|breasts|bladder|uterus|ovary|ovaries|prostate|gallbladder)\b/g;

function detectReportLanguageMismatch(
  normalizedText: string,
  localeKey: LocaleKey,
): { mismatch: boolean; detected: string; evidence: string } {
  const ptHits = (normalizedText.match(PT_FUNCTION_WORDS)?.length ?? 0) + (normalizedText.match(PT_CONTENT_WORDS)?.length ?? 0);
  const enHits = (normalizedText.match(EN_FUNCTION_WORDS)?.length ?? 0) + (normalizedText.match(EN_CONTENT_WORDS)?.length ?? 0);
  const expected = localeKey === "pt-BR" ? ptHits : enHits;
  const other = localeKey === "pt-BR" ? enHits : ptHits;
  // Mismatch only when the opposite locale clearly dominates: at least 4 signals
  // AND at least double the expected-locale signal (so a stray cognate cannot flip
  // a genuine same-locale report).
  const mismatch = other >= 4 && other >= expected * 2;
  return {
    mismatch,
    detected: ptHits >= enHits ? "pt-BR" : "en-US",
    evidence: `pt signals: ${ptHits}, en signals: ${enHits}`,
  };
}

type CompiledLocaleRegexes = {
  preservation: Array<{ label: string; input: RegExp; report: RegExp }>;
  forbiddenOpeners: RegExp[];
  umbrellaTerms: RegExp;
  bannedPhrases: RegExp[];
};

// Precompiled per-locale regex cache. Locale specs expose shared (sometimes
// g-flagged) regexes; compiling non-g copies once per locale avoids both the
// per-call new RegExp(...) cost and any lastIndex statefulness.
const _localeRegexCache = new Map<LocaleKey, CompiledLocaleRegexes>();

function getCompiledLocaleRegexes(localeKey: LocaleKey, locale: ReturnType<typeof getLocale>): CompiledLocaleRegexes {
  let cached = _localeRegexCache.get(localeKey);
  if (!cached) {
    cached = {
      preservation: locale.preservationPatterns.map((pattern) => ({
        label: pattern.label,
        input: nonGlobal(pattern.input),
        report: nonGlobal(pattern.report),
      })),
      forbiddenOpeners: locale.forbiddenOpeners.map((opener) => new RegExp(`(?:<br>|<\\/b>|\\.)\\s*${escapeRegExp(opener)}`, "i")),
      umbrellaTerms: nonGlobal(locale.umbrellaTerms),
      bannedPhrases: locale.bannedPhrases.map(nonGlobal),
    };
    _localeRegexCache.set(localeKey, cached);
  }
  return cached;
}

const HEDGE_RX = /a esclarecer|nao se pode excluir|nao e possivel excluir|a depender de|a criterio|correlacionar? clinica|nao podemos afastar|sugerir? complementac|avaliar? possibilidade|convem correlacionar/i;

function getTitle(html: string): string {
  const centered = html.replace(/^(?:\s|<br\s*\/?>)*/i, "").match(/<center>\s*<b>([^<]+)(?:<\/b>)?\s*<\/center>/i)?.[1]?.trim();
  if (centered) return centered;

  const plain = stripTags(html.replace(/<br\s*\/?>/gi, "\n")).replace(/\s+/g, " ").trim();
  const sectionMatch = /\b(?:T[ée]cnica|An[áa]lise|Achados|Conclus[ãa]o|Impress[ãa]o|Technique|Findings|Analysis|Impression|Conclusion)\s*:?/i.exec(plain);
  const candidate = (sectionMatch ? plain.slice(0, sectionMatch.index) : plain).trim();
  return candidate.length <= 180 ? candidate : "";
}

function normalizeMeasurementValue(value: string): string {
  return normalizeLoose(value)
    .replace(/,/g, ".")
    .replace(/\s+/g, "")
    .replace(/(\d+)\.0+(?=\D|$)/g, "$1");
}

function measurementPresent(reportText: string, measurement: string): boolean {
  const normalizedReport = normalizeMeasurementValue(reportText);
  const normalizedMeasurement = normalizeMeasurementValue(measurement);
  if (normalizedMeasurement.length === 0) return true;
  // Exact-boundary match, NOT naive substring. A digit or decimal point
  // immediately to the left means a different number: gold "2cm" must not match
  // inside "12cm", and "1.5cm" must not match inside "11.5cm". A tenfold size
  // error is a dangerous measurement mistake, not a preserved measurement.
  return new RegExp(`(?<![\\d.])${escapeRegExp(normalizedMeasurement)}`).test(normalizedReport);
}

// Section-content extraction patterns keyed by the section regex source (a
// handful of locale section regexes), so they compile once.
const _sectionContentRegexCache = new Map<string, RegExp>();

function getSectionContent(html: string, rx: RegExp): string {
  let pattern = _sectionContentRegexCache.get(rx.source);
  if (!pattern) {
    pattern = new RegExp(`<b>(?:${rx.source})[^<]*<\\/b>([\\s\\S]*?)(?:<br><br><b>|$)`, "i");
    _sectionContentRegexCache.set(rx.source, pattern);
  }
  return pattern.exec(html)?.[1] ?? "";
}

function firstLineFromSection(sectionHtml: string): string {
  return (
    sectionHtml
      .split("<br>")
      .map((line) => stripTags(line).trim())
      .find(Boolean) ?? ""
  ).trim();
}

function extractSectionOrder(html: string, locale: ReturnType<typeof getLocale>): string[] {
  const labels = Array.from(html.matchAll(/<b>([^<]+)<\/b>/gi)).map((m) => m[1].trim());
  return labels.filter((label) => locale.sections.analysis.test(label) || locale.sections.conclusion.test(label) || locale.sections.technique.test(label));
}

function extractFindingsPreservation(patterns: ReturnType<typeof getLocale>["preservationPatterns"], findingsInput: string, reportHtml: string, localeKey: LocaleKey): { expected: string[]; missing: string[]; ratio: number } {
  const expected: string[] = [];
  const missing: string[] = [];
  const sentences = findingsInput.split(/(?<!\d)\.(?!\d)|[;\n]/).map((x) => x.trim()).filter(Boolean);

  for (const pattern of patterns) {
    const inputRx = new RegExp(pattern.input.source, pattern.input.flags.replace("g", ""));
    const reportRx = new RegExp(pattern.report.source, pattern.report.flags);
    // A pertinent negative ("Sem derrame pleural") is not a finding to preserve
    // verbatim: "espaços pleurais livres" says the same thing. Only affirmed
    // input mentions are required here; denials of criticals are C09's job.
    const affirmed = sentences.some((sentence) => {
      const m = inputRx.exec(sentence);
      return m !== null && !isFindingNegated(sentence, m[0], localeKey);
    });
    if (affirmed) {
      expected.push(pattern.label);
      const singularRx = new RegExp(pattern.report.source, pattern.report.flags);
      if (!reportRx.test(reportHtml) && !singularRx.test(singularize(reportHtml))) missing.push(pattern.label);
    }
  }

  const uniqueExpected = Array.from(new Set(expected));
  const uniqueMissing = Array.from(new Set(missing));
  const ratio = uniqueExpected.length === 0 ? 1 : (uniqueExpected.length - uniqueMissing.length) / uniqueExpected.length;
  return { expected: uniqueExpected, missing: uniqueMissing, ratio };
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// A title still names the exam when a modality word carries a spelling variant or a
// one-letter typo ("ULTRASONOGRAFIA", "RESONÂNCIA", "ANGIOTSOMOGRAFIA"). A wrong
// exam or region still fails: the tolerance is one edit for words of 8+ letters.
function isTitleMatch(title: string, tokens: string[]): boolean {
  const n = normalizeLoose(title);
  const words = n.split(/[^a-z0-9]+/).filter((w) => w.length >= 8);
  return tokens.every((token) => token.split("|").some((variant) => {
    const v = normalizeLoose(variant);
    if (n.includes(v)) return true;
    if (v.length < 8 || /\s/.test(v)) return false;
    return words.some((w) => editDistance(w.slice(0, v.length + 1), v) <= 1 || editDistance(w, v) <= 1);
  }));
}

// Plural-insensitive matching for preserved-finding labels ("hérnias discais" keeps
// "hérnia discal"; "pleural effusions" keeps "pleural effusion").
function singularize(text: string): string {
  return text
    .replace(/([a-zà-ú]{2,})ais\b/gi, "$1al")
    .replace(/([a-zà-ú]{2,})(?:ões|ãos|ães)\b/gi, "$1ão")
    .replace(/([a-zà-ú]{2,})eis\b/gi, "$1el")
    .replace(/([a-zà-ú]{2,})ies\b/gi, "$1y")
    .replace(/([a-zà-ú]{3,}[^s\W])s\b/gi, "$1");
}

// A structure named another standard way is covered ("estruturas ósseas" covers bone,
// "silhueta cardíaca" the heart, "cerebelo" the posterior fossa).
const COVERAGE_SYNONYMS: Record<string, string[]> = {
  "osso": ["osse", "ossos", "osteo", "arcabouco", "calota", "vertebra"],
  "calota": ["cranian", "calvari", "osse", "ossos do cranio"],
  "area cardiac": ["silhueta cardi", "cardiomediastin", "coracao", "cardiac"],
  "coracao": ["cardiac", "silhueta cardi", "cardiomediastin", "camaras cardi"],
  "hilos": ["hilar", "hilo"],
  "parenquima": ["campos pulmonares", "pulmoes", "parenquim"],
  "partes moles": ["tecidos moles", "planos moles", "partes mol"],
  "musculatura": ["muscul", "partes moles", "paravertebra"],
  "seios paranasal": ["seios da face", "paranasa", "seios maxilares", "cavidades paranasais"],
  "orbit": ["orbita"],
  "fossa posterior": ["cerebel", "tronco encefalico", "quarto ventriculo", "infratentorial"],
  "esofago": ["esofag"],
  "traque": ["vias aereas", "traque"],
  "seios costofren": ["costofren", "costo-fren", "recessos pleurais"],
  "gordura": ["gordur", "adipos"],
  "linfonod": ["linfonod", "linfadenomegal", "adenomegal"],
  "difusao": ["difus", "dwi"],
  "bone": ["osseous", "skeletal", "bony", "osse"],
  "heart": ["cardiac", "cardiomediastinal"],
  "hila": ["hilar", "hilum"],
  "soft tissue": ["soft-tissue", "soft tissues"],
  "posterior fossa": ["cerebell", "brainstem", "fourth ventricle", "infratentorial"],
  "paranasal": ["sinuses"],
};

function hasAllowedTagsOnly(html: string): boolean {
  return matchAll(/<(?!\/?(?:center|b|br)\s*\/?>)[a-z][^>]*>/gi, html).length === 0;
}

function ck(checks: Check[], dim: Check["dim"], id: string, name: string, severity: Severity, passed: boolean, evidence: string): void {
  checks.push({ dim, id, name, severity, passed, evidence });
}

/**
 * Run structural compliance checks on a report.
 * These checks verify formatting, structure, and terminology compliance --
 * they are NOT clinical content evaluations.
 */
export function runStructuralChecks(html: string, meta: ExamMeta, findingsInput: string, localeKey: LocaleKey): Check[] {
  const locale = getLocale(localeKey);
  const checks: Check[] = [];
  const analysis = getSectionContent(html, locale.sections.analysis);
  const conclusion = getSectionContent(html, locale.sections.conclusion);
  const title = getTitle(html);
  // Words between the title and the conclusion header: the findings body, whatever
  // headers (organ names, none) the report uses.
  const bodyWords = (() => {
    const afterTitle = html.replace(/^[\s\S]*?<\/center>/i, "");
    const m = new RegExp(`<b>(?:${locale.sections.conclusion.source})`, "i").exec(afterTitle);
    const body = m ? afterTitle.slice(0, m.index) : afterTitle;
    const noTechnique = body.replace(new RegExp(`<b>(?:${locale.sections.technique.source})[^<]*<\\/b>[\\s\\S]*?(?=<br><br><b>|$)`, "i"), "");
    return stripTags(noTechnique.replace(/<br>/g, " ")).trim().split(/\s+/).filter(Boolean).length;
  })();
  const normalizedHtml = normalizeLoose(stripTags(html));
  const preservation = extractFindingsPreservation(locale.preservationPatterns, findingsInput, html, localeKey);
  const laterality = extractLateralityTokens(findingsInput);
  const levels = extractLevelTokens(findingsInput);
  const measures = extractMeasurements(findingsInput);

  // CRIT - Structural critical checks
  if (!meta.contrast) {
    const hits = matchAll(locale.contrastTerms, html);
    ck(checks, "CRIT", "C01", "No contrast language in non-contrast exam", "critical", hits.length === 0, hits.length ? hits.join(", ") : "ok");
  }
  // BUG 6 FIX: Only check C02 for abnormal studies. Normal studies legitimately use
  // umbrella phrases like "demais estruturas sem alteracoes".
  if (meta.abnormalStudy) {
    // Reset lastIndex before each .test() call on global regexes to avoid stale state
    locale.umbrellaTerms.lastIndex = 0;
    const hasUmbrella = locale.umbrellaTerms.test(conclusion);
    ck(checks, "CRIT", "C02", "No umbrella phrase in conclusion", "major", !hasUmbrella, hasUmbrella ? "umbrella phrase in conclusion" : "ok");
  }
  for (let i = 0; i < locale.bannedPhrases.length; i += 1) {
    const rx = locale.bannedPhrases[i];
    // Reset lastIndex before each .test() call on global regexes to avoid stale state
    rx.lastIndex = 0;
    const hasBanned = rx.test(html);
    ck(checks, "CRIT", `C03${i}`, "No banned phrase", "critical", !hasBanned, hasBanned ? "found banned phrase" : "ok");
  }
  const foreignMarkup = matchAll(/^#{1,3}\s|^\*\*|```|<\/?(?:p|div|span|h[1-6]|ul|ol|li|em|strong|a)\b/gm, html);
  ck(checks, "CRIT", "C04", "No markdown or foreign HTML/XML", "critical", foreignMarkup.length === 0, foreignMarkup.length ? `found: ${Array.from(new Set(foreignMarkup.map((m) => m.trim()))).slice(0, 4).join(" ")}` : "ok");
  ck(checks, "CRIT", "C05", "No measurements in conclusion", "minor", matchAll(/\b\d+(?:[\.,]\d+)?\s*(?:cm|mm)\b|\b\d+\s*x\s*\d+\b/gi, conclusion).length === 0, "ok");
  if (meta.abnormalStudy) {
    const firstConclusionLine = firstLineFromSection(conclusion);
    const isNormalLead = locale.normalPatterns.some((pattern) => pattern.test(firstConclusionLine));
    ck(checks, "CRIT", "C06", "Abnormal study cannot lead with normal conclusion", "minor", !isNormalLead, isNormalLead ? firstConclusionLine : "ok");
  }
  ck(checks, "CRIT", "C07", "Input findings preserved above minimum threshold", "critical", preservation.ratio >= 0.75, preservation.missing.length ? `missing: ${preservation.missing.join(", ")}` : "ok");

  if (meta.abnormalStudy) {
    const boilerplate = /demais estruturas sem alterac|demais orgaos sem|restante do exame sem alterac|nada mais digno de nota/i;
    ck(checks, "CRIT", "C08", "No boilerplate filler in pathological conclusion", "major", !boilerplate.test(stripTags(conclusion)), boilerplate.test(stripTags(conclusion)) ? "boilerplate in pathological conclusion" : "ok");
  }

  // C09 / C10 (v3.11.0): source-anchored critical gate. The input findings are
  // the evidence; every critical they affirm must survive into the report with
  // the same polarity and side, and the report may not affirm a critical the
  // input does not back. Emitted only when there is something to check, so cases
  // without criticals keep their v3.10 criterion counts. See
  // evaluators/source-critical.ts for the rationale and the conservative rules.
  const sourceCritical = evaluateSourceCriticals(html, findingsInput, localeKey);
  if (sourceCritical.anchors.length > 0) {
    ck(
      checks,
      "CRIT",
      "C09",
      "Input critical findings preserved (presence, polarity, laterality)",
      "critical",
      sourceCritical.missed.length === 0,
      describeSourceCriticalOutcomes(sourceCritical.outcomes),
    );
  }
  if (sourceCritical.reportAffirmedCount > 0 || sourceCritical.fabricated.length > 0) {
    ck(
      checks,
      "CRIT",
      "C10",
      "No critical finding beyond the input (fabrication / wrong side)",
      "critical",
      sourceCritical.fabricated.length === 0,
      describeFabricated(sourceCritical.fabricated),
    );
  }

  // Q16 / Q17 (v3.11.0): abnormal input findings must be reflected; a report that
  // reflects none of them on an abnormal study is unsupported normalcy. See
  // evaluators/source-findings.ts (paraphrase-tolerant, polarity-aware).
  const sourceFindings = evaluateSourceFindings(html, findingsInput, localeKey);
  if (sourceFindings.clauses.length > 0) {
    if (sourceFindings.missing.length === 0) {
      ck(checks, "QUAL", "Q16", "Abnormal input findings reflected in the report", "major", true, `${sourceFindings.clauses.length} reflected`);
    } else {
      // One failing check per missing finding: two omissions cost more than one.
      sourceFindings.missing.forEach((m, i) => {
        ck(checks, "QUAL", `Q16-${i + 1}`, "Abnormal input finding reflected in the report", "major", false, describeMissingFindings([m]));
      });
    }
    ck(
      checks,
      "QUAL",
      "Q17",
      "No unsupported normalcy (abnormal input, report reflects none of it)",
      "critical",
      !sourceFindings.unsupportedNormalcy,
      sourceFindings.unsupportedNormalcy ? `none of ${sourceFindings.clauses.length} abnormal input finding(s) reflected` : "ok",
    );
  }

  // QUAL - Structural quality checks
  ck(checks, "QUAL", "Q01", "Has bold title", "minor", /^(?:\s|<br\s*\/?>)*<center><b>/i.test(html), html.slice(0, 40));
  // Title abbreviation is a style preference, not a safety issue: standard
  // radiology titles routinely begin with the modality abbreviation ("TC DE
  // CRÂNIO", "CT ANGIOGRAPHY"). Scored as a minor deduction, never a gate.
  ck(checks, "QUAL", "Q02", "Title spells out modality", "minor", !locale.titleAbbrev.some((rx) => rx.test(title)), title || "missing title");
  // Whitespace/line-break preferences are not clinical safety failures. Keep
  // them visible for rendering polish, but never let them become HealthBench-
  // style arbitrary gates.
  ck(checks, "QUAL", "Q03", "No <br><br> inside analysis", "minor", !analysis.includes("<br><br>"), analysis.includes("<br><br>") ? "blank line inside analysis" : "ok");
  ck(checks, "QUAL", "Q04", "No <br><br> inside conclusion", "minor", !conclusion.includes("<br><br>"), conclusion.includes("<br><br>") ? "blank line inside conclusion" : "ok");
  ck(checks, "QUAL", "Q05", "Has section separators", "major", /<br><br><b>/i.test(html), /<br><br><b>/i.test(html) ? "ok" : "no <br><br><b> section separator");
  ck(checks, "QUAL", "Q06", "Only allowed tags", "major", hasAllowedTagsOnly(html), hasAllowedTagsOnly(html) ? "ok" : "tags outside <center>, <b>, <br>");
  const placeholders = matchAll(/\[[A-Z_]{2,}\]|_{3,}|(?<!\w)XXX(?!\w)|####/g, html);
  ck(checks, "QUAL", "Q07", "No placeholders", "critical", placeholders.length === 0, placeholders.length ? `found: ${placeholders.slice(0, 3).join(" ")}` : "ok");
  const analysisPresent = locale.sections.analysis.test(html) || bodyWords >= 15;
  ck(checks, "QUAL", "Q08", "Analysis section present", "critical", analysisPresent, locale.sections.analysis.test(html) ? "ok" : analysisPresent ? "findings described without a section header" : `missing "${locale.sectionLabels.analysis}" section`);
  if (meta.modality === "US") {
    const hasTechniqueSection = nonGlobal(locale.sections.technique).test(html);
    ck(
      checks,
      "QUAL",
      "Q09",
      "Ultrasound technique section is optional and non-gating",
      "minor",
      true,
      hasTechniqueSection ? "technique section present" : "technique section absent",
    );
  }
  const analysisLongLines = analysis.split("<br>").map((l) => stripTags(l).trim()).filter((l) => l.length > 25);
  const conclusionText = normalizeLoose(stripTags(conclusion));
  const copiedLines = analysisLongLines.filter((l) => conclusionText.includes(normalizeLoose(l).slice(0, 35)));
  ck(checks, "QUAL", "Q10", "Conclusion is synthesis not copy-paste of analysis", "minor", copiedLines.length <= 1, copiedLines.length > 1 ? `${copiedLines.length} lines copied` : "ok");

  ck(checks, "QUAL", "Q11", "Conclusion section present and non-empty", "critical", conclusion.length > 0 && stripTags(conclusion).trim().length > 10, conclusion.length === 0 ? "missing" : `${stripTags(conclusion).trim().length} chars`);

  const analysisWordCount = Math.max(stripTags(analysis).trim().split(/\s+/).filter(Boolean).length, locale.sections.analysis.test(html) ? 0 : bodyWords);
  // A normal study can be described in a few words; only a near-empty analysis is a real gap.
  ck(checks, "QUAL", "Q12", "Analysis has substantive content", analysisWordCount < 5 ? "major" : "minor", analysisWordCount >= 15, `${analysisWordCount} words`);

  // TERM - Report language must match the suite locale. A Portuguese report on the
  // en-US suite (or vice versa) previously sailed through TERM at 100% while CRIT/QUAL
  // emitted misleading "finding not found" evidence; this check names the root cause.
  const languageVerdict = detectReportLanguageMismatch(normalizedHtml, localeKey);
  ck(
    checks,
    "TERM",
    "T-LANG",
    "Report language matches suite locale",
    "critical",
    !languageVerdict.mismatch,
    languageVerdict.mismatch
      ? `report appears to be ${languageVerdict.detected} on a ${localeKey} suite (${languageVerdict.evidence})`
      : "ok",
  );

  // TERM - Terminology structural checks.
  // Forbidden-term and modality-vocab patterns are matched ACCENT-INSENSITIVELY:
  // every other comparison in the engine folds diacritics (normalizeLoose), so an
  // accent-stripped output (e.g. "espessacao", "hipoecoico") must be caught the
  // same as the accented form. Fold both the text and the pattern source.
  const foldDiacritics = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const foldedHtml = foldDiacritics(html);
  const foldedMatch = (rx: RegExp) => matchAll(new RegExp(foldDiacritics(rx.source), rx.flags), foldedHtml);
  locale.forbiddenTerms.forEach(([rx, label], index) => {
    const hits = foldedMatch(rx);
    ck(checks, "TERM", `T${String(index).padStart(2, "0")}`, label, "minor", hits.length === 0, hits.length ? hits[0] : "ok");
  });
  locale.forbiddenOpeners.forEach((opener, index) => {
    // Accent-insensitive, like the forbiddenTerms/TM checks above: fold the opener
    // pattern and match the folded text, so an accent-stripped opener ("Presenca de"
    // for "Presença de") cannot evade the check.
    const escaped = foldDiacritics(opener).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`(?:<br>|<\\/b>|\\.)\\s*${escaped}`, "gi");
    ck(checks, "TERM", `TO${index}`, `No forbidden opener: ${opener}`, "minor", !rx.test(foldedHtml), "ok");
  });
  if (meta.modality === "US") {
    const hits = foldedMatch(locale.modalityVocab.US_forbidden);
    ck(checks, "TERM", "TM1", "Ultrasound uses correct modality vocabulary", "critical", hits.length === 0, hits.length ? hits.join(", ") : "ok");
  }
  if (meta.modality === "MRI") {
    const hits = foldedMatch(locale.modalityVocab.MRI_forbidden);
    ck(checks, "TERM", "TM2", "MRI uses correct modality vocabulary", "critical", hits.length === 0, hits.length ? hits.join(", ") : "ok");
  }
  if (meta.modality === "CT") {
    // Emit the actual offending term as evidence (was hardcoded "ok" on both paths).
    const ctHits = foldedMatch(locale.modalityVocab.CT_forbidden);
    ck(checks, "TERM", "TM3", locale.modalityVocab.CT_fix, "major", ctHits.length === 0, ctHits.length ? ctHits.join(", ") : "ok");
  }

  // Expert-level quality checks
  // BUG 5 FIX: Create a new regex inside the filter callback to avoid lastIndex statefulness.
  // A regex with the `g` flag retains lastIndex between .test() calls, causing alternating
  // sentences to be skipped.
  const conclusionSentences = stripTags(conclusion).split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 10);
  if (conclusionSentences.length > 0) {
    const hedgeSentences = conclusionSentences.filter((s) => {
      const hedgeRx = /a esclarecer|nao se pode excluir|nao e possivel excluir|a depender de|a criterio|correlacionar? clinica|nao podemos afastar|sugerir? complementac|avaliar? possibilidade|convem correlacionar/i;
      return hedgeRx.test(normalizeLoose(s));
    });
    const hedgeRatio = hedgeSentences.length / conclusionSentences.length;
    ck(checks, "QUAL", "Q14", "Conclusion not excessively hedged", "minor", hedgeRatio <= 0.4, `${hedgeSentences.length}/${conclusionSentences.length} sentences hedged (${(hedgeRatio * 100).toFixed(0)}%)`);
  }

  const totalReportWords = stripTags(html).trim().split(/\s+/).filter(Boolean).length;
  const findingCount = Math.max(findingsInput.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 5).length, 1);
  const wordsPerFinding = totalReportWords / findingCount;
  if (findingCount >= 2) {
    ck(checks, "QUAL", "Q15", "Report not excessively verbose", "minor", wordsPerFinding <= 200, `${Math.round(wordsPerFinding)} words/finding`);
  }

  // GUIDE - Anatomical coverage checks (structural)
  const coverageKey = `${meta.modality}:${meta.region}`;
  const matrix = locale.coverage[coverageKey];
  if (matrix && matrix.length > 0) {
    for (let gi = 0; gi < matrix.length; gi++) {
      const token = matrix[gi];
      const found = [token, ...(COVERAGE_SYNONYMS[normalizeLoose(token)] ?? [])].some((t) => normalizedHtml.includes(normalizeLoose(t)));
      ck(checks, "GUIDE", `G${String(gi + 1).padStart(2, "0")}`, `Anatomical coverage: ${token}`, "minor", found, found ? "ok" : `missing: ${token}`);
    }
  }

  // RAG - Retrieval/preservation checks (structural)
  ck(
    checks,
    "RAG",
    "R01",
    "Title preserves modality and region",
    "critical",
    isTitleMatch(title, meta.expectedTitleTokens) && (meta.expectedRegionTokens.length === 0 || meta.expectedRegionTokens.some((token) => normalizeLoose(title).includes(normalizeLoose(token)))),
    title || "missing title",
  );

  // R02: Laterality correctness check (not just presence)
  if (laterality.length > 0) {
    const reportN = normalizeLoose(stripTags(html));
    const inputN = normalizeLoose(findingsInput);

    // Build a map of which laterality tokens appear in the input findings
    const inputLateralityMap = new Map<string, Set<string>>();
    const findingSentences = findingsInput.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 5);

    for (const sentence of findingSentences) {
      const sn = normalizeLoose(sentence);
      // Extract key finding nouns from the sentence for context matching
      const findingNouns = sn.match(/\b(?:hematoma|nodulo|cisto|massa|lesao|derrame|consolidacao|hernia|estenose|calcul|fratura|pneumotorax|atelectasia|efusao|luxacao|adenopatia|linfonodomegalia|hidronefrose|nefrolitiase|infarto|contusao|laceracao|opacidade|pneumonia|torcao|hemorrhage|hematoma|nodule|cyst|mass|lesion|effusion|consolidation|hernia|stenosis|calculus|fracture|collection|abscess|disc|tumor|pneumothorax|atelectasis|dislocation|lymphadenopathy|adenopathy|hydronephrosis|nephrolithiasis|infarct|contusion|laceration|opacity|torsion|occlusion|oclusao|thrombus|thrombosis|trombose|aneurysm|aneurisma|tear|rotura|extrusion|extrusao|protrusion|protrusao|embolism|embolia|knee|joelho|shoulder|ombro|hip|quadril|ankle|tornozelo|wrist|punho|elbow|cotovelo)\b/g) ?? [];

      for (const noun of findingNouns) {
        if (!inputLateralityMap.has(noun)) inputLateralityMap.set(noun, new Set());
        if (/\b(?:direit[ao]s?|right)\b/.test(sn)) inputLateralityMap.get(noun)!.add("right");
        if (/\b(?:esquerd[ao]s?|left)\b/.test(sn)) inputLateralityMap.get(noun)!.add("left");
        if (/\bbilateral\b/.test(sn)) inputLateralityMap.get(noun)!.add("bilateral");
      }
    }

    // Check for laterality SWAPS: if input says "left X" report must not say "right X" (and vice versa)
    let lateralityCorrect = true;
    let swapEvidence = "";

    // Check each laterality-bearing finding from input against the report
    for (const [noun, sides] of inputLateralityMap) {
      // Find report sentences containing this noun
      const reportSentences = reportN.split(/[.\n]/).filter((s) => s.includes(noun));
      for (const rs of reportSentences) {
        // A negated contralateral statement ("left lobe without nodules",
        // "no effusion on the right") documents the normal side — it is not a
        // laterality swap of the positive finding. Skip only when THIS finding's
        // clause is negated, so a swap is not hidden by an unrelated negation
        // elsewhere in the sentence ("nodulo a esquerda, sem realce").
        if (isFindingNegated(rs, noun, localeKey)) continue;
        const reportHasRight = /\b(?:direit[ao]s?|right)\b/.test(rs);
        const reportHasLeft = /\b(?:esquerd[ao]s?|left)\b/.test(rs);

        // Detect swap: input says left-only but report says right (without left)
        if (sides.has("left") && !sides.has("right") && !sides.has("bilateral") && reportHasRight && !reportHasLeft) {
          lateralityCorrect = false;
          swapEvidence = `${noun}: input=left, report=right`;
          break;
        }
        // Detect swap: input says right-only but report says left (without right)
        if (sides.has("right") && !sides.has("left") && !sides.has("bilateral") && reportHasLeft && !reportHasRight) {
          lateralityCorrect = false;
          swapEvidence = `${noun}: input=right, report=left`;
          break;
        }
      }
      if (!lateralityCorrect) break;
    }

    // Also check that all laterality tokens from input appear somewhere in report (presence check)
    const mapped = laterality.map((token) => (token === "right" ? /(right|direit)/ : token === "left" ? /(left|esquerd)/ : /(bilateral|bilater)/));
    const allPresent = mapped.every((rx) => rx.test(reportN));

    const passed = lateralityCorrect && allPresent;
    const evidence = !lateralityCorrect ? `SWAP: ${swapEvidence}` : !allPresent ? `missing laterality: ${laterality.join(", ")}` : "ok";
    ck(checks, "RAG", "R02", "Laterality preserved and correct", "critical", passed, evidence);
  }

  if (levels.length > 0) {
    const reportN = stripTags(html).toUpperCase().replace(/\s+/g, "");
    ck(checks, "RAG", "R03", "Spinal level preserved", "major", levels.every((level) => reportN.includes(level)), levels.join(", "));
  }
  if (measures.length > 0) {
    const reportN = normalizeLoose(stripTags(html));
    ck(checks, "RAG", "R04", "Measurements preserved in body", "major", measures.every((measure) => measurementPresent(reportN, measure)), measures.join(", "));
  }
  if (preservation.expected.length > 0) {
    ck(checks, "RAG", "R05", "Key findings preserved", "critical", preservation.ratio >= 0.8, preservation.missing.length ? preservation.missing.join(", ") : "ok");
  }
  const order = extractSectionOrder(html, locale);
  const analysisIndex = order.findIndex((label) => locale.sections.analysis.test(label));
  const conclusionIndex = order.findIndex((label) => locale.sections.conclusion.test(label));
  const techniqueIndex = order.findIndex((label) => locale.sections.technique.test(label));
  const hasValidOrder =
    analysisIndex >= 0 &&
    conclusionIndex > analysisIndex &&
    (techniqueIndex < 0 || techniqueIndex < analysisIndex);
  ck(checks, "RAG", "R06", "Section order preserved", "minor", hasValidOrder, order.join(" → ") || "missing sections");

  return checks;
}
