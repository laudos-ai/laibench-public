/**
 * Adversarial perturbation generators for benchmark robustness testing.
 *
 * Each perturbation takes a (case, gold report) pair and produces a deliberately
 * defective output that the benchmark MUST flag. Used to probe whether the
 * scoring stack catches specific failure modes.
 *
 * All perturbations are deterministic given (caseId, kind) — the seeded PRNG
 * derives its seed from a stable hash of those two inputs.
 */

import type { BenchCase, Dim } from "./types.js";

/** Seeded PRNG (splitmix32) — deterministic per (caseId, kind). */
function makeSeededRng(caseId: string, kind: string): () => number {
  let h = 2166136261;
  const seedKey = `${caseId}::${kind}`;
  for (let i = 0; i < seedKey.length; i++) {
    h ^= seedKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

export type PerturbationKind =
  | "laterality_flip"
  | "negation_drop"
  | "negation_insert"
  | "measurement_scramble"
  | "critical_drop"
  | "critical_invent"
  | "terminology_corrupt"
  | "structure_break";

export type PerturbationSpec = {
  kind: PerturbationKind;
  expectedDims: Dim[];
  expectedSeverity: "critical" | "major" | "minor";
  description: string;
};

export const PERTURBATIONS: Record<PerturbationKind, PerturbationSpec> = {
  laterality_flip: {
    kind: "laterality_flip",
    expectedDims: ["RAG", "CRIT"],
    expectedSeverity: "critical",
    description: "Swap left/right (esquerdo/direito) for at least one finding.",
  },
  negation_drop: {
    kind: "negation_drop",
    expectedDims: ["CRIT"],
    expectedSeverity: "critical",
    description: "Remove a negation token, turning 'no fracture' into 'fracture'.",
  },
  negation_insert: {
    kind: "negation_insert",
    expectedDims: ["CRIT"],
    expectedSeverity: "critical",
    description: "Insert false negation in front of a present finding.",
  },
  measurement_scramble: {
    kind: "measurement_scramble",
    expectedDims: ["RAG", "QUAL"],
    expectedSeverity: "major",
    description: "Replace numeric measurements with implausible values (deterministic per case).",
  },
  critical_drop: {
    kind: "critical_drop",
    expectedDims: ["CRIT"],
    expectedSeverity: "critical",
    description: "Delete every declared critical finding from the report.",
  },
  critical_invent: {
    kind: "critical_invent",
    expectedDims: ["CRIT"],
    expectedSeverity: "critical",
    description: "Add a fabricated critical finding not present in the source.",
  },
  terminology_corrupt: {
    kind: "terminology_corrupt",
    expectedDims: ["TERM", "QUAL"],
    expectedSeverity: "major",
    description: "Replace canonical terminology with colloquial substitutes (≥30 rules per locale).",
  },
  structure_break: {
    kind: "structure_break",
    expectedDims: ["QUAL", "RAG"],
    expectedSeverity: "major",
    description: "Strip required HTML structure (centers, conclusion section, headings).",
  },
};

/**
 * Expanded terminology corruption rules.
 * Goal: catch models that use non-radiological vocabulary instead of canonical terms.
 * pt-BR: 32 rules, en-US: 32 rules.
 */
const TERM_CORRUPT_PT: Array<[RegExp, string]> = [
  [/\bderrame\s+pleural\b/gi, "água no pulmão"],
  [/\bedema\b/gi, "inchaço"],
  [/\bhemorragia\b/gi, "sangramento"],
  [/\binfarto\b/gi, "ataque"],
  [/\baneurisma\b/gi, "bolinha"],
  [/\bmetástase\b/gi, "espalhamento"],
  [/\bcalcificação\b/gi, "endurecimento"],
  [/\bestenose\b/gi, "aperto"],
  [/\boclusão\b/gi, "entupimento"],
  [/\battenuação\b/gi, "intensidade"],
  [/\bhipodens(o|a)\b/gi, "escuro"],
  [/\bhiperdens(o|a)\b/gi, "claro"],
  [/\bisodens(o|a)\b/gi, "neutro"],
  [/\bhiperintens(o|a)\b/gi, "forte"],
  [/\bhipointens(o|a)\b/gi, "fraco"],
  [/\bcontraste\b/gi, "tinta"],
  [/\bcontraste\s+iv\b/gi, "tinta na veia"],
  [/\brealce\b/gi, "brilho"],
  [/\bnódulo\b/gi, "bolinha"],
  [/\bmassa\b/gi, "caroço"],
  [/\bcisto\b/gi, "bolha"],
  [/\bfibrose\b/gi, "endurecimento"],
  [/\bperfusão\b/gi, "circulação"],
  [/\btrombose\b/gi, "coágulo grande"],
  [/\bpneumotórax\b/gi, "ar entre o pulmão"],
  [/\bderivação\b/gi, "tubinho"],
  [/\bestrutura\s+vascular\b/gi, "veias"],
  [/\blinfonodo\b/gi, "íngua"],
  [/\bopacidade\b/gi, "manchinha"],
  [/\bconsolidação\b/gi, "endurecimento do pulmão"],
  [/\bensbroncopatia\b/gi, "doença do pulmão"],
  [/\bderrame\s+pericárdico\b/gi, "água no coração"],
];

const TERM_CORRUPT_EN: Array<[RegExp, string]> = [
  [/\bpleural\s+effusion\b/gi, "water in lung"],
  [/\bedema\b/gi, "swelling"],
  [/\bhemorrhage\b/gi, "bleeding"],
  [/\binfarction\b/gi, "attack"],
  [/\baneurysm\b/gi, "ball"],
  [/\bmetastasis\b/gi, "spread"],
  [/\bcalcification\b/gi, "hardening"],
  [/\bstenosis\b/gi, "narrowing"],
  [/\bocclusion\b/gi, "blockage"],
  [/\battenuation\b/gi, "intensity"],
  [/\bhypodense\b/gi, "dark"],
  [/\bhyperdense\b/gi, "bright"],
  [/\bisodense\b/gi, "neutral"],
  [/\bhyperintense\b/gi, "strong"],
  [/\bhypointense\b/gi, "weak"],
  [/\bcontrast\b/gi, "dye"],
  [/\benhancement\b/gi, "shine"],
  [/\bnodule\b/gi, "spot"],
  [/\bmass\b/gi, "lump"],
  [/\bcyst\b/gi, "blister"],
  [/\bfibrosis\b/gi, "scarring"],
  [/\bperfusion\b/gi, "circulation"],
  [/\bthrombosis\b/gi, "big clot"],
  [/\bpneumothorax\b/gi, "air around lung"],
  [/\bshunt\b/gi, "tube"],
  [/\blymph\s+node\b/gi, "gland"],
  [/\bopacity\b/gi, "smudge"],
  [/\bconsolidation\b/gi, "lung hardening"],
  [/\bpericardial\s+effusion\b/gi, "fluid in heart"],
  [/\bventriculomegaly\b/gi, "big chambers"],
  [/\bbronchiectasis\b/gi, "wide tubes"],
  [/\batelectasis\b/gi, "lung collapse"],
];

const PT_LAT_FLIP = /\bdireit(o|a)\b|\besquerd(o|a)\b/gi;
const PT_NEGATION_TOKENS: RegExp[] = [
  /\bsem\s+/gi,
  /\bnão\s+há\s+/gi,
  /\bnão\s+/gi,
  /\bausência\s+de\s+/gi,
  /\bausente\s+/gi,
  /\bnegativ(o|a)\s+(para|de)\s+/gi,
];
const EN_NEGATION_TOKENS: RegExp[] = [
  /\bno\s+evidence\s+of\s+/gi,
  /\bno\s+/gi,
  /\babsence\s+of\s+/gi,
  /\babsent\s+/gi,
  /\bnegative\s+for\s+/gi,
  /\bwithout\s+/gi,
];

function pickLocale(c: BenchCase): "pt-BR" | "en-US" {
  return c.locale === "en-US" ? "en-US" : "pt-BR";
}

function flipLaterality(text: string, locale: "pt-BR" | "en-US"): string {
  // Two-pass with placeholders to avoid double-flip.
  if (locale === "pt-BR") {
    let out = text.replace(/\bdireit(o|a)\b/gi, (m) => (m.endsWith("a") ? "__LAT_R_F__" : "__LAT_R_M__"));
    out = out.replace(/\besquerd(o|a)\b/gi, (m) => (m.endsWith("a") ? "__LAT_L_F__" : "__LAT_L_M__"));
    out = out.replace(/__LAT_R_F__/g, "esquerda").replace(/__LAT_R_M__/g, "esquerdo");
    out = out.replace(/__LAT_L_F__/g, "direita").replace(/__LAT_L_M__/g, "direito");
    return out;
  }
  let out = text.replace(/\bright\b/gi, "__LAT_R__").replace(/\bleft\b/gi, "__LAT_L__");
  out = out.replace(/__LAT_R__/g, "left").replace(/__LAT_L__/g, "right");
  return out;
}

function dropNegation(text: string, locale: "pt-BR" | "en-US"): string {
  const tokens = locale === "pt-BR" ? PT_NEGATION_TOKENS : EN_NEGATION_TOKENS;
  let out = text;
  for (const t of tokens) out = out.replace(t, "");
  return out;
}

function insertFalseNegation(text: string, locale: "pt-BR" | "en-US"): string {
  const prefix = locale === "pt-BR" ? "não há " : "no evidence of ";
  // Insert before the first sentence start that begins with a non-empty clause.
  const replaced = text.replace(/(\.\s+)([A-Za-zÀ-ú])/, (_, p1, p2) => `${p1}${prefix}${p2}`);
  if (replaced !== text) return replaced;
  // Fallback: prepend at start.
  return prefix + text;
}

function scrambleMeasurements(text: string, rng: () => number): string {
  return text.replace(/(\d+(?:[.,]\d+)?)\s*(mm|cm|ml|mL)/gi, (_match, num: string, unit: string) => {
    const n = parseFloat(num.replace(",", "."));
    const factor = rng() < 0.5 ? 0.3 : 4.0;
    const scrambled = (n * factor + 7).toFixed(1).replace(".", ",");
    return `${scrambled} ${unit}`;
  });
}

function dropCritical(text: string, criticalFindings: string[] | undefined): string {
  if (!criticalFindings || criticalFindings.length === 0) return text;
  let out = text;
  for (const target of criticalFindings) {
    const trimmed = target.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/).slice(0, 3).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    if (!tokens) continue;
    const sentenceRegex = new RegExp(`[^.!?]*${tokens}[^.!?]*[.!?]`, "i");
    out = out.replace(sentenceRegex, "");
    // Also strip residual mentions of the keyword anywhere.
    const wordRegex = new RegExp(tokens, "gi");
    out = out.replace(wordRegex, "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function inventCritical(text: string, locale: "pt-BR" | "en-US", rng: () => number): string {
  const fabPT = [
    "Identificada hemorragia subaracnoidea aguda em sulcos parietais bilaterais. ",
    "Detectada nova metástase hepática segmento VII medindo 32 mm. ",
    "Identificado tromboembolismo pulmonar agudo em ramos lobares direitos. ",
  ];
  const fabEN = [
    "Acute subarachnoid hemorrhage identified in bilateral parietal sulci. ",
    "New hepatic metastasis identified in segment VII measuring 32 mm. ",
    "Acute pulmonary embolism identified in right lobar branches. ",
  ];
  const pool = locale === "pt-BR" ? fabPT : fabEN;
  const fab = pool[Math.floor(rng() * pool.length)];
  const idx = Math.max(0, Math.floor(text.length / 2));
  return text.slice(0, idx) + fab + text.slice(idx);
}

function corruptTerminology(text: string, locale: "pt-BR" | "en-US"): string {
  const rules = locale === "pt-BR" ? TERM_CORRUPT_PT : TERM_CORRUPT_EN;
  let out = text;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

function breakStructure(text: string): string {
  let out = text;
  out = out.replace(/<center>/gi, "").replace(/<\/center>/gi, "");
  out = out.replace(/<b>/gi, "").replace(/<\/b>/gi, "");
  out = out.replace(/<br\s*\/?>/gi, " ");
  // Remove common section labels.
  out = out.replace(/\b(t[eé]cnica|achados|aspectos|conclus[aã]o|impress[aã]o|technique|findings|impression|conclusion):/gi, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Apply a named perturbation to a gold-reference text.
 * Deterministic per (case.id, kind).
 */
export function applyPerturbation(kind: PerturbationKind, c: BenchCase, sourceText: string): string {
  const locale = pickLocale(c);
  const rng = makeSeededRng(c.id, kind);
  switch (kind) {
    case "laterality_flip":
      return flipLaterality(sourceText, locale);
    case "negation_drop":
      return dropNegation(sourceText, locale);
    case "negation_insert":
      return insertFalseNegation(sourceText, locale);
    case "measurement_scramble":
      return scrambleMeasurements(sourceText, rng);
    case "critical_drop":
      return dropCritical(sourceText, c.criticalFindings);
    case "critical_invent":
      return inventCritical(sourceText, locale, rng);
    case "terminology_corrupt":
      return corruptTerminology(sourceText, locale);
    case "structure_break":
      return breakStructure(sourceText);
  }
}

export type PerturbedSample = {
  caseId: string;
  kind: PerturbationKind;
  text: string;
  spec: PerturbationSpec;
};

export function buildPerturbationMatrix(c: BenchCase, sourceText: string): PerturbedSample[] {
  const out: PerturbedSample[] = [];
  for (const kind of Object.keys(PERTURBATIONS) as PerturbationKind[]) {
    out.push({
      caseId: c.id,
      kind,
      text: applyPerturbation(kind, c, sourceText),
      spec: PERTURBATIONS[kind],
    });
  }
  return out;
}

/**
 * Catch-rate of a benchmark given perturbed-sample outcomes.
 */
export type RobustnessReport = {
  totalSamples: number;
  perKind: Array<{ kind: PerturbationKind; n: number; caught: number; rate: number }>;
  overallCatchRate: number;
  verdict: "robust" | "leaky" | "broken";
};

export function summarizeRobustness(
  outcomes: Array<{ kind: PerturbationKind; caught: boolean }>,
): RobustnessReport {
  const byKind = new Map<PerturbationKind, { n: number; caught: number }>();
  for (const o of outcomes) {
    if (!byKind.has(o.kind)) byKind.set(o.kind, { n: 0, caught: 0 });
    const e = byKind.get(o.kind)!;
    e.n++;
    if (o.caught) e.caught++;
  }
  const perKind = [...byKind.entries()]
    .map(([kind, { n, caught }]) => ({
      kind,
      n,
      caught,
      rate: n === 0 ? 0 : Number(((caught / n) * 100).toFixed(2)),
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const total = outcomes.length;
  const totalCaught = outcomes.filter((o) => o.caught).length;
  const overall = total === 0 ? 0 : Number(((totalCaught / total) * 100).toFixed(2));
  const verdict: RobustnessReport["verdict"] = overall >= 90 ? "robust" : overall >= 70 ? "leaky" : "broken";
  return { totalSamples: total, perKind, overallCatchRate: overall, verdict };
}
