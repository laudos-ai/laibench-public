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
const HARNESS_RX = /\b(?:synthetic|harness|for testing|testing\b|texto sintetico|sintetic[oa]s?|in the example|for the example|patient context|clinical context|contexto clinico|contexto\s+d[eo]\s+paciente)\b/;
// Indications, questions and resolved/old findings are not current abnormal findings.
const NOT_A_FINDING_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:clinical\s+(?:indication|question|history)|indication|history\s+of|rule\s+out|r\/o|evaluate\s+for|to\s+exclude|has\s+resolved|resolved|no\s+longer|(?:high|low)[- ]risk\s+patient)\b/,
  "pt-BR": /\b(?:indicacao|historia\s+clinica|para\s+afastar|descartar|investigacao\s+de|resolvid[oa]s?|nao\s+mais|paciente\s+de\s+(?:alto|baixo)\s+risco)\b/,
};

const NEG_LEAD: Record<LocaleKey, RegExp> = {
  "en-US": /^(?:no|without|negative for|absent|there is no|there are no)\b/,
  "pt-BR": /^(?:sem|nao\s+(?:ha|se|foram|foi|houve)|ausencia de|ausentes?)\b/,
};

const NORMAL_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:normal study|unremarkable|within (?:normal|expected) limits|normal in size|normal (?:caliber|appearance|morphology)|preserved|intact|not dilated|homogeneous|stable|clear(?: bilaterally)?$|scattered fibroglandular|no acute abnormality)\b/,
  "pt-BR": /\b(?:exame normal|sem alteracoes|dentro dos limites|preservad[oa]s?|habitua(?:l|is)|normais?|integr[oa]s?|nao dilatad[oa]s?|homogene[oa]|sem anormalidades)\b/,
};

// Postfix negation: "Left lobe and isthmus without nodules", "Gallbladder without
// stones" are normal statements even though they do not START with a negation.
// The clause is normal when everything before the cue is anatomy: no pathology
// noun and no measurement ("Solid nodule without calcification" and "Appendix
// measuring 9 mm without stranding" stay abnormal).
const POSTFIX_NEG_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:without|free of|negative for|with no)\b/,
  "pt-BR": /\b(?:sem|livres? de|ausencia de)\b/,
};
const PATHOLOGY_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:nodul\w*|mass(?:es)?|lesions?|cyst\w*|tear|tears|fractur\w*|effusions?|collections?|hematomas?|hemorrhag\w*|thicken\w*|opacit\w*|consolidat\w*|stenos[ie]s|occlu\w*|thromb\w*|aneurysm\w*|dilat\w*|edema\w*|enlarg\w*|calcif\w*|stones?|calcul\w*|polyps?|tumou?rs?|carcinoma\w*|metasta\w*|infarct\w*|abscess\w*|herniat\w*|extrusions?|protrusions?|bulg\w*|deform\w*|displac\w*|erosi\w*|osteophyt\w*|degenerat\w*|atroph\w*|ectasi\w*|ruptur\w*|distens\w*|lymphadenopath\w*|adenopath\w*|pneumo\w*|emphysem\w*|fibros\w*|atelecta\w*|irregular\w*|hypo(?:echoic|dense|attenuat\w*|intens\w*)|hyper(?:echoic|dense|attenuat\w*|intens\w*)|enhanc\w*|ischemi\w*|injur\w*|lacerat\w*|contusion\w*|obstruct\w*|perforat\w*|dissect\w*|spondylolisthesis|scoliosis|kyphosis)\b/,
  "pt-BR": /\b(?:nodul\w*|massas?|lesao|lesoes|cist\w*|ruptura\w*|rotura\w*|fratura\w*|derrames?|colec\w*|hematomas?|hemorrag\w*|espessad\w*|espessament\w*|opacidad\w*|consolida\w*|estenose\w*|oclus\w*|tromb\w*|aneurism\w*|dilata\w*|edema\w*|aument\w*|calcifica\w*|calculo\w*|litiase\w*|polipo\w*|tumor\w*|carcinoma\w*|metasta\w*|infarto\w*|abscess\w*|hernia\w*|extrusao|protrusao|abaulament\w*|deformid\w*|desvio\w*|erosa\w*|osteofit\w*|degenera\w*|atrofi\w*|ectasi\w*|distens\w*|linfonodomegalia\w*|adenomegalia\w*|pneumo\w*|enfisema\w*|fibrose\w*|atelectasi\w*|irregular\w*|hipo(?:ecoic|dens|atenua|ssinal)\w*|hiper(?:ecoic|dens|atenua|sinal)\w*|realce\w*|isquemi\w*|lacera\w*|contus\w*|obstru\w*|perfura\w*|dissec\w*|espondilolistese|escoliose|cifose)\b/,
};

function isPostfixNormal(n: string, locale: LocaleKey): boolean {
  const m = POSTFIX_NEG_RX[locale].exec(n);
  if (!m) return false;
  const lead = n.slice(0, m.index);
  return !/\d/.test(lead) && !PATHOLOGY_RX[locale].test(lead);
}

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
    if (isPostfixNormal(n, locale)) return false;
    if (NORMAL_RX[locale].test(n)) return false;
    if (MANAGEMENT_RX[locale].test(n)) return false;
    if (NOT_A_FINDING_RX[locale].test(n)) return false;
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

const SUBCLAUSE_SPLIT_RX = /,|;|\b(?:but|however|whereas|porem|mas|entretanto|contudo)\b/;

function subClauses(sentence: string): string[] {
  return sentence.split(SUBCLAUSE_SPLIT_RX).map((s) => s.trim()).filter(Boolean);
}

function bestSubClause(needle: string, sentences: string[]): string | null {
  let best: { text: string; coverage: number } | null = null;
  for (const sub of sentences.flatMap(subClauses)) {
    const coverage = clinicalTokenCoverage(needle, sub);
    if (!best || coverage > best.coverage) best = { text: sub, coverage };
  }
  return best && best.coverage > 0 ? best.text : null;
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
      // Anchor polarity on the finding's head (or its diagnosis), not on trailing
      // descriptors such as "with fibers not visualized".
      const needle = dxCov >= 0.5 && p.diagnosis ? p.diagnosis : clause.split(",")[0];
      // Polarity is judged on the report sub-clause that carries the finding
      // ("No pneumothorax, but moderate right pleural effusion" affirms the
      // effusion), and on the head of the input clause.
      const best = bestSubClause(needle, sentences);
      if (best && hasNegationCue(best, locale) && !headIsNegated(clause, locale)) {
        const affirmed = sentences.flatMap(subClauses).some((s) => s !== best && !hasNegationCue(s, locale) && clinicalTokenCoverage(needle, s) >= 0.5);
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
