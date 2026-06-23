/**
 * Pluggable critical-finding extractor.
 *
 * The critical-finding gate is the most clinically load-bearing part of the
 * benchmark, and its current detector is keyword/substring + token-overlap
 * matching with negation awareness. That is a known limitation: a trained
 * extractor / entity matcher (e.g. a GREEN- or RadGraph-style model) is the
 * validation roadmap before any headline reliability claim. This module makes
 * the detector a swappable component so that upgrade is a one-file change and
 * the rest of the harness (crit.ts, scoring, pass^k) is unaffected.
 *
 * `KeywordCriticalExtractor` is the default and reproduces the exact prior
 * behavior. `GreenCriticalExtractor` is the integration seam for a validated
 * model-based detector; until a client is wired and validated against
 * radiologist labels, it must not silently replace the default.
 */

import { extractCriticalMentions, isFindingNegated, type ExtractedCriticalMention } from "../extract.js";
import { clinicalComparableText, clinicalTokenCoverage, clinicalTokens } from "../clinical-match.js";
import { normalizeLoose, stripTags } from "../normalize.js";
import type { LocaleKey } from "../types.js";

export type CriticalDetection = {
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: ExtractedCriticalMention[];
  recall: number;
  precision: number;
  f1: number;
};

export type CriticalFindingExtractor = {
  /** stable identifier recorded in provenance/disclosure */
  readonly name: string;
  /** true once validated against radiologist labels; gates headline claims */
  readonly validated: boolean;
  detect(goldLabels: string[], reportHtml: string, locale: LocaleKey): CriticalDetection;
};

// Non-discriminative tokens excluded from the FP-suppression overlap: acuity /
// laterality / size MODIFIERS plus ANATOMY/ORGAN nouns. Both are shared across
// clinically unrelated findings, so neither a shared modifier ("acute") nor a
// shared organ ("aortic") may mask a fabricated critical as "overlapping" an
// unrelated gold label — only a shared LESION/process token (dissection, hemorrhage,
// laceration, ...) should suppress an FP.
const FP_MODIFIER_TOKENS = new Set([
  // modifiers
  "acute", "chronic", "subacute", "agudo", "aguda", "cronico", "cronica", "subagudo",
  "left", "right", "bilateral", "esquerdo", "esquerda", "direito", "direita", "bilaterais",
  "mild", "moderate", "severe", "leve", "moderado", "moderada", "grave", "acentuad",
  "small", "large", "pequeno", "pequena", "grande", "focal", "diffuse", "difuso", "difusa",
  // anatomy / organ nouns
  "aortic", "aorta", "aortica", "hepatic", "hepatico", "hepatica", "liver", "figado",
  "renal", "kidney", "rim", "rins", "splenic", "spleen", "baco", "esplenico",
  "pulmonary", "pulmonar", "lung", "pulmao", "pulmoes", "cerebral", "brain", "cerebro",
  "cardiac", "cardiaco", "heart", "coracao", "pancreatic", "pancreatico", "pancreas",
  "gastric", "gastrico", "intestinal", "vascular", "pleural", "osseo", "bone", "spinal",
]);

// ---- shared helpers (moved verbatim from crit.ts; behavior unchanged) ----

function findMatchingSentence(reportHtml: string, goldNorm: string): string | null {
  const text = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 3);
  for (const sentence of sentences) {
    if (normalizeLoose(sentence).includes(goldNorm)) return sentence;
  }
  return null;
}

function findBestTokenMatchSentence(reportHtml: string, goldTokens: string[]): string | null {
  const text = stripTags(reportHtml.replace(/<br\s*\/?>/gi, "\n"));
  const sentences = text.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 3);
  let bestSentence: string | null = null;
  let bestRatio = 0;
  for (const sentence of sentences) {
    const ratio = clinicalTokenCoverage(goldTokens.join(" "), sentence);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestSentence = sentence;
    }
  }
  return bestRatio >= 0.5 ? bestSentence : null;
}

function lateralitySet(value: string): Set<"right" | "left" | "bilateral"> {
  const n = normalizeLoose(value);
  const sides = new Set<"right" | "left" | "bilateral">();
  if (/\b(?:right|direit[ao]s?)\b/.test(n)) sides.add("right");
  if (/\b(?:left|esquerd[ao]s?)\b/.test(n)) sides.add("left");
  if (/\b(?:bilateral|bilaterais)\b/.test(n)) sides.add("bilateral");
  return sides;
}

function hasLateralityConflict(expectedText: string, observedText: string): boolean {
  const expected = lateralitySet(expectedText);
  if (expected.size === 0) return false;
  const observed = lateralitySet(observedText);
  if (observed.size === 0) return false;
  if (expected.has("bilateral")) return !observed.has("bilateral") && (observed.has("right") !== observed.has("left"));
  if (expected.has("right") && observed.has("left") && !observed.has("right")) return true;
  if (expected.has("left") && observed.has("right") && !observed.has("left")) return true;
  return false;
}

/**
 * Keyword/substring + token-overlap critical-finding matcher with negation
 * awareness. This is the historical default and its output is identical to the
 * previous in-lined `matchCriticalFindings` in crit.ts.
 */
export class KeywordCriticalExtractor implements CriticalFindingExtractor {
  readonly name = "keyword-substring-v1";
  readonly validated = false;

  detect(goldLabels: string[], reportHtml: string, locale: LocaleKey): CriticalDetection {
    const reportText = normalizeLoose(stripTags(reportHtml));
    // Case-PRESERVED report text for token-coverage calls: clinicalTokens expands
    // the case-sensitive "PE" abbreviation (vs "pé"=foot) before folding case, so
    // it must see original case. reportText (already lowercased) is kept only for
    // the literal substring `.includes()` check.
    const reportSource = stripTags(reportHtml);
    const extractedMentions = extractCriticalMentions(reportHtml, locale);
    const usedMentions = new Set<number>();

    const truePositives: string[] = [];
    const falseNegatives: string[] = [];

    for (const goldLabel of goldLabels) {
      const goldNorm = normalizeLoose(goldLabel);
      const comparableGold = clinicalComparableText(goldLabel);

      // Try direct substring match first
      const directMatch = reportText.includes(goldNorm);
      const clinicalExactMatch = comparableGold.length > 0 && clinicalTokenCoverage(goldLabel, reportSource) >= 0.92;
      if (directMatch || clinicalExactMatch) {
        const matchingSentence = directMatch
          ? findMatchingSentence(reportHtml, goldNorm)
          : findBestTokenMatchSentence(reportHtml, clinicalTokens(goldLabel));
        if (matchingSentence && hasLateralityConflict(goldLabel, matchingSentence)) {
          falseNegatives.push(goldLabel);
          continue;
        }
        if (matchingSentence && isFindingNegated(matchingSentence, goldLabel, locale)) {
          falseNegatives.push(goldLabel);
          continue;
        }
        truePositives.push(goldLabel);
        for (let i = 0; i < extractedMentions.length; i++) {
          if (usedMentions.has(i)) continue;
          if (normalizeLoose(extractedMentions[i].text).includes(goldNorm)) {
            usedMentions.add(i);
            break;
          }
        }
        continue;
      }

      // Try token-level matching
      const goldTokens = clinicalTokens(goldLabel);
      const tokenRatio = clinicalTokenCoverage(goldLabel, reportSource);

      if (tokenRatio >= 0.55) {
        const bestSentence = findBestTokenMatchSentence(reportHtml, goldTokens);
        if (bestSentence && hasLateralityConflict(goldLabel, bestSentence)) {
          falseNegatives.push(goldLabel);
          continue;
        }
        if (bestSentence && isFindingNegated(bestSentence, goldLabel, locale)) {
          falseNegatives.push(goldLabel);
          continue;
        }
        truePositives.push(goldLabel);
        let bestIdx = -1;
        let bestSim = 0;
        for (let i = 0; i < extractedMentions.length; i++) {
          if (usedMentions.has(i)) continue;
          const mentionNorm = normalizeLoose(extractedMentions[i].text);
          const sim = clinicalTokenCoverage(goldTokens.join(" "), mentionNorm);
          if (sim > bestSim) {
            bestSim = sim;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0) usedMentions.add(bestIdx);
      } else {
        falseNegatives.push(goldLabel);
      }
    }

    // False positives: extracted critical mentions not matched to any gold label.
    // Pertinent negatives are ALREADY excluded upstream: extractCriticalMentions
    // applies CLAUSE-scoped negation (isFindingNegated on the matched term), so a
    // mention only reaches here if its own critical term is affirmed. The old
    // coarse hasNegationCue(whole sentence) re-check here defeated that scoping —
    // an affirmed critical sharing a sentence with an unrelated negation ("No acute
    // findings but acute hemorrhage in the spleen") was wrongly excused from the FP
    // count, inflating precision in the UNSAFE direction. Removed.
    const falsePositives: ExtractedCriticalMention[] = [];
    for (let i = 0; i < extractedMentions.length; i++) {
      if (!usedMentions.has(i)) {
        // Suppress a mention as "matches some gold" only on SUBSTANTIVE overlap.
        // Acuity/laterality/size modifiers (acute, left, mild, ...) are shared
        // across unrelated findings, so a single shared modifier must not excuse a
        // fabricated affirmed critical from the FP count ("acute appendicitis" gold
        // vs fabricated "acute hemorrhage" — only "acute" overlaps). Strip modifiers
        // from the gold before measuring coverage.
        const hasAnyOverlap = goldLabels.some((gl) => {
          const substantive = clinicalTokens(gl).filter((t) => !FP_MODIFIER_TOKENS.has(t));
          const needle = substantive.length > 0 ? substantive.join(" ") : gl;
          return clinicalTokenCoverage(needle, extractedMentions[i].text) >= 0.25 && !hasLateralityConflict(gl, extractedMentions[i].text);
        });
        if (!hasAnyOverlap) falsePositives.push(extractedMentions[i]);
      }
    }

    const tp = truePositives.length;
    const fn = falseNegatives.length;
    const fp = falsePositives.length;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
    const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;

    return { truePositives, falseNegatives, falsePositives, recall, precision, f1 };
  }
}

/**
 * Client a model-based critical-finding detector (GREEN/RadGraph-style) must
 * implement. Kept abstract so the harness has no hard dependency on any model
 * SDK; a real adapter lives outside the public repo until validated.
 */
export type GreenLikeClient = {
  readonly name: string;
  detect(goldLabels: string[], reportHtml: string, locale: LocaleKey): CriticalDetection;
};

/**
 * Validated model-based extractor seam. Requires an injected client; throws if
 * used without one so a model upgrade can never be assumed silently. Mark
 * `validated: true` only after a radiologist-correlation study (see
 * docs/radiologist-adjudication-protocol.md and the methods-paper roadmap).
 */
export class GreenCriticalExtractor implements CriticalFindingExtractor {
  readonly name: string;
  readonly validated: boolean;
  private readonly client: GreenLikeClient | null;

  constructor(client: GreenLikeClient | null = null, validated = false) {
    this.client = client;
    this.name = client ? `green:${client.name}` : "green:unconfigured";
    this.validated = validated;
  }

  detect(goldLabels: string[], reportHtml: string, locale: LocaleKey): CriticalDetection {
    if (!this.client) {
      throw new Error(
        "GreenCriticalExtractor: no GREEN-like client configured. Inject a validated " +
          "client before using a model-based critical-finding detector (see validation roadmap).",
      );
    }
    return this.client.detect(goldLabels, reportHtml, locale);
  }
}

// ---- default selection (the one-file swap point) ----

let activeExtractor: CriticalFindingExtractor = new KeywordCriticalExtractor();

/** Current critical-finding extractor used by the CRIT evaluator. */
export function getDefaultCriticalExtractor(): CriticalFindingExtractor {
  return activeExtractor;
}

/** Swap the active extractor (e.g. to a validated GREEN adapter). */
export function setDefaultCriticalExtractor(extractor: CriticalFindingExtractor): void {
  activeExtractor = extractor;
}
