import { normalizeLoose, stripTags } from "./normalize.js";

const CLINICAL_STOPWORDS = new Set([
  // Common report glue.
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das",
  "e", "em", "no", "na", "nos", "nas", "por", "para", "com", "sem", "ao", "aos",
  "pela", "pelo", "pelas", "pelos", "entre", "sobre", "ate", "apos", "durante",
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "with", "without", "for",
  // Boilerplate around impression-derived labels.
  "esse", "essa", "esses", "essas", "achado", "achados", "imagem", "imagens",
  "sugere", "sugerem", "sugerindo", "sugestivo", "sugestiva", "sugestivos", "sugestivas",
  "compativel", "compativeis", "caracteristica", "caracteristicas", "cujas", "cuja", "cujo",
  "custas", "custa", "devido", "relacionado", "relacionada", "relacionados", "relacionadas",
  "natureza", "processo", "hipotese", "hipoteses", "considerar", "deve", "devem", "podendo",
  "afastar", "avaliacao", "correlacao", "clinica", "clinico", "metodo",
  // Non-finding normality tokens should not make two texts clinically match.
  "normal", "normais", "habitual", "habituais", "preservado", "preservada", "preservados",
  "preservadas", "conservado", "conservada", "conservados", "conservadas", "ausencia",
]);

// Uncertainty / differential phrasing. A gold finding stated as "cannot be
// excluded" or "consider the hypothesis of" is NOT a mandatory finding: you
// cannot gate the omission of something the source itself only raised as a
// possibility. Matching this exempts the finding regardless of any appended
// recommendation.
const HEDGE_DIFFERENTIAL_RX =
  /\b(?:nao\s+se\s+podendo\s+afastar|nao\s+sendo\s+poss[ií]vel\s+afastar|nao\s+e\s+poss[ií]vel\s+afastar|nao\s+podemos\s+afastar|deve\s*-?\s*se\s+considerar|considerar\s+a\s+hipotese|hipotese\s+(?:de|diagnostica)|a\s+esclarecer|a\s+criterio|considerando\s+tambem\s+os\s+dados|deste\s+exame\s+e\s+feita\s+considerando)\b/i;

// Management / recommendation verbs. These describe what to DO next, not a
// finding to preserve. A clause that is purely a recommendation is exempt, but
// a confirmed finding with an appended recommendation must still be scored.
const MANAGEMENT_VERB_RX =
  /\b(?:sugere\s*-\s*se|sugerimos|recomenda\s*-\s*se|recomenda(?:mos|do|da)?|correlacao|correlacionar|endoscop|laringoscop|seguimento|acompanhamento|controle|biopsia|puncao)\b/i;

// Locale-scoped synonym / abbreviation canonicalization for the deterministic
// matcher. Each clinically-equivalent family collapses to one canonical token so
// that "PE" / "pulmonary embolism" / "TEP" / "tromboembolismo pulmonar" all match,
// and a paraphrased-but-correct critical is no longer a guaranteed false FAIL
// (the double-penalty FN+FP defect). Families are restricted to high-stakes
// criticals where the paraphrase risk is real; ordinary descriptive prose is left
// untouched to avoid manufacturing false matches.
//
// COLLISION SAFETY: bare "PE" is the abbreviation for pulmonary embolism in
// en-US, but "pé" (foot) normalizes to "pe" in pt-BR. So bare PE is matched
// CASE-SENSITIVELY on the original text (uppercase only) BEFORE normalization;
// the lowercase form is never canonicalized. Other abbreviations (SAH/HSA/SBO/
// CVA/AVC/TEP/PTX) are not real words in either language, so they are safe to map
// case-insensitively on the normalized text.
// Bare "PE" is matched CASE-SENSITIVELY (uppercase only) BEFORE normalization, so
// it never matches "pé"→"pe" (foot) in pt-BR.
const CASE_SENSITIVE_ABBR: Array<[RegExp, string]> = [
  [/\bPE\b/g, " pulmonary embolism "],
];
// Abbreviation EXPANSION on normalized text. These short tokens are not real words
// in either locale (and were previously dropped by the length>2 filter, so a report
// stating only "PE"/"SAH"/"TEP" matched nothing). Expand to phrase WORDS so existing
// multi-token phrases match WITHOUT collapsing them — preserving the token-count
// ratios the matcher and source-backing rely on. Prefix-5 token matching already
// bridges en/pt morphology (pulmonary≈pulmonar, hemorrhage≈hemorragia, subarachnoid≈
// subaracnoide), so one canonical expansion serves both locales.
const ABBR_EXPANSIONS: Array<[RegExp, string]> = [
  [/\bsah\b/g, " subarachnoid hemorrhage "],
  [/\bhsa\b/g, " subarachnoid hemorrhage "],
  [/\btep\b/g, " tromboembolismo pulmonar embolia "],
  [/\bsbo\b/g, " bowel obstruction "],
];
// Divergent-surface critical families: genuinely different words for the same
// entity that share no token prefix, so they are collapsed to one canonical token
// (e.g. "stroke" ≡ "cerebrovascular accident" ≡ "acidente vascular cerebral").
const CANON_COLLAPSE: Array<[RegExp, string]> = [
  [/\bstroke\b|cerebrovascular\s+accident|acidente\s+vascular(?:\s+(?:cerebral|encefalic\w*))?|\bcva\b|\bavc\b/g, " xcrtstroke "],
];

function canonicalizeClinical(stripped: string): string {
  let s = ` ${stripped} `;
  for (const [rx, sub] of CASE_SENSITIVE_ABBR) s = s.replace(rx, sub);
  s = normalizeLoose(s).replace(/[^a-z0-9]+/g, " ");
  for (const [rx, sub] of ABBR_EXPANSIONS) s = s.replace(rx, sub);
  for (const [rx, sub] of CANON_COLLAPSE) s = s.replace(rx, sub);
  return s;
}

export function clinicalTokens(value: string): string[] {
  const normalized = canonicalizeClinical(stripTags(value));
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => token.length > 2 && !CLINICAL_STOPWORDS.has(token));
  return Array.from(new Set(tokens));
}

export function clinicalComparableText(value: string): string {
  return clinicalTokens(value).join(" ");
}

// Confusable pairs that share a 5-char prefix but are clinically distinct words.
// A prefix-length heuristic cannot reject these without also breaking legitimate
// pt/en cognates (which diverge as early as char 6, e.g. hemorragia/hemorrhage),
// so they are denylisted explicitly. Keyed as the two tokens sorted + joined.
const CONFUSABLE_PAIRS = new Set([
  "fractional|fracture", "fractional|fractured", "fractional|fractures",
  "fraction|fracture", "fraction|fractured",
  "hemorrhage|hemorrhoid", "hemorrhages|hemorrhoids", "hemorrhage|hemorrhoids",
  "hemorragia|hemorroida", "hemorragia|hemorroidas",
]);

function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 5 && longer.startsWith(shorter.slice(0, 5))) {
    if (CONFUSABLE_PAIRS.has(a < b ? `${a}|${b}` : `${b}|${a}`)) return false;
    return true;
  }
  return false;
}

function tokenHit(token: string, haystackTokens: string[]): boolean {
  return haystackTokens.some((candidate) => tokenMatches(token, candidate));
}

/**
 * Lexical coverage: the fraction of clinical tokens in `needle` that appear in
 * `haystack` (substring/prefix token hit via tokenHit).
 *
 * Known ceiling (do not overstate matcher recall): this is purely lexical. It
 * does not expand synonyms ("AVC" vs "acidente vascular cerebral"), expand
 * abbreviations ("TEP" vs "tromboembolismo pulmonar"), or resolve paraphrase.
 * A radiology report that states a finding in different but clinically
 * equivalent words can therefore be scored as a miss. The judge layer and the
 * conservative-min combination mitigate this, but the deterministic channel has
 * a recall ceiling versus a trained NER matcher. A locale-scoped synonym and
 * abbreviation expansion table is proposed in bd issue laibench-kpu; it is
 * deferred rather than landed casually because changing what the matcher
 * accepts changes scores and risks new false positives.
 */
export function clinicalTokenCoverage(needle: string, haystack: string): number {
  const needleTokens = clinicalTokens(needle);
  if (needleTokens.length === 0) return 0;
  const haystackTokens = clinicalTokens(haystack);
  const hits = needleTokens.filter((token) => tokenHit(token, haystackTokens)).length;
  return hits / needleTokens.length;
}

export function clinicalTokenSimilarity(a: string, b: string): number {
  const tokensA = clinicalTokens(a);
  const tokensB = clinicalTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const aInB = tokensA.filter((token) => tokenHit(token, tokensB)).length;
  const bInA = tokensB.filter((token) => tokenHit(token, tokensA)).length;
  return (aInB / tokensA.length + bInA / tokensB.length) / 2;
}

export function isManagementOrDifferentialGold(value: string): boolean {
  const normalized = normalizeLoose(value);
  // Uncertainty / differential phrasing is never a mandatory finding.
  if (HEDGE_DIFFERENTIAL_RX.test(normalized)) return true;
  // No management verb at all: an ordinary, gradeable finding.
  if (!MANAGEMENT_VERB_RX.test(normalized)) return false;
  // Has a management verb. Exempt ONLY if it is purely a recommendation: after
  // dropping the clauses that carry management verbs, no substantive confirmed
  // finding remains. This keeps "recomenda-se controle" exempt while still
  // scoring a confirmed finding that merely appends a recommendation, e.g.
  // "massa pulmonar suspeita, recomenda-se biopsia" (the mass must be reported).
  const residual = normalized
    .split(/[.,;\n]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !MANAGEMENT_VERB_RX.test(clause))
    .join(" ");
  return clinicalTokens(residual).length < 2;
}

function splitClinicalClauses(value: string): string[] {
  return stripTags(value.replace(/<br\s*\/?>/gi, "\n"))
    .split(/[.\n;]/)
    .map((clause) => clause.trim())
    .filter((clause) => clinicalTokens(clause).length >= 3);
}

export function sourceBackedFindingCoverage(goldFinding: string, reportText: string, sourceText: string): number {
  const goldTokens = clinicalTokens(goldFinding);
  if (goldTokens.length === 0) return 0;
  if (clinicalTokenCoverage(goldFinding, reportText) === 0) return 0;

  let bestClause = "";
  let bestGoldHits = 0;
  let bestGoldCoverage = 0;
  for (const clause of splitClinicalClauses(sourceText)) {
    const clauseTokens = clinicalTokens(clause);
    const goldHits = goldTokens.filter((token) => tokenHit(token, clauseTokens)).length;
    const goldCoverage = goldHits / goldTokens.length;
    if (goldHits > bestGoldHits || (goldHits === bestGoldHits && goldCoverage > bestGoldCoverage)) {
      bestGoldHits = goldHits;
      bestGoldCoverage = goldCoverage;
      bestClause = clause;
    }
  }

  if (!bestClause) return 0;
  const enoughGoldAnchor = bestGoldHits >= Math.min(2, goldTokens.length) || bestGoldCoverage >= 0.5;
  if (!enoughGoldAnchor) return 0;
  return clinicalTokenCoverage(bestClause, reportText);
}

export function isFindingClinicallyReflected(
  finding: string,
  reportText: string,
  sourceText = "",
): boolean {
  const directCoverage = clinicalTokenCoverage(finding, reportText);
  if (directCoverage >= 0.5) return true;
  if (!sourceText) return false;
  return sourceBackedFindingCoverage(finding, reportText, sourceText) >= 0.55;
}
