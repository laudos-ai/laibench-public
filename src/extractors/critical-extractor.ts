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

import { extractCriticalMentions, isNegated, type ExtractedCriticalMention } from "../extract.js";
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
    const norm = normalizeLoose(sentence);
    const matched = goldTokens.filter((t) => norm.includes(t));
    const ratio = goldTokens.length > 0 ? matched.length / goldTokens.length : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestSentence = sentence;
    }
  }
  return bestRatio >= 0.5 ? bestSentence : null;
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
    const extractedMentions = extractCriticalMentions(reportHtml, locale);
    const usedMentions = new Set<number>();

    const truePositives: string[] = [];
    const falseNegatives: string[] = [];

    for (const goldLabel of goldLabels) {
      const goldNorm = normalizeLoose(goldLabel);

      // Try direct substring match first
      if (reportText.includes(goldNorm)) {
        const matchingSentence = findMatchingSentence(reportHtml, goldNorm);
        if (matchingSentence && isNegated(matchingSentence, locale)) {
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
      const goldTokens = goldNorm.split(/\s+/).filter((t) => t.length > 2);
      const matchedTokens = goldTokens.filter((t) => reportText.includes(t));
      const tokenRatio = goldTokens.length > 0 ? matchedTokens.length / goldTokens.length : 0;

      if (tokenRatio >= 0.5) {
        const bestSentence = findBestTokenMatchSentence(reportHtml, goldTokens);
        if (bestSentence && isNegated(bestSentence, locale)) {
          falseNegatives.push(goldLabel);
          continue;
        }
        truePositives.push(goldLabel);
        let bestIdx = -1;
        let bestSim = 0;
        for (let i = 0; i < extractedMentions.length; i++) {
          if (usedMentions.has(i)) continue;
          const mentionNorm = normalizeLoose(extractedMentions[i].text);
          const sim = goldTokens.filter((t) => mentionNorm.includes(t)).length / goldTokens.length;
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

    // False positives: extracted critical mentions not matched to any gold label
    const falsePositives: ExtractedCriticalMention[] = [];
    for (let i = 0; i < extractedMentions.length; i++) {
      if (!usedMentions.has(i)) {
        const mentionText = normalizeLoose(extractedMentions[i].text);
        const hasAnyOverlap = goldLabels.some((gl) => {
          const tokens = normalizeLoose(gl).split(/\s+/).filter((t) => t.length > 2);
          return tokens.some((t) => mentionText.includes(t));
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
