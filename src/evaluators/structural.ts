/**
 * Structural compliance evaluator.
 * Contains the original checks.ts logic reorganized as a clear structural compliance layer.
 * These are format/structure checks, not clinical content checks.
 */

import { getLocale } from "../locales/index.js";
import { extractLateralityTokens, extractLevelTokens, extractMeasurements, matchAll, normalizeLoose, stripTags } from "../normalize.js";
import type { Check, ExamMeta, LocaleKey, Severity } from "../types.js";

function getTitle(html: string): string {
  return html.replace(/^(?:\s|<br\s*\/?>)*/i, "").match(/<center><b>([^<]+)<\/b><\/center>/i)?.[1]?.trim() ?? "";
}

function getSectionContent(html: string, rx: RegExp): string {
  const pattern = new RegExp(`<b>(?:${rx.source})[^<]*<\\/b>([\\s\\S]*?)(?:<br><br><b>|$)`, "i");
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

function extractFindingsPreservation(patterns: ReturnType<typeof getLocale>["preservationPatterns"], findingsInput: string, reportHtml: string): { expected: string[]; missing: string[]; ratio: number } {
  const expected: string[] = [];
  const missing: string[] = [];

  for (const pattern of patterns) {
    const inputRx = new RegExp(pattern.input.source, pattern.input.flags);
    const reportRx = new RegExp(pattern.report.source, pattern.report.flags);
    if (inputRx.test(findingsInput)) {
      expected.push(pattern.label);
      if (!reportRx.test(reportHtml)) missing.push(pattern.label);
    }
  }

  const uniqueExpected = Array.from(new Set(expected));
  const uniqueMissing = Array.from(new Set(missing));
  const ratio = uniqueExpected.length === 0 ? 1 : (uniqueExpected.length - uniqueMissing.length) / uniqueExpected.length;
  return { expected: uniqueExpected, missing: uniqueMissing, ratio };
}

function isTitleMatch(title: string, tokens: string[]): boolean {
  const n = normalizeLoose(title);
  return tokens.every((token) => token.split("|").some((variant) => n.includes(normalizeLoose(variant))));
}

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
  const normalizedHtml = normalizeLoose(stripTags(html));
  const preservation = extractFindingsPreservation(locale.preservationPatterns, findingsInput, html);
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
  ck(checks, "CRIT", "C04", "No markdown or foreign HTML/XML", "critical", matchAll(/^#{1,3}\s|^\*\*|```|<\/?(?:p|div|span|h[1-6]|ul|ol|li|em|strong|a)\b/gm, html).length === 0, "ok");
  ck(checks, "CRIT", "C05", "No measurements in conclusion", "major", matchAll(/\b\d+(?:[\.,]\d+)?\s*(?:cm|mm)\b|\b\d+\s*x\s*\d+\b/gi, conclusion).length === 0, "ok");
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

  // QUAL - Structural quality checks
  ck(checks, "QUAL", "Q01", "Has bold title", "minor", /^(?:\s|<br\s*\/?>)*<center><b>/i.test(html), html.slice(0, 40));
  ck(checks, "QUAL", "Q02", "Title not abbreviated", "critical", !locale.titleAbbrev.some((rx) => rx.test(title)), title || "missing title");
  ck(checks, "QUAL", "Q03", "No <br><br> inside analysis", "critical", !analysis.includes("<br><br>"), "ok");
  ck(checks, "QUAL", "Q04", "No <br><br> inside conclusion", "critical", !conclusion.includes("<br><br>"), "ok");
  ck(checks, "QUAL", "Q05", "Has section separators", "major", /<br><br><b>/i.test(html), "ok");
  ck(checks, "QUAL", "Q06", "Only allowed tags", "major", hasAllowedTagsOnly(html), "ok");
  ck(checks, "QUAL", "Q07", "No placeholders", "critical", matchAll(/\[[A-Z_]{2,}\]|_{3,}|(?<!\w)XXX(?!\w)|####/g, html).length === 0, "ok");
  ck(checks, "QUAL", "Q08", "Analysis section present", "critical", locale.sections.analysis.test(html), "ok");
  if (meta.modality === "US") ck(checks, "QUAL", "Q09", "Ultrasound has no technique section", "critical", !locale.sections.technique.test(html), "ok");
  const analysisLongLines = analysis.split("<br>").map((l) => stripTags(l).trim()).filter((l) => l.length > 25);
  const conclusionText = normalizeLoose(stripTags(conclusion));
  const copiedLines = analysisLongLines.filter((l) => conclusionText.includes(normalizeLoose(l).slice(0, 35)));
  ck(checks, "QUAL", "Q10", "Conclusion is synthesis not copy-paste of analysis", "major", copiedLines.length <= 1, copiedLines.length > 1 ? `${copiedLines.length} lines copied` : "ok");

  ck(checks, "QUAL", "Q11", "Conclusion section present and non-empty", "critical", conclusion.length > 0 && stripTags(conclusion).trim().length > 10, conclusion.length === 0 ? "missing" : `${stripTags(conclusion).trim().length} chars`);

  const analysisWordCount = stripTags(analysis).trim().split(/\s+/).filter(Boolean).length;
  ck(checks, "QUAL", "Q12", "Analysis has substantive content", "major", analysisWordCount >= 15, `${analysisWordCount} words`);

  // TERM - Terminology structural checks
  locale.forbiddenTerms.forEach(([rx, label], index) => {
    const hits = matchAll(rx, html);
    ck(checks, "TERM", `T${String(index).padStart(2, "0")}`, label, "major", hits.length === 0, hits.length ? hits[0] : "ok");
  });
  locale.forbiddenOpeners.forEach((opener, index) => {
    const escaped = opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`(?:<br>|<\\/b>|\\.)\\s*${escaped}`, "gi");
    ck(checks, "TERM", `TO${index}`, `No forbidden opener: ${opener}`, "major", !rx.test(html), "ok");
  });
  if (meta.modality === "US") {
    const hits = matchAll(locale.modalityVocab.US_forbidden, html);
    ck(checks, "TERM", "TM1", "Ultrasound uses correct modality vocabulary", "critical", hits.length === 0, hits.length ? hits.join(", ") : "ok");
  }
  if (meta.modality === "MRI") {
    const hits = matchAll(locale.modalityVocab.MRI_forbidden, html);
    ck(checks, "TERM", "TM2", "MRI uses correct modality vocabulary", "critical", hits.length === 0, hits.length ? hits.join(", ") : "ok");
  }
  if (meta.modality === "CT") {
    ck(checks, "TERM", "TM3", locale.modalityVocab.CT_fix, "major", !locale.modalityVocab.CT_forbidden.test(html), "ok");
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

  // Classification mention checks (structural - check presence, not correctness)
  const reportText = stripTags(html);
  const sourceContext = normalizeLoose(`${meta.normalizedExam} ${findingsInput}`);
  if (/nodulo.*tireoide|tireoide.*nodulo/i.test(sourceContext) && meta.modality === "US") {
    ck(checks, "TERM", "TC01", "Thyroid nodule should reference TI-RADS", "major", /ti-?rads/i.test(reportText), "TI-RADS not mentioned");
  }
  if (/nodulo.*mama|mama.*nodulo|lesao.*mama/i.test(sourceContext) && (meta.modality === "US" || meta.modality === "MRI" || meta.modality === "MG" || meta.modality === "MX")) {
    ck(checks, "TERM", "TC02", "Breast finding should reference BI-RADS", "major", /bi-?rads/i.test(reportText), "BI-RADS not mentioned");
  }
  if (/cisto.*ren|ren.*cisto/i.test(sourceContext) && /complex|sept|solid|irregular/i.test(sourceContext)) {
    ck(checks, "TERM", "TC03", "Complex renal cyst should reference Bosniak", "major", /bosniak/i.test(reportText), "Bosniak not mentioned");
  }
  if (/nodulo.*pulmon|pulmon.*nodulo/i.test(sourceContext) && meta.modality === "CT") {
    ck(checks, "TERM", "TC04", "Pulmonary nodule should reference Fleischner or Lung-RADS", "major", /fleischner|lung-?rads/i.test(reportText), "Fleischner/Lung-RADS not mentioned");
  }
  if (/nodulo.*figado|figado.*nodulo|lesao.*hepat/i.test(sourceContext) && /cirros|hepatopat|cronico/i.test(sourceContext)) {
    ck(checks, "TERM", "TC05", "Hepatic lesion in chronic liver disease should reference LI-RADS", "major", /li-?rads/i.test(reportText), "LI-RADS not mentioned");
  }
  if (/prostata/i.test(sourceContext) && meta.modality === "MRI") {
    ck(checks, "TERM", "TC06", "Prostate MRI should reference PI-RADS", "major", /pi-?rads/i.test(reportText), "PI-RADS not mentioned");
  }

  // GUIDE - Anatomical coverage checks (structural)
  const coverageKey = `${meta.modality}:${meta.region}`;
  const matrix = locale.coverage[coverageKey];
  if (matrix && matrix.length > 0) {
    for (let gi = 0; gi < matrix.length; gi++) {
      const token = matrix[gi];
      const found = normalizedHtml.includes(normalizeLoose(token));
      ck(checks, "GUIDE", `G${String(gi + 1).padStart(2, "0")}`, `Anatomical coverage: ${token}`, "major", found, found ? "ok" : `missing: ${token}`);
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
      const findingNouns = sn.match(/\b(?:hematoma|nodulo|cisto|massa|lesao|derrame|consolidacao|hernia|estenose|calcul|fratura|pneumotorax|atelectasia|efusao|luxacao|adenopatia|linfonodomegalia|hidronefrose|nefrolitiase|hemorrhage|hematoma|nodule|cyst|mass|lesion|effusion|consolidation|hernia|stenosis|calculus|fracture|collection|abscess|disc|tumor)\b/g) ?? [];

      for (const noun of findingNouns) {
        if (!inputLateralityMap.has(noun)) inputLateralityMap.set(noun, new Set());
        if (/\b(?:direit|right)\b/.test(sn)) inputLateralityMap.get(noun)!.add("right");
        if (/\b(?:esquerd|left)\b/.test(sn)) inputLateralityMap.get(noun)!.add("left");
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
        const reportHasRight = /\b(?:direit|right)\b/.test(rs);
        const reportHasLeft = /\b(?:esquerd|left)\b/.test(rs);

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
    ck(checks, "RAG", "R04", "Measurements preserved in body", "major", measures.every((measure) => reportN.includes(measure)), measures.join(", "));
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
