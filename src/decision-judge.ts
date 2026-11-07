/**
 * Decision judge (shadow mode, v1): a calibrated, lower-only judge built on a
 * decision model served by the OpenRouter Decisions API.
 *
 * Why a decision model fits LAIBench's judge slot:
 * - The judge's job is a set of yes/no and pick-one questions about a report
 *   against its input findings ("is the input's pneumothorax kept, denied or
 *   dropped?", "does the report invent a critical finding?"). A decision model
 *   answers exactly that, with a probability per answer, at a fraction of the
 *   cost of a generative judge.
 * - The report travels as STATE data, never as instructions, so a report that
 *   tries to talk to its grader has no channel to do so.
 *
 * Invariants (tested in decision-judge.test.ts):
 * 1. Lower-only. The judge returns 100 for a dimension unless it is confident of
 *    an error, so MIN(deterministic, judge) can only go down. TERM/GUIDE/RAG are
 *    never touched (no opinion).
 * 2. Confident or silent. An error moves the score only at P >= VETO_P (critical)
 *    or LOWER_P (major). The band [REVIEW_P, threshold) changes nothing and is
 *    flagged for human adjudication instead.
 * 3. Refusals and malformed answers are "no opinion", never a guess.
 * 4. Reproducible. Model must be pinned; questions, thresholds and penalties are
 *    bound into decisionJudgeConfigHash.
 *
 * This module is NOT reachable from the scoring entrypoints: it runs in shadow
 * (scripts/decision-shadow.ts) and calibration (scripts/decision-calibrate.ts)
 * so the published scorer and its scoringHash are unchanged until the judge has
 * earned promotion. See docs/decision-judge.md.
 */
import { sha256 } from "./hash.js";
import { listCriticalOccurrences } from "./extract.js";
import { abnormalInputClauses } from "./evaluators/source-findings.js";
import { UsageError } from "./errors.js";
import type { DecisionAnswer, DecisionClient, DecisionQuestion, DecisionRequest, DecisionResponse } from "./providers/decisions.js";
import type { BenchCase, JudgeFailure, JudgeResult, LocaleKey } from "./types.js";

export const DECISION_JUDGE_VERSION = "1.0.0";
/**
 * The decision model is configuration, not code: LAIBENCH_DECISION_MODEL holds a
 * pinned "<vendor>/<model>-<version>" id. The resolved id is recorded in every
 * judgement and bound into decisionJudgeConfigHash.
 */
export function decisionModelFromEnv(env: Record<string, string | undefined> = process.env): string {
  const model = env.LAIBENCH_DECISION_MODEL?.trim();
  if (!model) throw new UsageError("Set LAIBENCH_DECISION_MODEL to a pinned decision model id (<vendor>/<model>-<version>).");
  return model;
}

/**
 * Thresholds. Each one names the cost of the mistake it guards.
 * - VETO_P: a false veto fails a correct report outright (worst error a judge can
 *   make in a lower-only design), so a critical error needs P >= 0.9.
 * - LOWER_P: a false major error costs up to 40 points on QUAL; same bar.
 * - REVIEW_P: between REVIEW_P and the threshold the judge is unsure. It changes
 *   nothing and the case goes to the human adjudication queue.
 * Thresholds do not carry over between models: re-run scripts/decision-calibrate.ts
 * after any model change.
 */
export const VETO_P = 0.9;
export const LOWER_P = 0.9;
export const REVIEW_P = 0.5;

/** Dimension values the judge emits. 100 = no opinion (MIN leaves det untouched). */
export const CRIT_ON_VETO = 40;
export const QUAL_ON_MAJOR = 60;

export type QuestionKind =
  | "critical_handling"
  | "invents_critical"
  | "normal_despite_abnormal"
  | "side_changed"
  | "measurement_changed"
  | "abnormal_omitted"
  | "self_contradiction";

export type QuestionMeta = { key: string; kind: QuestionKind; term?: string; category?: string; inputSide?: string | null };

export type DecisionFlag = {
  key: string;
  kind: QuestionKind;
  term?: string;
  /** Probability that the report has this error (0..1), or null on refusal. */
  pError: number | null;
  band: "error" | "review" | "clear" | "refused";
};

const CRITICAL_EXAMPLES = "pneumothorax, intracranial hemorrhage or hematoma, pulmonary embolism, aortic dissection, acute infarct or stroke, fracture, bowel obstruction, perforation or free air, torsion, cord compression";

/** Question templates. `{term}` and `{side}` are filled per case. Bound into the config hash. */
export const QUESTION_TEMPLATES = {
  critical_handling: {
    instructions:
      "`input_findings` states this critical finding as present: \"{term}\"{side}. How does `report` handle it? Judge the clinical meaning, not wording: synonyms and abbreviations count as the same finding.",
    criteria: {
      kept: "The report states the finding as present, with the same side as the input (or neither gives a side).",
      other_side: "The report states the finding as present but on the opposite side from the input.",
      side_dropped: "The report states the finding as present but gives no side although the input does.",
      stated_absent: "The report says the finding is absent, excluded or not seen.",
      not_mentioned: "The report does not mention the finding at all.",
    },
  },
  invents_critical: {
    instructions:
      `Does \`report\` state as present a critical finding (for example ${CRITICAL_EXAMPLES}) that \`input_findings\` does not state? Recommendations, differential diagnoses and statements that a finding is absent do not count.`,
    criteria: {
      true: "The report asserts a critical finding that the input never states.",
      false: "Every critical finding the report asserts is stated in the input, or the report asserts none.",
    },
  },
  normal_despite_abnormal: {
    instructions:
      "`input_findings` contains abnormal findings. Does `report` present the study as normal, unremarkable or without acute abnormality overall?",
    criteria: {
      true: "The report's overall message is that the study is normal or has no acute abnormality.",
      false: "The report conveys at least one abnormal finding.",
    },
  },
  side_changed: {
    instructions: "Does `report` give a different side (right or left) than `input_findings` for any finding?",
    criteria: {
      true: "At least one finding appears on the opposite side from the input.",
      false: "Every side in the report matches the input, or the report gives no sides.",
    },
  },
  measurement_changed: {
    instructions: "Does `report` give any measurement (size, length, volume) that differs from the value in `input_findings`?",
    criteria: {
      true: "At least one measurement in the report differs from the input.",
      false: "Every measurement in the report matches the input, or the report gives none.",
    },
  },
  abnormal_omitted: {
    instructions:
      "Does `report` leave out an abnormal finding that `input_findings` states? Normal statements and harness or testing notes in the input do not count.",
    criteria: {
      true: "At least one abnormal input finding is missing from the report.",
      false: "Every abnormal input finding appears in the report.",
    },
  },
  self_contradiction: {
    instructions: "Do the findings section and the impression (or conclusion) of `report` contradict each other?",
    criteria: {
      true: "The impression contradicts the findings (a finding affirmed in one and denied or absent in the other, or a different side or value).",
      false: "The impression is consistent with the findings, or the report has no separate impression.",
    },
  },
} as const;

const SIDE_RX = /\b(right|left|bilateral|direit[oa]|esquerd[oa])\b/i;
const MEASURE_RX = /\d+(?:[.,]\d+)?\s*(?:mm|cm|ml|cc)\b/i;

function sideOf(sentence: string): string | null {
  const m = sentence.match(SIDE_RX);
  if (!m) return null;
  const s = m[1].toLowerCase();
  if (s.startsWith("direit")) return "right";
  if (s.startsWith("esquerd")) return "left";
  return s;
}

/** Report HTML → plain text with line breaks preserved (what a reader sees). */
export function reportPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h\d|li|center)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Affirmed input criticals, one per category, with the side the input gives. */
export function affirmedInputCriticals(findings: string, locale: LocaleKey): Array<{ category: string; term: string; side: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ category: string; term: string; side: string | null }> = [];
  for (const occ of listCriticalOccurrences(findings, locale)) {
    if (occ.negated || seen.has(occ.category)) continue;
    seen.add(occ.category);
    out.push({ category: occ.category, term: occ.term, side: sideOf(occ.sentence) });
  }
  return out;
}

export function buildDecisionQuestions(c: Pick<BenchCase, "findings">, locale: LocaleKey): { questions: Record<string, DecisionQuestion>; meta: QuestionMeta[] } {
  const questions: Record<string, DecisionQuestion> = {};
  const meta: QuestionMeta[] = [];
  const findings = c.findings;

  affirmedInputCriticals(findings, locale).forEach((crit, i) => {
    const key = `critical_${i}`;
    const t = QUESTION_TEMPLATES.critical_handling;
    questions[key] = {
      type: "choice",
      instructions: t.instructions.replace("{term}", crit.term).replace("{side}", crit.side ? ` (side: ${crit.side})` : ""),
      criteria: { ...t.criteria },
    };
    meta.push({ key, kind: "critical_handling", term: crit.term, category: crit.category, inputSide: crit.side });
  });

  const noul = (key: QuestionKind) => {
    const t = QUESTION_TEMPLATES[key] as { instructions: string; criteria: { true: string; false: string } };
    questions[key] = { type: "noul", instructions: t.instructions, criteria: { ...t.criteria } };
    meta.push({ key, kind: key });
  };

  noul("invents_critical");
  if (abnormalInputClauses(findings, locale).length > 0) {
    noul("normal_despite_abnormal");
    noul("abnormal_omitted");
  }
  if (SIDE_RX.test(findings)) noul("side_changed");
  if (MEASURE_RX.test(findings)) noul("measurement_changed");
  noul("self_contradiction");
  return { questions, meta };
}

export function buildDecisionRequest(c: Pick<BenchCase, "id" | "exam" | "findings">, locale: LocaleKey, reportHtml: string, model: string): { request: DecisionRequest; meta: QuestionMeta[] } {
  const { questions, meta } = buildDecisionQuestions(c, locale);
  return {
    request: {
      model,
      state: {
        language: locale === "pt-BR" ? "Brazilian Portuguese" : "English",
        exam: c.exam,
        input_findings: c.findings,
        report: reportPlainText(reportHtml),
      },
      questions,
      session_id: `laibench:${c.id}`.slice(0, 256),
    },
    meta,
  };
}

/** P(error) for one answer, or null when the model refused / answered malformed. */
export function errorProbability(m: QuestionMeta, answer: DecisionAnswer | undefined): { p: number | null; detail?: string } {
  if (!answer || answer.type === "refusal") return { p: null };
  if (m.kind === "critical_handling") {
    if (answer.type !== "choice") return { p: null };
    const pr = answer.probabilities;
    const missing = (pr.stated_absent ?? 0) + (pr.not_mentioned ?? 0);
    const other = pr.other_side ?? 0;
    const dropped = pr.side_dropped ?? 0;
    // Report the dominant error mode with its probability.
    const modes: Array<[string, number]> = [["missing", missing], ["other_side", other], ["side_dropped", dropped]];
    modes.sort((a, b) => b[1] - a[1]);
    return { p: Math.min(1, modes[0][1]), detail: modes[0][0] };
  }
  if (answer.type !== "noul") return { p: null };
  return { p: answer.noul };
}

function band(p: number | null, threshold: number): DecisionFlag["band"] {
  if (p === null) return "refused";
  if (p >= threshold) return "error";
  if (p >= REVIEW_P) return "review";
  return "clear";
}

const CRITICAL_KINDS: ReadonlySet<QuestionKind> = new Set(["invents_critical", "normal_despite_abnormal"]);

/**
 * Map decision answers to a JudgeResult that the existing combiner understands.
 * Lower-only by construction: dimensions default to 100 and only drop on a
 * confident error; TERM/GUIDE/RAG are omitted (null = no opinion).
 */
export function decisionsToJudge(meta: QuestionMeta[], answers: Record<string, DecisionAnswer>): { judge: JudgeResult; flags: DecisionFlag[] } {
  const flags: DecisionFlag[] = [];
  const critical_failures: JudgeFailure[] = [];
  const missing: string[] = [];
  const hallucinated: string[] = [];
  let qualError = false;

  for (const m of meta) {
    const { p, detail } = errorProbability(m, answers[m.key]);
    if (m.kind === "critical_handling") {
      // A dropped side is a major (QUAL) error; missing / other side are critical.
      const isCriticalMode = detail === "missing" || detail === "other_side";
      const b = band(p, isCriticalMode ? VETO_P : LOWER_P);
      flags.push({ key: m.key, kind: m.kind, term: m.term, pError: p, band: b });
      if (b !== "error") continue;
      if (isCriticalMode) {
        const issue = detail === "missing" ? `input critical not kept: ${m.term}` : `input critical on the wrong side: ${m.term}`;
        critical_failures.push({ dim: "CRIT", issue, evidence: `decision judge p=${(p as number).toFixed(2)}` });
        if (detail === "missing") missing.push(m.term ?? m.key);
      } else {
        qualError = true;
      }
      continue;
    }
    const critical = CRITICAL_KINDS.has(m.kind);
    const b = band(p, critical ? VETO_P : LOWER_P);
    flags.push({ key: m.key, kind: m.kind, pError: p, band: b });
    if (b !== "error") continue;
    if (critical) {
      critical_failures.push({ dim: "CRIT", issue: m.kind === "invents_critical" ? "critical finding not in the input" : "abnormal study reported as normal", evidence: `decision judge p=${(p as number).toFixed(2)}` });
      if (m.kind === "invents_critical") hallucinated.push("critical finding not stated in the input");
    } else {
      qualError = true;
    }
  }

  const crit = critical_failures.length > 0 ? CRIT_ON_VETO : 100;
  const qual = qualError ? QUAL_ON_MAJOR : 100;
  const judge: JudgeResult = {
    verdict: critical_failures.length > 0 ? "FAIL" : qualError ? "PARTIAL" : "PASS",
    scores: { CRIT: crit, QUAL: qual },
    overall: Math.min(crit, qual),
    critical_failures,
    missing,
    hallucinated,
    spot_checks: flags.map((f) => ({
      claim: f.term ? `${f.kind}: ${f.term}` : f.kind,
      ok: f.band === "clear",
      by: f.pError === null ? "decision judge: no answer" : `decision judge p(error)=${f.pError.toFixed(2)} (${f.band})`,
    })),
    fix: "",
  };
  return { judge, flags };
}

/** Stable JSON (sorted keys) so the config hash does not depend on key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function decisionJudgeConfigHash(model: string): string {
  return sha256(stableJson({
    version: DECISION_JUDGE_VERSION,
    model,
    thresholds: { VETO_P, LOWER_P, REVIEW_P },
    penalties: { CRIT_ON_VETO, QUAL_ON_MAJOR },
    templates: QUESTION_TEMPLATES,
  }));
}

export type DecisionJudgement = {
  judge: JudgeResult;
  flags: DecisionFlag[];
  needsReview: boolean;
  model: string;
  configHash: string;
  usage: DecisionResponse["usage"];
  ms: number;
};

export async function judgeCaseWithDecisions(args: {
  client: DecisionClient;
  model: string;
  case: Pick<BenchCase, "id" | "exam" | "findings">;
  locale: LocaleKey;
  reportHtml: string;
}): Promise<DecisionJudgement> {
  const model = args.model;
  const { request, meta } = buildDecisionRequest(args.case, args.locale, args.reportHtml, model);
  const response = await args.client(request);
  const { judge, flags } = decisionsToJudge(meta, response.answers);
  return {
    judge,
    flags,
    needsReview: flags.some((f) => f.band === "review" || f.band === "refused"),
    model: response.model,
    configHash: decisionJudgeConfigHash(model),
    usage: response.usage,
    ms: response.ms,
  };
}
