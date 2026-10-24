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
 * This module derives critical anchors from the INPUT (affirmed critical-category
 * mentions, with clause-level laterality) and checks the report against them:
 *
 *   C09  every affirmed input critical is preserved: present, affirmed (not
 *        negated) and on the same side.
 *   C10  the report affirms no critical finding the input does not back
 *        (fabricated critical, or a critical moved to the other side).
 *
 * Both are `critical` severity, so either failure caps the case at 59.9 / FAIL
 * through the existing gate. On the gold path the CRIT evaluator owns the CRIT
 * dimension and these structural checks are not in benchmark.ts's gate
 * allowlist, so gold-labelled (controlled) scoring is unchanged by this module.
 *
 * Design bias: C09 (omission) is strict; C10 (fabrication) is conservative —
 * recommendation / differential sentences are skipped and side ambiguity in the
 * source is resolved in the report's favour — because a false FAIL erodes trust
 * as much as a false PASS.
 */

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
  // Drop a "<b>Technique</b> ... " block up to the next bold section label.
  body = body.replace(/<b>([^<]*)<\/b>([\s\S]*?)(?=<b>|$)/gi, (full, label: string) =>
    new RegExp(technique.source, technique.flags.replace("g", "")).test(label) ? " " : full);
  return body;
}

export type Side = "right" | "left" | "bilateral";

export type SourceCriticalAnchor = {
  category: string;
  term: string;
  /** Side stated in the same clause as the term, if any. */
  side: Side | undefined;
  /** All sides mentioned anywhere in the source sentence (ambiguity guard). */
  sentenceSides: Side[];
  sentence: string;
};

export type SourceCriticalStatus = "preserved" | "omitted" | "negated" | "laterality-swap" | "laterality-missing";

export type SourceCriticalOutcome = {
  anchor: SourceCriticalAnchor;
  status: SourceCriticalStatus;
  /** Report sentence that decided the status, when one exists. */
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
  /** Affirmed critical occurrences in the report that were evaluated for C10. */
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
// - NON_LATERAL: side is not a property of the finding (free air, obstruction,
//   tamponade, dissection, ...); sides are ignored entirely.
// - SIDE_REQUIRED: a side stated in the input must also be stated in the report
//   (wrong-side chest tube / fixation / surgery risk); omission of the side fails.
// - everything else: a contradicted side fails, an unstated side is tolerated.
const NON_LATERAL = new Set([
  "perforation", "bowel-obstruction", "cardiac-tamponade", "ruptured-aaa", "mesenteric-ischemia",
  "cauda-equina", "cord-compression", "aortic-dissection", "acute-appendicitis",
  // Direction of a shift ("leftward midline shift") is not the side of the lesion
  // that causes it; inheriting the sentence's side would mislabel it.
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

// Sentences that recommend, hedge toward exclusion or list a differential do not
// AFFIRM a critical finding; C10 must not count them as fabrication.
const NON_ASSERTIVE_RX: Record<LocaleKey, RegExp> = {
  "en-US": /\b(?:recommend\w*|suggest\w*|consider\w*|correlat\w*|follow[- ]?up|evaluate\s+for|assess\s+for|to\s+(?:exclude|rule\s+out)|rule\s+out|r\/o|if\s+clinically|differential|versus|vs)\b/,
  "pt-BR": /\b(?:recomend\w*|suger\w*|sugiro|consider\w*|correlac\w*|controle\s+evolutivo|seguimento|para\s+(?:afastar|excluir|descartar)|afastar|descartar|a\s+criterio|diagnostico\s+diferencial|versus)\b/,
};

const CLAUSE_BOUNDARY_RX = /[,;:]|\b(?:and|with|but|while|e|com|mas|porem|enquanto)\b/g;

function sidesIn(text: string, locale: LocaleKey): Side[] {
  const n = normalizeLoose(text);
  const found = new Set<Side>();
  for (const { rx, side } of SIDE_RX[locale]) if (rx.test(n)) found.add(side);
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

/** Side for an occurrence: its own clause first, else the sentence if unambiguous. */
function occurrenceSide(occ: CriticalOccurrence, locale: LocaleKey): { side: Side | undefined; sentenceSides: Side[] } {
  if (NON_LATERAL.has(occ.category)) return { side: undefined, sentenceSides: [] };
  const sentenceSides = sidesIn(occ.sentence, locale);
  const clauseSides = sidesIn(clauseAround(occ.sentence, occ.index, occ.index + occ.term.length), locale);
  if (clauseSides.length > 0) return { side: collapse(clauseSides), sentenceSides };
  // No side in the clause: inherit the sentence's side only when the sentence is
  // single-sided ("Right hemithorax: large pneumothorax").
  if (sentenceSides.length === 1) return { side: sentenceSides[0], sentenceSides };
  return { side: undefined, sentenceSides };
}

export function sourceCriticalAnchors(findingsInput: string, locale: LocaleKey): SourceCriticalAnchor[] {
  const anchors: SourceCriticalAnchor[] = [];
  const seen = new Set<string>();
  for (const occ of listCriticalOccurrences(findingsInput, locale)) {
    if (occ.negated) continue;
    const { side, sentenceSides } = occurrenceSide(occ, locale);
    const key = `${occ.category}|${side ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({ category: occ.category, term: occ.term, side, sentenceSides, sentence: occ.sentence });
  }
  return anchors;
}

type SideVerdict = "ok" | "swap" | "missing";

function compareSide(anchor: SourceCriticalAnchor, reportSide: Side | undefined): SideVerdict {
  if (!anchor.side) return "ok";
  if (!reportSide) return SIDE_REQUIRED.has(anchor.category) ? "missing" : "ok";
  if (reportSide === anchor.side) return "ok";
  // Source sentence names more than one side: the clause parse may be wrong, so
  // never call a swap the source sentence itself could support.
  if (anchor.sentenceSides.includes(reportSide)) return "ok";
  if (reportSide === "bilateral" && anchor.sentenceSides.includes("bilateral")) return "ok";
  return "swap";
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
  const reportOcc = listCriticalOccurrences(clinicalReportBody(reportHtml, locale), locale).map((occ) => ({ occ, ...occurrenceSide(occ, locale) }));

  const outcomes: SourceCriticalOutcome[] = anchors.map((anchor) => {
    let best: SourceCriticalOutcome = { anchor, status: "omitted" };
    for (const r of reportOcc) {
      if (r.occ.category !== anchor.category) continue;
      let status: SourceCriticalStatus;
      if (r.occ.negated) status = "negated";
      else {
        const v = compareSide(anchor, r.side);
        status = v === "ok" ? "preserved" : v === "swap" ? "laterality-swap" : "laterality-missing";
      }
      if (STATUS_RANK[status] < STATUS_RANK[best.status]) {
        best = { anchor, status, reportSentence: r.occ.sentence, reportSide: r.side };
      }
      if (best.status === "preserved") break;
    }
    return best;
  });

  // ---- C10: fabricated criticals ----
  const licensed = new Map<string, SourceCriticalAnchor[]>();
  for (const a of anchors) {
    for (const cat of [a.category, ...(IMPLIES[a.category] ?? [])]) {
      if (!licensed.has(cat)) licensed.set(cat, []);
      licensed.get(cat)!.push(a);
    }
  }
  const nonAssertive = NON_ASSERTIVE_RX[locale];
  const fabricated: FabricatedCritical[] = [];
  const seenFab = new Set<string>();
  let reportAffirmedCount = 0;
  for (const r of reportOcc) {
    if (r.occ.negated) continue;
    if (nonAssertive.test(normalizeLoose(r.occ.sentence))) continue;
    reportAffirmedCount += 1;
    const backers = licensed.get(r.occ.category);
    let reason: FabricatedCritical["reason"] | null = null;
    if (!backers || backers.length === 0) reason = "not-in-input";
    else if (r.side && backers.every((a) => a.side !== undefined)) {
      const supported = backers.some((a) =>
        a.side === r.side ||
        a.sentenceSides.includes(r.side!) ||
        (a.side === "bilateral" && r.side !== undefined),
      );
      if (!supported) reason = "contralateral";
    }
    if (reason) {
      const key = `${r.occ.category}|${r.side ?? "-"}`;
      if (seenFab.has(key)) continue;
      seenFab.add(key);
      fabricated.push({ category: r.occ.category, term: r.occ.term, side: r.side, sentence: r.occ.sentence, reason });
    }
  }

  return {
    anchors,
    outcomes,
    missed: outcomes.filter((o) => o.status !== "preserved"),
    reportAffirmedCount,
    fabricated,
  };
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
