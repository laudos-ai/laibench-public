/**
 * Source-anchored abnormal-finding preservation (v3.11.0).
 *
 * On the input-only path v3.10 had no generic check that the report says what
 * the input says: a "No acute abnormality." report for a knee MRI with a
 * complete ACL tear scored PASS 91.9. The methods doc already lists
 * "unsupported normalcy" as a failure gate; this module enforces it where there
 * are no answer keys, using the input findings as the evidence:
 *
 *   Q16 (major)    every abnormal input finding is reflected in the report body.
 *   Q17 (critical) unsupported normalcy: the input is abnormal but the report
 *                  reflects NONE of its abnormal findings.
 *
 * "Abnormal input finding" = an input clause that is not a pertinent negative,
 * not a normal statement, not a recommendation, and not a sentence that only
 * describes the synthetic test harness ("Synthetic text for ... testing").
 *
 * Reflection is paraphrase-tolerant on purpose (a false FAIL on a correct,
 * concise report erodes trust): a clause counts as reflected when the whole
 * clause is ≥ 40% covered, OR any comma sub-clause (≥ 2 tokens) is ≥ 60%
 * covered, OR its diagnosis ("..., consistent with hepatic steatosis") is ≥ 50%
 * covered — and the best-matching report sentence does not deny it. Q16 is
 * emitted once per missing finding, so two omissions cost more than one. Like C09/
 * C10 these are structural checks: on the gold path the QUAL evaluator owns QUAL
 * and they are not in the gate allowlist, so gold-labelled scoring is unchanged.
 */

import { clinicalTokenCoverage, clinicalTokens } from "../clinical-match.js";
import { hasNegationCue } from "../extract.js";
import { normalizeLoose, stripTags } from "../normalize.js";
import type { LocaleKey } from "../types.js";
import { clinicalReportBody } from "./source-critical.js";

// Harness / context lines are not findings: the public synthetic cases carry
// "Synthetic text for ... testing" and "High-risk patient context" sentences.
const HARNESS_RX = /\b(?:synthetic|harness|for testing|testing\b|texto sintetico|sintetic[oa]|in the example|for the example|patient context|clinical context|contexto clinico)\b/;

const NEG_LEAD: Record<LocaleKey, RegExp> = {
  "en-US": /^(?:no|without|negative for|absent|there is no|there are no)\b/,
  "pt-BR": /^(?:sem|nao\s+(?:ha|se|foram|foi|houve)|ausencia de|ausentes?)\b/,
};

const NORMAL_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:normal study|unremarkable|within (?:normal|expected) limits|normal in size|normal (?:caliber|appearance|morphology)|preserved|intact|not dilated|homogeneous|stable|clear(?: bilaterally)?$|scattered fibroglandular|no acute abnormality)\b/,
  "pt-BR": /\b(?:exame normal|sem alteracoes|dentro dos limites|preservad[oa]s?|habitua(?:l|is)|normais?|integr[oa]s?|nao dilatad[oa]s?|homogene[oa]|sem anormalidades)\b/,
};

const MANAGEMENT_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:recommend\w*|advised|advise|suggest\w*|consider\w*|correlat\w*|follow[- ]?up|biopsy recommended|if clinically)\b/,
  "pt-BR": /\b(?:recomend\w*|sugere-se|suger\w*|sugiro|consider\w*|correlac\w*|controle evolutivo|seguimento|a criterio)\b/,
};

const DIAGNOSIS_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:most\s+)?(?:consistent with|compatible with|suggestive of|in keeping with|representing|likely)\s+/,
  "pt-BR": /\b(?:compativel com|sugestiv[oa] de|aspecto (?:sugestivo|compativel) (?:de|com)|provavelmente|representando)\s+/,
};

const SIDE_TOKEN_RX = /^(?:left|right|bilateral|bilaterally|both|esquerd[ao]s?|direit[ao]s?|bilaterais)$/;

/** Polarity of a clause is decided by its head (text before the first comma):
 *  "Complete tear of the ACL, with fibers not visualized" is an AFFIRMED tear. */
function headIsNegated(text: string, locale: LocaleKey): boolean {
  return hasNegationCue(text.split(",")[0], locale);
}

export type AbnormalClause = { text: string; reflected: boolean; coverage: number };

function clausesOf(text: string): string[] {
  return stripTags(text.replace(/<br\s*\/?>/gi, "\n"))
    // Sentence dots only: "1.8 cm" / "RV/LV 1.1" must not split a clause.
    .split(/(?<!\d)\.(?!\d)|[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Abnormal, assertive, clinical clauses of the input findings. */
export function abnormalInputClauses(findingsInput: string, locale: LocaleKey): string[] {
  return clausesOf(findingsInput).filter((clause) => {
    const n = normalizeLoose(clause);
    if (HARNESS_RX.test(n)) return false;
    if (NEG_LEAD[locale].test(n)) return false;
    if (NORMAL_RX[locale].test(n)) return false;
    if (MANAGEMENT_RX[locale].test(n)) return false;
    // Location headers such as "Left knee." carry fewer than two clinical tokens
    // once laterality words are set aside.
    return clinicalTokens(clause).filter((t) => !SIDE_TOKEN_RX.test(t)).length >= 2;
  });
}

function parts(clause: string, locale: LocaleKey): { whole: string; subClauses: string[]; diagnosis: string | null } {
  const n = normalizeLoose(clause);
  const m = DIAGNOSIS_RX[locale].exec(n);
  return {
    whole: clause,
    subClauses: clause.split(",").map((s) => s.trim()).filter((s) => clinicalTokens(s).length >= 2),
    diagnosis: m ? n.slice(m.index + m[0].length) : null,
  };
}

function bestSentence(needle: string, sentences: string[]): { sentence: string; coverage: number } {
  let best = { sentence: "", coverage: 0 };
  for (const sentence of sentences) {
    const coverage = clinicalTokenCoverage(needle, sentence);
    if (coverage > best.coverage) best = { sentence, coverage };
  }
  return best;
}

export function evaluateSourceFindings(reportHtml: string, findingsInput: string, locale: LocaleKey): {
  clauses: AbnormalClause[];
  missing: AbnormalClause[];
  unsupportedNormalcy: boolean;
} {
  const abnormal = abnormalInputClauses(findingsInput, locale);
  const body = clinicalReportBody(reportHtml, locale);
  const bodyText = stripTags(body.replace(/<br\s*\/?>/gi, "\n"));
  const sentences = clausesOf(body);

  const clauses: AbnormalClause[] = abnormal.map((clause) => {
    const p = parts(clause, locale);
    const wholeCov = clinicalTokenCoverage(p.whole, bodyText);
    const subCov = Math.max(0, ...p.subClauses.map((s) => clinicalTokenCoverage(s, bodyText)));
    const dxCov = p.diagnosis ? clinicalTokenCoverage(p.diagnosis, bodyText) : 0;
    const coverage = Math.max(wholeCov, subCov, dxCov);
    let reflected = wholeCov >= 0.4 || subCov >= 0.6 || dxCov >= 0.5;
    if (reflected) {
      // Polarity: the best-matching report sentence must not DENY an affirmed finding.
      const needle = dxCov >= 0.5 && p.diagnosis ? p.diagnosis : p.whole;
      const best = bestSentence(needle, sentences);
      if (best.sentence && headIsNegated(best.sentence, locale) && !headIsNegated(clause, locale)) {
        // Only treat it as denied when no OTHER sentence affirms it.
        const affirmed = sentences.some((s) => s !== best.sentence && !headIsNegated(s, locale) && clinicalTokenCoverage(needle, s) >= 0.5);
        if (!affirmed) reflected = false;
      }
    }
    return { text: clause, reflected, coverage: Math.round(coverage * 100) / 100 };
  });

  const missing = clauses.filter((c) => !c.reflected);
  return { clauses, missing, unsupportedNormalcy: clauses.length > 0 && missing.length === clauses.length };
}

export function describeMissingFindings(missing: AbnormalClause[]): string {
  if (missing.length === 0) return "ok";
  const short = (t: string) => (t.length > 70 ? `${t.slice(0, 67)}…` : t);
  return `not reflected: ${missing.slice(0, 3).map((m) => `"${short(m.text)}"`).join(" · ")}${missing.length > 3 ? ` (+${missing.length - 3})` : ""}`;
}
