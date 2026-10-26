/**
 * Source-anchored critical-finding gate (v3.11.0).
 *
 * The task LAIBench scores is finding-to-report fidelity: the input findings ARE
 * the evidence. On the no-gold (input-only) path — every public synthetic case,
 * and any user's own cases without answer keys — v3.10.0 had no check tying the
 * CRIT dimension to the critical findings stated in the input. A polished report
 * that omitted a stated "large pneumothorax" scored PASS 100, and a report that
 * swapped a right pneumothorax to the left scored PASS. That contradicts the
 * benchmark's prime directive ("a beautiful report that misses a pneumothorax
 * must fail").
 *
 * This module derives critical anchors from the INPUT (affirmed, current
 * critical-category mentions, with clause-level laterality) and checks the
 * report body against them:
 *
 *   C09  every input critical is preserved: present, affirmed (not denied, not
 *        merely hypothetical) and on the same side.
 *   C10  the report affirms no critical finding the input does not back (a new
 *        critical, or a critical moved to the other side).
 *
 * Both are `critical` severity, so either failure caps the case at 59.9 / FAIL.
 * They are structural checks: benchmark.ts strips them whenever a case carries
 * any gold data, so gold-labelled (controlled) verdicts never see them.
 *
 * Criticals are recognized from the fixed, versioned vocabulary in
 * extract.ts (CRITICAL_CATEGORIES); a critical phrased outside it is not caught.
 */

import { clinicalTokenCoverage, clinicalTokens } from "../clinical-match.js";
import { listCriticalOccurrences, type CriticalOccurrence } from "../extract.js";
import { getLocale } from "../locales/index.js";
import { normalizeLoose } from "../normalize.js";
import type { LocaleKey } from "../types.js";

/**
 * The clinical body of a report: everything except the <center> title block and
 * the Technique section. The title and technique restate the EXAM, which often
 * names the clinical question ("CT angiography for pulmonary embolism"); letting
 * them count would credit an omitted critical (C09) or flag a fabricated one
 * (C10) from the indication alone.
 */
export function clinicalReportBody(html: string, locale: LocaleKey): string {
  const technique = getLocale(locale).sections.technique;
  let body = html.replace(/<center>[\s\S]*?<\/center>/gi, " ");
  // Technique and clinical-information sections are not findings: "Indicação:
  // suspeita de apendicite" restates the request, it does not report appendicitis.
  const notFindings = new RegExp(`^\\s*(?:${technique.source}|indica[çc][ãa]o|hist[óo]ria cl[íi]nica|dados cl[íi]nicos|clinical (?:indication|history)|indication|history)`, "i");
  // Such a section ends at the next bold label, a blank line, or after two lines:
  // when the next header is not bold ("DESCRIÇÃO") or missing, the findings that
  // follow must not be swallowed with it.
  body = body.replace(/<b>([^<]*)<\/b>((?:(?!<br><br>|<b>)[\s\S])*?)(?=<b>|<br><br>|$)/gi, (full, label: string, content: string) => {
    if (!notFindings.test(label)) return full;
    const lines = content.split("<br>");
    // More than two lines with no break: only the first is technique.
    const kept = lines.filter((l) => l.trim()).length > 2 ? lines.slice(lines.findIndex((l) => l.trim()) + 1).join("<br>") : "";
    return ` <br>${kept}`;
  });
  return body;
}

export type Side = "right" | "left" | "bilateral";
type SideSource = "clause" | "sentence";

export type SourceCriticalAnchor = {
  category: string;
  term: string;
  side: Side | undefined;
  /** "clause": the side is stated next to the finding; "sentence": inherited. */
  sideSource: SideSource | undefined;
  sentenceSides: Side[];
  /** Anatomical context of the finding (e.g. "fifth rib", "clavicle"). */
  context: string[];
  sentence: string;
};

export type SourceCriticalStatus = "preserved" | "omitted" | "negated" | "laterality-swap" | "laterality-missing";

export type SourceCriticalOutcome = {
  anchor: SourceCriticalAnchor;
  status: SourceCriticalStatus;
  reportSentence?: string;
  reportSide?: Side;
};

export type FabricatedCritical = {
  category: string;
  term: string;
  side: Side | undefined;
  sentence: string;
  reason: "not-in-input" | "contralateral";
};

export type SourceCriticalResult = {
  anchors: SourceCriticalAnchor[];
  outcomes: SourceCriticalOutcome[];
  missed: SourceCriticalOutcome[];
  reportAffirmedCount: number;
  fabricated: FabricatedCritical[];
};

// Categories whose presence in the source licenses a broader category in the
// report (the broader finding is entailed by the narrower one).
const IMPLIES: Record<string, string[]> = {
  "tension-pneumothorax": ["pneumothorax"],
  "epidural-hematoma": ["acute-bleed"],
  "ruptured-aaa": ["acute-bleed"],
  "midline-shift": ["mass-effect"],
};

// Laterality policy per critical category.
// - NON_LATERAL: side is not a property of the finding; sides are ignored.
// - SIDE_REQUIRED: a side stated in the input must be stated in the report.
// - everything else: a contradicted side fails, an unstated side is tolerated.
const NON_LATERAL = new Set([
  "perforation", "bowel-obstruction", "cardiac-tamponade", "ruptured-aaa", "mesenteric-ischemia",
  "cauda-equina", "cord-compression", "aortic-dissection", "acute-appendicitis", "pneumomediastinum",
  // Direction of a shift ("leftward midline shift") is not the side of the lesion.
  "midline-shift", "mass-effect",
]);
const SIDE_REQUIRED = new Set([
  "pneumothorax", "tension-pneumothorax", "fracture", "acute-bleed", "epidural-hematoma",
  "testicular-torsion", "ovarian-torsion", "stroke",
]);

const SIDE_RX: Record<LocaleKey, Array<{ rx: RegExp; side: Side }>> = {
  "en-US": [
    { rx: /\bright\b/, side: "right" },
    { rx: /\bleft\b/, side: "left" },
    { rx: /\b(?:bilateral(?:ly)?|both)\b/, side: "bilateral" },
  ],
  "pt-BR": [
    { rx: /\bdireit[ao]s?\b/, side: "right" },
    { rx: /\besquerd[ao]s?\b/, side: "left" },
    { rx: /\b(?:bilaterai?s?|bilateralmente|ambos|ambas)\b/, side: "bilateral" },
  ],
};
// Uppercase single-letter sides ("R pneumothorax"), matched on the raw text so
// "r/o" or "L4" never count.
const RAW_SIDE_RX: Array<{ rx: RegExp; side: Side }> = [
  { rx: /(?<![\w/])R(?![\w/])/, side: "right" },
  { rx: /(?<![\w/])L(?![\w/\d-])/, side: "left" },
];

// A mention that only raises a question ("to evaluate for X", "clinical
// question: X", "rule out X") affirms nothing: it neither preserves an input
// critical (C09) nor fabricates one (C10). Management verbs ("recommend",
// "suggest", "communicated") do NOT make a finding hypothetical.
const HYPOTHETICAL_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:evaluate|evaluation|assess|assessment|screen)\s+for\b|\bto\s+(?:exclude|rule\s+out)\b|\brule\s+out\b|\br\/o\b|\bquestion\s+of\b|\bclinical\s+(?:question|indication|history|concern)\b|\bindication\b|\bhistory\s+of\b|\bif\s+(?:clinically\s+)?(?:concern|indicated|suspected)\b|\b(?:does|do)\s+not\s+(?:exclude|rule\s+out)\b|\bcannot\s+(?:be\s+)?(?:exclude|excluded|ruled\s+out)\b|\bnot\s+excluded\b|\bif\s+(?:there\s+is|present|any)\b/,
  // "não exclui (completamente) apendicite" states that it is NOT ruled out: no assertion.
  "pt-BR": /\b(?:para\s+(?:afastar|excluir|descartar|avaliar|investigar)|afastar|descartar|investigacao\s+de|pesquisa\s+de|indicacao|historia\s+(?:clinica|de)|hipotese\s+de|suspeita\s+clinica\s+de|nao\s+(?:se\s+)?(?:pode\s+)?(?:exclui|excluir|excluem|afasta|afastar|descarta|descartar)|sem\s+(?:excluir|afastar)|se\s+houver|caso\s+(?:haja|exista|houver))\b/,
};
// Differential phrasing is also not counted as a fabrication (C10 only).
const DIFFERENTIAL_RX = /\b(?:differential|versus|vs|diagnostico\s+diferencial)\b/;

// Input mentions that are not current findings: resolved, old/healed/chronic,
// or prior. They describe history, not something the report must carry.
const NOT_CURRENT_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:resolved|resolution|resolving|no\s+longer|previously\s+seen|prior|old|healed|healing|remote|chronic|status\s+post|s\/p)\b/,
  "pt-BR": /\b(?:resolvid[oa]s?|resolucao|nao\s+mais|previ[oa]s?|antig[oa]s?|consolidad[oa]s?|cronic[oa]s?|sequela\w*|pos-operatori[oa])\b/,
};
const RESOLVED_SENTENCE_RX = /\b(?:has|have)\s+resolved\b|\bresolved\b|\bresolvid[oa]s?\b/;

const CLAUSE_BOUNDARY_RX = /[,;:]|\b(?:and|with|but|while|e|com|mas|porem|enquanto)\b/g;
const CONTEXT_STOP = new Set(["acute", "large", "small", "moderate", "mild", "severe", "tiny", "massive", "displaced", "nondisplaced",
  "agudo", "aguda", "volumoso", "volumosa", "pequeno", "pequena", "moderado", "moderada", "discreto", "discreta", "extensive", "partial", "collapse"]);
const SIDE_TOKEN_RX = /^(?:right|left|bilateral|bilaterally|both|direit\w*|esquerd\w*|bilatera\w*)$/;

function sidesIn(text: string, locale: LocaleKey): Side[] {
  const n = normalizeLoose(text);
  const found = new Set<Side>();
  for (const { rx, side } of SIDE_RX[locale]) if (rx.test(n)) found.add(side);
  if (locale === "en-US") for (const { rx, side } of RAW_SIDE_RX) if (rx.test(text)) found.add(side);
  if (found.has("right") && found.has("left")) found.add("bilateral");
  return [...found];
}

function collapse(sides: Side[]): Side | undefined {
  if (sides.length === 0) return undefined;
  if (sides.includes("bilateral")) return "bilateral";
  return sides[0];
}

/** Clause (bounded by punctuation and conjunctions) that contains [start, end). */
function clauseAround(sentence: string, start: number, end: number): string {
  let left = 0;
  let right = sentence.length;
  const lower = sentence.toLowerCase();
  CLAUSE_BOUNDARY_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_BOUNDARY_RX.exec(lower)) !== null) {
    const bStart = m.index;
    const bEnd = m.index + m[0].length;
    if (bEnd <= start) left = Math.max(left, bEnd);
    else if (bStart >= end) { right = Math.min(right, bStart); break; }
    if (CLAUSE_BOUNDARY_RX.lastIndex === m.index) CLAUSE_BOUNDARY_RX.lastIndex++;
  }
  return sentence.slice(left, right);
}

type SidedOccurrence = { occ: CriticalOccurrence; side: Side | undefined; sideSource: SideSource | undefined; sentenceSides: Side[]; clause: string };

function analyse(occ: CriticalOccurrence, locale: LocaleKey): SidedOccurrence {
  const clause = clauseAround(occ.sentence, occ.index, occ.index + occ.term.length);
  if (NON_LATERAL.has(occ.category)) return { occ, side: undefined, sideSource: undefined, sentenceSides: [], clause };
  const sentenceSides = sidesIn(occ.sentence, locale);
  const clauseSides = sidesIn(clause, locale);
  if (clauseSides.length > 0) return { occ, side: collapse(clauseSides), sideSource: "clause", sentenceSides, clause };
  if (sentenceSides.length === 1) return { occ, side: sentenceSides[0], sideSource: "sentence", sentenceSides, clause };
  return { occ, side: undefined, sideSource: undefined, sentenceSides, clause };
}

function isHypothetical(occ: CriticalOccurrence, locale: LocaleKey): boolean {
  return HYPOTHETICAL_RX[locale].test(normalizeLoose(occ.sentence.slice(0, occ.index)));
}

function isNotCurrent(a: SidedOccurrence, locale: LocaleKey): boolean {
  const clause = normalizeLoose(a.clause);
  if (/\bacute\s+on\s+chronic\b|\bagud[oa]\s+sobre\s+cronic/.test(clause)) return false;
  return NOT_CURRENT_RX[locale].test(clause) || RESOLVED_SENTENCE_RX.test(normalizeLoose(a.occ.sentence));
}

function contextOf(a: SidedOccurrence): string[] {
  const termTokens = new Set(clinicalTokens(a.occ.term));
  return clinicalTokens(a.clause).filter((t) => !termTokens.has(t) && !CONTEXT_STOP.has(t) && !SIDE_TOKEN_RX.test(t));
}

export function sourceCriticalAnchors(findingsInput: string, locale: LocaleKey): SourceCriticalAnchor[] {
  const anchors: SourceCriticalAnchor[] = [];
  const seen = new Set<string>();
  for (const occ of listCriticalOccurrences(findingsInput, locale)) {
    if (occ.negated || isHypothetical(occ, locale)) continue;
    const a = analyse(occ, locale);
    if (isNotCurrent(a, locale)) continue;
    const key = `${occ.category}|${a.side ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ category: occ.category, term: occ.term, side: a.side, sideSource: a.sideSource, sentenceSides: a.sentenceSides, context: contextOf(a), sentence: occ.sentence });
  }
  return anchors;
}

type SideVerdict = "ok" | "swap" | "missing";

function compareSide(anchor: SourceCriticalAnchor, reportSide: Side | undefined): SideVerdict {
  if (!anchor.side) return "ok";
  if (!reportSide) return SIDE_REQUIRED.has(anchor.category) ? "missing" : "ok";
  if (reportSide === anchor.side) return "ok";
  // A bilateral mention covers either side (an over-call is C10's job).
  if (reportSide === "bilateral" && anchor.side !== "bilateral") return "ok";
  // The input's side was only inherited from a sentence naming several sides:
  // the parse is uncertain, so accept any side that sentence names.
  if (anchor.sideSource === "sentence" && anchor.sentenceSides.includes(reportSide)) return "ok";
  return "swap";
}

/** Side word nearest (in characters) to any context token inside a sentence. */
function nearestSideToContext(sentence: string, context: string[], locale: LocaleKey): Side | undefined {
  const n = normalizeLoose(sentence);
  const positions: number[] = [];
  for (const t of context) {
    const stem = t.slice(0, Math.max(4, Math.min(t.length, 6)));
    for (let i = n.indexOf(stem); i >= 0; i = n.indexOf(stem, i + 1)) positions.push(i);
  }
  if (positions.length === 0) return undefined;
  let best: { d: number; side: Side } | null = null;
  for (const { rx, side } of SIDE_RX[locale]) {
    const g = new RegExp(rx.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(n)) !== null) {
      const at = m.index;
      const d = Math.min(...positions.map((p) => Math.abs(p - at)));
      if (!best || d < best.d) best = { d, side };
    }
  }
  return best?.side;
}

const STATUS_RANK: Record<SourceCriticalStatus, number> = {
  "preserved": 0,
  "laterality-swap": 1,
  "laterality-missing": 2,
  "negated": 3,
  "omitted": 4,
};

export function evaluateSourceCriticals(reportHtml: string, findingsInput: string, locale: LocaleKey): SourceCriticalResult {
  const anchors = sourceCriticalAnchors(findingsInput, locale);
  const reportOcc = listCriticalOccurrences(clinicalReportBody(reportHtml, locale), locale)
    .map((occ) => ({ ...analyse(occ, locale), hypothetical: isHypothetical(occ, locale) }));
  const anchorsByCategory = new Map<string, SourceCriticalAnchor[]>();
  for (const a of anchors) anchorsByCategory.set(a.category, [...(anchorsByCategory.get(a.category) ?? []), a]);

  const outcomes: SourceCriticalOutcome[] = anchors.map((anchor) => {
    const siblings = (anchorsByCategory.get(anchor.category) ?? []).filter((a) => a !== anchor);
    // Two or more criticals of the same category with different sides ("right
    // rib fracture", "left clavicle fracture"): a mention counts for THIS anchor
    // only if it carries this anchor's anatomical context, and its side is read
    // next to that context, so swapping both sides cannot pass.
    const needsContext = siblings.some((s) => s.side !== anchor.side) && anchor.context.length > 0;
    let candidates = reportOcc.filter((r) => r.occ.category === anchor.category && !r.hypothetical);
    if (needsContext) {
      const ctx = anchor.context.join(" ");
      candidates = candidates.filter((r) => clinicalTokenCoverage(ctx, r.occ.sentence) > 0)
        .map((r) => {
          const inClause = clinicalTokenCoverage(ctx, r.clause) > 0;
          const side = inClause ? r.side : nearestSideToContext(r.occ.sentence, anchor.context, locale) ?? r.side;
          return { ...r, side, sideSource: "clause" as SideSource };
        });
    }
    let best: SourceCriticalOutcome = { anchor, status: "omitted" };
    for (const r of candidates) {
      let status: SourceCriticalStatus;
      if (r.occ.negated) status = "negated";
      else {
        const v = compareSide(anchor, r.side);
        status = v === "ok" ? "preserved" : v === "swap" ? "laterality-swap" : "laterality-missing";
      }
      if (STATUS_RANK[status] < STATUS_RANK[best.status]) best = { anchor, status, reportSentence: r.occ.sentence, reportSide: r.side };
      if (best.status === "preserved") break;
    }
    // A bilateral input critical needs both sides somewhere in the report.
    if (best.status === "preserved" && anchor.side === "bilateral") {
      const sides = new Set(candidates.filter((r) => !r.occ.negated).flatMap((r) => (r.side ? [r.side] : [])));
      if (!sides.has("bilateral") && !(sides.has("right") && sides.has("left"))) best = { ...best, status: "laterality-missing" };
    }
    return best;
  });

  // ---- C10: fabricated criticals ----
  const licensed = new Map<string, SourceCriticalAnchor[]>();
  for (const a of anchors) {
    for (const cat of [a.category, ...(IMPLIES[a.category] ?? [])]) licensed.set(cat, [...(licensed.get(cat) ?? []), a]);
  }
  const fabricated: FabricatedCritical[] = [];
  const seenFab = new Set<string>();
  let reportAffirmedCount = 0;
  for (const r of reportOcc) {
    if (r.occ.negated || r.hypothetical) continue;
    if (DIFFERENTIAL_RX.test(normalizeLoose(r.clause))) continue;
    reportAffirmedCount += 1;
    const backers = licensed.get(r.occ.category);
    let reason: FabricatedCritical["reason"] | null = null;
    if (!backers || backers.length === 0) reason = "not-in-input";
    else if (r.side && backers.every((a) => a.side !== undefined)) {
      const sides = new Set(backers.map((a) => a.side));
      const lenient = (side: Side) => backers.some((a) => a.sideSource === "sentence" && a.sentenceSides.includes(side));
      let supported = r.side === "bilateral"
        ? sides.has("bilateral") || (sides.has("right") && sides.has("left")) || lenient("bilateral")
        : sides.has(r.side) || sides.has("bilateral") || lenient(r.side);
      // One critical word can serve two findings in the input ("fracture of the
      // right fifth rib and of the left clavicle"): accept the report's side when
      // the input puts that side next to the same anatomy.
      if (!supported) {
        const ctx = contextOf(r);
        if (ctx.length > 0) supported = backers.some((a) => nearestSideToContext(a.sentence, ctx, locale) === r.side);
      }
      if (!supported) reason = "contralateral";
    }
    if (reason) {
      const key = `${r.occ.category}|${r.side ?? "-"}`;
      if (seenFab.has(key)) continue;
      seenFab.add(key);
      fabricated.push({ category: r.occ.category, term: r.occ.term, side: r.side, sentence: r.occ.sentence, reason });
    }
  }

  return { anchors, outcomes, missed: outcomes.filter((o) => o.status !== "preserved"), reportAffirmedCount, fabricated };
}

function label(term: string, side: Side | undefined): string {
  return side ? `${side} ${term.toLowerCase()}` : term.toLowerCase();
}

/** Human-readable evidence for the C09 check. */
export function describeSourceCriticalOutcomes(outcomes: SourceCriticalOutcome[]): string {
  if (outcomes.length === 0) return "no affirmed critical finding in input";
  return outcomes.map((o) => {
    const name = label(o.anchor.term, o.anchor.side);
    switch (o.status) {
      case "preserved": return `preserved: ${name}`;
      case "omitted": return `omitted: ${name}`;
      case "negated": return `negated in report: ${name}`;
      case "laterality-swap": return `laterality swap: ${name} → ${o.reportSide ?? "?"}`;
      case "laterality-missing": return `laterality missing: ${name}`;
    }
  }).join(" · ");
}

/** Human-readable evidence for the C10 check. */
export function describeFabricated(fabricated: FabricatedCritical[]): string {
  if (fabricated.length === 0) return "ok";
  return fabricated.map((f) => f.reason === "contralateral"
    ? `contralateral critical not in input: ${label(f.term, f.side)}`
    : `critical not in input: ${label(f.term, f.side)}`).join(" · ");
}
