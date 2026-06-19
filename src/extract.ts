/**
 * Extraction layer for structured data from radiology report HTML.
 * Extracts findings, classifications, recommendations, and critical mentions.
 */

import { normalizeLoose, stripTags } from "./normalize.js";
import { getLocale } from "./locales/index.js";
import type { LocaleKey } from "./types.js";

// ---- Extracted types ----

export type ExtractedFinding = {
  text: string;
  location?: string;
  laterality?: "right" | "left" | "bilateral";
  severity: "critical" | "major" | "minor" | "incidental";
  measurements: string[];
  /** Whether the finding was negated in context (e.g. "no evidence of...") */
  negated?: boolean;
};

export type ExtractedClassification = {
  system: string; // "birads" | "tirads" | "lirads" | "pirads" | "bosniak" | "fleischner" | "lungrads"
  rawText: string;
  value: string; // e.g. "4A", "5", "III", "B"
  normalizedValue: string; // e.g. "4A", "5", "3", "B"
};

export type ExtractedRecommendation = {
  text: string;
  type: "follow-up" | "biopsy" | "further-imaging" | "clinical-correlation" | "other";
  timeframe?: string;
};

export type ExtractedCriticalMention = {
  text: string;
  category: string; // "acute-bleed", "pe", "stroke", "pneumothorax", "fracture", etc.
};

// ---- Laterality extraction ----

const LATERALITY_PATTERNS_PT: Array<{ rx: RegExp; side: "right" | "left" | "bilateral" }> = [
  { rx: /\b(?:direit[ao]|à direita)\b/i, side: "right" },
  { rx: /\b(?:esquerd[ao]|à esquerda)\b/i, side: "left" },
  { rx: /\bbilateral\b/i, side: "bilateral" },
];

const LATERALITY_PATTERNS_EN: Array<{ rx: RegExp; side: "right" | "left" | "bilateral" }> = [
  { rx: /\bright\b/i, side: "right" },
  { rx: /\bleft\b/i, side: "left" },
  { rx: /\bbilateral(?:ly)?\b/i, side: "bilateral" },
];

function detectLaterality(text: string, locale: LocaleKey): "right" | "left" | "bilateral" | undefined {
  const patterns = locale === "pt-BR" ? LATERALITY_PATTERNS_PT : LATERALITY_PATTERNS_EN;
  const found = new Set<string>();
  for (const { rx, side } of patterns) {
    if (rx.test(text)) found.add(side);
  }
  if (found.has("bilateral")) return "bilateral";
  if (found.has("right") && found.has("left")) return "bilateral";
  if (found.has("right")) return "right";
  if (found.has("left")) return "left";
  return undefined;
}

// ---- Measurement extraction ----

function extractMeasurementsFromText(text: string): string[] {
  // Match measurements like: 12mm, 2.5cm, 18x12x15mm, 3.8 x 2.8 x 2 cm, 25 mm
  const rx = /\b\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)*\s*(?:mm|cm)\b/gi;
  return Array.from(new Set((text.match(rx) ?? []).map((m) => m.trim())));
}

// ---- Severity heuristics ----

export const CRITICAL_KEYWORDS_PT = /hematoma|hemorragia|embolia|tromboembolismo|pneumotorax|pneumot[oó]rax|fratura|luxação|isquemia aguda|\bavc\b|acidente vascular|oclusão|dissecção|hernia[çc]ão cerebral|ruptura|tamponamento|efeito de massa|desvio da linha m[eé]dia/i;
export const CRITICAL_KEYWORDS_EN = /hemorrhage|hematoma|embolism|thromboembol|pneumothorax|fracture|dislocation|acute ischemi|stroke|occlusion|dissection|herniation|rupture|tamponade|acute bleed|mass effect|midline shift/i;

const MAJOR_KEYWORDS_PT = /nódulo|massa|neoplasia|tumor|metástase|lesão expansiva|coleção|abscesso|obstrução|hidronefrose|derrame pleural|consolidação|pneumonia|linfonodomegalia|estenose|trombose/i;
const MAJOR_KEYWORDS_EN = /nodule|mass|neoplasm|tumor|metastas|lesion|collection|abscess|obstruction|hydronephrosis|pleural effusion|consolidation|pneumonia|lymphadenomegaly|stenosis|thrombosis/i;

const MINOR_KEYWORDS_PT = /cisto simples|cálculo|esteatose|espessamento|divertículo|hérnia|ectasia|afilamento|lipoma|granuloma/i;
const MINOR_KEYWORDS_EN = /simple\s+(?:\w+\s+)?cyst|cyst\b(?!.*complex)|calculus|stone|steatosis|thickening|diverticul|hernia|ectasia|thinning|lipoma|granuloma/i;

function classifySeverity(text: string, locale: LocaleKey): "critical" | "major" | "minor" | "incidental" {
  const critRx = locale === "pt-BR" ? CRITICAL_KEYWORDS_PT : CRITICAL_KEYWORDS_EN;
  const majorRx = locale === "pt-BR" ? MAJOR_KEYWORDS_PT : MAJOR_KEYWORDS_EN;
  const minorRx = locale === "pt-BR" ? MINOR_KEYWORDS_PT : MINOR_KEYWORDS_EN;
  if (critRx.test(text)) return "critical";
  if (majorRx.test(text)) return "major";
  if (minorRx.test(text)) return "minor";
  return "incidental";
}

// ---- Location extraction ----

const LOCATION_TOKENS_PT = /(?:lobo\s+(?:direito|esquerdo|superior|inferior|médio|caudado))|(?:segmento\s+\w+)|(?:região\s+\w+)|(?:polo\s+(?:superior|inferior))|(?:hilo\s+\w+)|(?:fossa\s+\w+)|(?:base\s+\w+)|(?:ápice\s+\w+)|(?:córtex\s+\w+)|(?:medular\s+\w+)/i;
const LOCATION_TOKENS_EN = /(?:(?:right|left)\s+(?:lobe|kidney|adrenal|lung))|(?:segment\s+\w+)|(?:(?:upper|lower|middle|caudate)\s+lobe)|(?:(?:superior|inferior)\s+pole)|(?:hilum|hilus)|(?:fossa\s+\w+)|(?:base\s+\w+)|(?:apex)|(?:cortex|cortical)|(?:medull)/i;

function extractLocation(text: string, locale: LocaleKey): string | undefined {
  const rx = locale === "pt-BR" ? LOCATION_TOKENS_PT : LOCATION_TOKENS_EN;
  const matches = text.match(rx);
  return matches?.[0]?.trim();
}

// ---- Main extraction functions ----

/**
 * Extract structured findings from report HTML.
 * Splits on <br> tags and sentence boundaries to identify individual findings.
 */
export function extractFindings(html: string, locale: LocaleKey): ExtractedFinding[] {
  // Convert <br> tags to newlines before stripping remaining tags
  const text = stripTags(html.replace(/<br\s*\/?>/gi, "\n"));
  // Split on newlines and period-followed-by-uppercase
  const rawLines = text.split(/\n|(?<=\.)\s+(?=[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÜÇ])/);
  const findings: ExtractedFinding[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    // Skip empty lines, section headers, titles
    if (!trimmed || trimmed.length < 8) continue;
    // Skip lines that are just section labels
    if (/^(?:análise|conclusão|técnica|findings|impression|technique)\s*$/i.test(trimmed)) continue;
    // Skip generic normal statements
    if (/^(?:sem alterações|normal|unremarkable|within normal limits)/i.test(trimmed)) continue;

    const severity = classifySeverity(trimmed, locale);
    const laterality = detectLaterality(trimmed, locale);
    const location = extractLocation(trimmed, locale);
    const measurements = extractMeasurementsFromText(trimmed);
    const negated = isNegated(trimmed, locale);

    findings.push({
      text: trimmed,
      location,
      laterality,
      severity,
      measurements,
      ...(negated ? { negated: true } : {}),
    });
  }

  return findings;
}

// ---- Classification extraction ----

type ClassificationPattern = {
  system: string;
  rx: RegExp;
  normalizer: (raw: string) => string;
};

const CLASSIFICATION_PATTERNS: ClassificationPattern[] = [
  {
    system: "birads",
    rx: /(?:acr\s+)?bi-?rads(?:\s*®|\s*\u00ae)?\s*[:\s]?\s*(\d[a-cA-C]?)/gi,
    normalizer: (raw) => raw.toUpperCase(),
  },
  {
    system: "tirads",
    rx: /(?:acr\s+)?ti-?rads\s*[:\s]?\s*(\d)/gi,
    normalizer: (raw) => raw,
  },
  {
    system: "lirads",
    rx: /li-?rads\s*[:\s]?\s*((?:LR[-\s]?)?[1-5M](?:\s*[a-cA-C])?)/gi,
    normalizer: (raw) => raw.replace(/^LR[-\s]?/i, "").toUpperCase(),
  },
  {
    system: "pirads",
    rx: /pi-?rads\s*[:\s]?\s*(\d)/gi,
    normalizer: (raw) => raw,
  },
  {
    system: "bosniak",
    rx: /bosniak\s*[:\s]?\s*((?:I{1,3}|IV|[1-4])F?)/gi,
    normalizer: (raw) => {
      // BUG 9 FIX: Add Roman numeral keys to the normalization map.
      // The old map only had Arabic numeral keys (1,2,3,4) but not Roman (I, II, IIF, III, IV).
      const map: Record<string, string> = {
        "1": "I", "2": "II", "2F": "IIF", "3": "III", "4": "IV",
        "I": "I", "II": "II", "IIF": "IIF", "III": "III", "IV": "IV",
      };
      return map[raw.toUpperCase()] ?? raw.toUpperCase();
    },
  },
  {
    // BUG 8 FIX: Capture the category/recommendation text after "Fleischner" so that
    // the extracted value is meaningful (e.g., "low-risk", "high-risk", "solid", "subsolid")
    // rather than always returning "mentioned".
    system: "fleischner",
    rx: /fleischner\s*(.*?)(?:\.|<|$)/gi,
    normalizer: (raw) => {
      const trimmed = raw.trim().toLowerCase();
      return trimmed.length > 0 ? trimmed : "mentioned";
    },
  },
  {
    system: "lungrads",
    rx: /lung-?rads\s*[:\s]?\s*(\d[a-cA-C]?)/gi,
    normalizer: (raw) => raw.toUpperCase(),
  },
];

/**
 * Extract classification system mentions (BI-RADS, TI-RADS, etc.) from report HTML.
 */
export function extractClassifications(html: string): ExtractedClassification[] {
  const text = stripTags(html);
  const results: ExtractedClassification[] = [];

  for (const pattern of CLASSIFICATION_PATTERNS) {
    // matchAll iterates a fresh internal regex state, so the shared g-flagged
    // pattern never needs to be cloned to reset lastIndex.
    for (const match of text.matchAll(pattern.rx)) {
      const rawValue = match[1] ?? "";
      results.push({
        system: pattern.system,
        rawText: match[0],
        value: rawValue.trim(),
        normalizedValue: pattern.normalizer(rawValue.trim()),
      });
    }
  }

  // Deduplicate by system+normalizedValue
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.system}:${r.normalizedValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Recommendation extraction ----

const RECOMMENDATION_PATTERNS_PT: Array<{ rx: RegExp; type: ExtractedRecommendation["type"] }> = [
  { rx: /biópsia|biopsia|punção/i, type: "biopsy" },
  { rx: /controle\s+(?:em|após|de)|acompanhamento|seguimento|reavali/i, type: "follow-up" },
  { rx: /complementar?\s+(?:com|o\s+exame)|correlacionar|sugeri(?:r|mos)\s+(?:complementação|avaliação)|(?:rm|tc|us)\s+(?:para|de)\s+(?:melhor|complementar)/i, type: "further-imaging" },
  { rx: /correlação\s+clínica|correlacionar\s+clinicamente/i, type: "clinical-correlation" },
];

const RECOMMENDATION_PATTERNS_EN: Array<{ rx: RegExp; type: ExtractedRecommendation["type"] }> = [
  { rx: /biops[yie]/i, type: "biopsy" },
  { rx: /follow[\s-]?up|surveillance|re-?evaluat|interval\s+(?:imaging|study)|repeat\s+(?:imaging|study)|recommend(?:ed)?\s+(?:follow|re)/i, type: "follow-up" },
  { rx: /further\s+(?:imaging|evaluation|work[\s-]?up)|additional\s+(?:imaging|evaluation)|(?:mri|ct|us)\s+(?:for|to)\s+(?:further|better)/i, type: "further-imaging" },
  { rx: /clinical\s+correlation/i, type: "clinical-correlation" },
];

const TIMEFRAME_RX_PT = /(?:em|após|dentro\s+de)\s+(\d+\s+(?:dias?|semanas?|meses|mês|anos?))/i;
const TIMEFRAME_RX_EN = /(?:in|after|within)\s+(\d+\s+(?:days?|weeks?|months?|years?))/i;

/**
 * Extract follow-up recommendations from report HTML.
 */
export function extractRecommendations(html: string, locale?: LocaleKey): ExtractedRecommendation[] {
  const text = stripTags(html);
  const patterns = locale === "en-US" ? RECOMMENDATION_PATTERNS_EN : RECOMMENDATION_PATTERNS_PT;
  const timeRx = locale === "en-US" ? TIMEFRAME_RX_EN : TIMEFRAME_RX_PT;
  const results: ExtractedRecommendation[] = [];
  const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 10);

  for (const sentence of sentences) {
    for (const pattern of patterns) {
      if (pattern.rx.test(sentence)) {
        const timeMatch = timeRx.exec(sentence);
        results.push({
          text: sentence,
          type: pattern.type,
          timeframe: timeMatch?.[1],
        });
        break; // one match per sentence
      }
    }
  }

  return results;
}

// ---- Critical finding extraction ----

type CriticalCategory = {
  category: string;
  rxPt: RegExp;
  rxEn: RegExp;
};

const CRITICAL_CATEGORIES: CriticalCategory[] = [
  {
    category: "acute-bleed",
    rxPt: /hemorragi[ac]|hematoma|sangramento\s+ativo/i,
    rxEn: /hemorrhag[ei]|hematoma|active\s+bleed/i,
  },
  {
    category: "pulmonary-embolism",
    rxPt: /embolia\s+pulmonar|tromboembolismo\s+pulmonar|TEP\b/i,
    rxEn: /pulmonary\s+emboli|PE\b(?!\w)|thromboemboli/i,
  },
  {
    category: "stroke",
    rxPt: /(?:acidente\s+vascular|AVC\b|isquemia\s+(?:cerebral|aguda))/i,
    rxEn: /(?:stroke|acute\s+(?:cerebral\s+)?ischemi|CVA\b)/i,
  },
  {
    category: "pneumothorax",
    rxPt: /pneumot[oó]rax/i,
    rxEn: /pneumothorax/i,
  },
  {
    category: "aortic-dissection",
    rxPt: /dissecção\s+(?:de\s+)?aorta|dissecção\s+aórtica/i,
    rxEn: /aortic\s+dissection/i,
  },
  {
    category: "tension-pneumothorax",
    rxPt: /pneumot[oó]rax\s+(?:hipertensivo|sob\s+tensão)/i,
    rxEn: /tension\s+pneumothorax/i,
  },
  {
    category: "midline-shift",
    rxPt: /desvio\s+(?:da\s+)?linha\s+m[eé]dia/i,
    rxEn: /midline\s+shift/i,
  },
  {
    category: "mass-effect",
    rxPt: /efeito\s+(?:de\s+)?massa|hernia[çc]ão\s+(?:cerebral|transtentorial|subfalcial)/i,
    rxEn: /mass\s+effect|herniation|uncal\s+herniation|transtentorial|subfalcine/i,
  },
  {
    category: "bowel-obstruction",
    rxPt: /obstru[çc]ão\s+intestinal|[ií]leo\s+(?:mecânico|obstrutivo)/i,
    rxEn: /bowel\s+obstruction|small\s+bowel\s+obstruction|SBO\b/i,
  },
  {
    category: "perforation",
    rxPt: /perfura[çc]ão|pneumoperit[oô]nio/i,
    rxEn: /perforation|pneumoperitoneum/i,
  },
  {
    category: "fracture",
    rxPt: /fratura/i,
    rxEn: /fracture/i,
  },
  {
    category: "cord-compression",
    rxPt: /compress[ãa]o\s+(?:medular|da\s+medula)/i,
    rxEn: /(?:cord|spinal)\s+compression/i,
  },
  {
    category: "cardiac-tamponade",
    rxPt: /tamponamento\s+card[ií]aco/i,
    rxEn: /cardiac\s+tamponade|pericardial\s+tamponade/i,
  },
  {
    category: "ruptured-aaa",
    rxPt: /aneurisma\s+roto|ruptura\s+de\s+aneurisma/i,
    rxEn: /ruptured\s+aortic\s+aneurysm|ruptured\s+AAA/i,
  },
  {
    category: "mesenteric-ischemia",
    rxPt: /isquemia\s+mesent[eé]rica/i,
    rxEn: /mesenteric\s+ischemia|intestinal\s+ischemia/i,
  },
  {
    category: "cauda-equina",
    rxPt: /cauda\s+equina|s[ií]ndrome\s+da\s+cauda\s+equina/i,
    rxEn: /cauda\s+equina/i,
  },
  {
    category: "epidural-hematoma",
    rxPt: /hematoma\s+epidural/i,
    rxEn: /epidural\s+hematoma/i,
  },
  {
    category: "testicular-torsion",
    rxPt: /tor[çc][ãa]o\s+testicular/i,
    rxEn: /testicular\s+torsion/i,
  },
  {
    category: "ovarian-torsion",
    rxPt: /tor[çc][ãa]o\s+ovariana/i,
    rxEn: /ovarian\s+torsion/i,
  },
  {
    category: "necrotizing-fasciitis",
    rxPt: /fasci[ií]te\s+necrotizante/i,
    rxEn: /necrotizing\s+fasciitis/i,
  },
  {
    category: "acute-appendicitis",
    rxPt: /apendicite\s+aguda/i,
    rxEn: /acute\s+appendicitis/i,
  },
];

/**
 * Check if a sentence negates the critical finding it mentions.
 * Returns true if the sentence contains negation patterns indicating
 * the finding is absent/excluded.
 *
 * Uses locale-aware negation patterns from the locale spec for cleaner extensibility.
 */
export function isNegated(sentence: string, locale: LocaleKey): boolean {
  const normalized = normalizeLoose(sentence);
  const localeSpec = getLocale(locale);
  return localeSpec.negationPatterns.some((rx) => rx.test(normalized));
}

const NEGATION_PREFIX_PT = /\b(?:sem|nao\s+(?:ha|foram?|foi|se|mais\s+se|existe(?:m)?|identificad|observad|detectad|evidenciad|caracterizad|visualizad|apresenta|demonstrad)|ausencia de|livres? de|afastad[oa]s?|excluid[oa]s?|inden[ei]s?)\b/;
const NEGATION_PREFIX_EN = /\b(?:no|without|absent|negative for|ruled out|excluded|not\s+(?:identified|seen|detected|demonstrated|observed|present|visualized))\b/;
const NEGATION_SUFFIX_PT = /\b(?:ausentes?|nao (?:caracterizad|identificad|evidenciad|observad|detectad)|descartad[oa]s?)\b/;
const NEGATION_SUFFIX_EN = /\b(?:absent|not (?:identified|seen|detected|demonstrated|observed|present)|excluded|ruled out)\b/;

/**
 * Clause-scoped negation: decides whether the specific finding mention inside a
 * sentence is negated, instead of flagging the whole sentence. This keeps
 * "Grade III splenic laceration, without active extravasation" positive for the
 * laceration while recognizing the extravasation clause as negated.
 * Falls back to sentence-level isNegated when the match cannot be located.
 */
/**
 * True when the sentence carries any negation cue (prefix or suffix form).
 * Coarser than isFindingNegated; used where no specific match span is known.
 */
export function hasNegationCue(text: string, locale: LocaleKey): boolean {
  const normalized = normalizeLoose(text);
  const prefixRx = locale === "pt-BR" ? NEGATION_PREFIX_PT : NEGATION_PREFIX_EN;
  const suffixRx = locale === "pt-BR" ? NEGATION_SUFFIX_PT : NEGATION_SUFFIX_EN;
  return prefixRx.test(normalized) || suffixRx.test(normalized) || isNegated(text, locale);
}

// Contrast / accompaniment markers that close a negation's scope. A leading
// negation ("No effusion ...") must NOT bleed past one of these into an
// affirmed compound critical ("... but acute hemorrhage present"). These join
// the punctuation boundaries (',' ';' ':') used to scope the clause window.
//
// IMPORTANT: the coordinating conjunctions "and"/"or" (PT "e"/"ou") are
// deliberately EXCLUDED. In radiology they overwhelmingly coordinate items
// under a SINGLE shared negation ("no hemorrhage or mass effect", "sem
// hemorragia ou efeito de massa") — both items are denied. Treating them as
// scope-closers would un-negate the second item and fabricate a critical
// detection (a false alarm in the UNSAFE direction). Only true contrast
// ("but"/"mas"/"porem"/"contudo"/"entretanto") and accompaniment ("with"/"com")
// introduce a genuinely separate clause that a leading negation must not scope.
const CLAUSE_CONJUNCTION_RX = /\b(?:but|with|mas|com|porem|contudo|entretanto)\b/g;

/**
 * Boundary index of the LAST conjunction-marker strictly before `idx`, or -1.
 * Returned so that the shared `Math.max(...) + 1` lands just AFTER the
 * conjunction word (matching the convention of the punctuation boundaries,
 * which return the separator index). Used to bound the clause window on its
 * left so a negation in an earlier clause does not scope across the conjunction
 * onto the matched finding.
 */
function lastConjunctionBoundaryBefore(text: string, idx: number): number {
  let pos = -1;
  CLAUSE_CONJUNCTION_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_CONJUNCTION_RX.exec(text)) !== null) {
    if (m.index >= idx) break;
    // -1 so the shared `+ 1` in clauseStart points right after the conjunction word.
    pos = m.index + m[0].length - 1;
    if (CLAUSE_CONJUNCTION_RX.lastIndex === m.index) CLAUSE_CONJUNCTION_RX.lastIndex++;
  }
  return pos;
}

/** Index of the FIRST conjunction-marker boundary at/after `from`, or -1. */
function firstConjunctionBoundaryFrom(text: string, from: number): number {
  CLAUSE_CONJUNCTION_RX.lastIndex = Math.max(0, from);
  const m = CLAUSE_CONJUNCTION_RX.exec(text);
  return m ? m.index : -1;
}

export function isFindingNegated(sentence: string, matchText: string, locale: LocaleKey): boolean {
  const normSentence = normalizeLoose(sentence);
  const normMatch = normalizeLoose(matchText);
  const idx = normSentence.indexOf(normMatch);
  // When the (often multi-token) match is not a literal substring, scope on the
  // whole sentence using the SAME clause-level cues (NEGATION_PREFIX/SUFFIX, via
  // hasNegationCue) rather than the weaker isNegated, whose locale patterns omit
  // bare "no X" / "sem X". This closes negation-matching-1: a report DENYING a
  // critical ("No pneumothorax." / "Sem pneumotorax.") must register as negated
  // so the critical is NOT credited as mentioned.
  if (idx < 0) return hasNegationCue(sentence, locale);
  // Clause window: punctuation boundaries AND contrast/conjunction markers. The
  // conjunction boundaries (crit-extract-2) stop a leading negation from
  // bleeding across "but"/"and"/"with"/etc. onto an affirmed compound critical
  // ("No effusion but acute hemorrhage present").
  const conjBefore = lastConjunctionBoundaryBefore(normSentence, idx);
  const clauseStart = Math.max(
    normSentence.lastIndexOf(",", idx),
    normSentence.lastIndexOf(";", idx),
    normSentence.lastIndexOf(":", idx),
    conjBefore,
  ) + 1;
  const matchEnd = idx + normMatch.length;
  let clauseEnd = normSentence.length;
  for (const sep of [",", ";", ":"]) {
    const next = normSentence.indexOf(sep, matchEnd);
    if (next >= 0 && next < clauseEnd) clauseEnd = next;
  }
  const conjAfter = firstConjunctionBoundaryFrom(normSentence, matchEnd);
  if (conjAfter >= 0 && conjAfter < clauseEnd) clauseEnd = conjAfter;
  const prefix = normSentence.slice(clauseStart, idx);
  const suffix = normSentence.slice(matchEnd, clauseEnd);
  const prefixRx = locale === "pt-BR" ? NEGATION_PREFIX_PT : NEGATION_PREFIX_EN;
  const suffixRx = locale === "pt-BR" ? NEGATION_SUFFIX_PT : NEGATION_SUFFIX_EN;
  return prefixRx.test(prefix) || suffixRx.test(suffix);
}

/**
 * Extract mentions of critical/urgent findings from report HTML.
 */
export function extractCriticalMentions(html: string, locale?: LocaleKey): ExtractedCriticalMention[] {
  // Replace <br> with newlines before stripping tags to preserve sentence boundaries
  const text = stripTags(html.replace(/<br\s*\/?>/gi, "\n"));
  const results: ExtractedCriticalMention[] = [];
  const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 5);
  const effectiveLocale = locale ?? "pt-BR";

  for (const sentence of sentences) {
    for (const cat of CRITICAL_CATEGORIES) {
      const rx = effectiveLocale === "en-US" ? cat.rxEn : cat.rxPt;
      const match = rx.exec(sentence);
      if (!match) continue;
      // Clause-scoped negation. Skip only when the matched critical term itself
      // is negated within its clause, using the same predicate the gold path and
      // QUAL channel use. This (a) closes the pt-BR gap where bare pertinent
      // negatives ("Sem hemorragia", "Sem fratura") were not filtered and
      // force-FAILed correct reports, and (b) avoids suppressing an affirmed
      // critical that shares a sentence with a negated one ("sem desvio da linha
      // media, mas com hematoma subdural agudo"). A negated match falls through
      // to the next category so a second, affirmed critical in the same sentence
      // is still detected.
      if (isFindingNegated(sentence, match[0], effectiveLocale)) continue;
      results.push({
        text: sentence,
        category: cat.category,
      });
      break; // one affirmed category per sentence
    }
  }

  // Deduplicate by category (keep first mention)
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.category)) return false;
    seen.add(r.category);
    return true;
  });
}

/**
 * Normalize a classification value for comparison.
 * Handles variations like "BI-RADS 4A" vs "BIRADS 4a" vs "4A".
 * Also normalizes Bosniak Roman/Arabic numerals to a canonical form.
 */
export function normalizeClassificationValue(value: string): string {
  const normalizedInput = normalizeLoose(value);
  let result = normalizeLoose(value)
    .replace(/\bacr\s+/i, "")
    .replace(/®|\u00ae/g, "")
    .replace(/bi[-\s]?rads\s*/i, "")
    .replace(/ti[-\s]?rads\s*/i, "")
    .replace(/li[-\s]?rads\s*/i, "")
    .replace(/pi[-\s]?rads\s*/i, "")
    .replace(/lung[-\s]?rads\s*/i, "")
    .replace(/bosniak\s*/i, "")
    .replace(/lr[-\s]?/i, "")
    .replace(/^[-:\s]+/, "")
    .replace(/\s+/g, "")
    .toUpperCase();

  if (/bosniak/i.test(normalizedInput)) {
    const bosniakMap: Record<string, string> = {
      "1": "I", "2": "II", "2F": "IIF", "3": "III", "4": "IV",
      "I": "I", "II": "II", "IIF": "IIF", "III": "III", "IV": "IV",
    };
    if (bosniakMap[result]) {
      result = bosniakMap[result];
    }
  }

  return result;
}
