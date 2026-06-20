import { getLocale } from "./locales/index.js";
import { logger } from "./log.js";
import { round1 } from "./normalize.js";
import { DIMS } from "./scoring.js";
import type { BenchCase, Dim, JudgeFailure, JudgeResult, JudgeSpotCheck, LocaleKey } from "./types.js";

/**
 * Validate a raw judge dimension/overall score on the 0-100 scale WITHOUT
 * rescaling or floor-clamping.
 *
 * - A genuine 0 must stay 0 (no floor at 1). The previous per-value Likert path
 *   (clampScore: Math.max(1, ...) for the <=5 branch) re-introduced exactly the
 *   per-value inflation that scoring.ts deliberately rejected in favour of the
 *   single per-RESULT judgeScoresAreLikert decision. ALL scale disambiguation
 *   (0-5 Likert vs 0-100) now lives in combineScores; the parser only validates.
 * - A clearly out-of-range value (>100 or <0) is treated as INVALID for that
 *   dimension and dropped to null, NOT clamped into the favourable band. Clamping
 *   500 -> 100 (or -50 -> 0/1) would silently turn a malformed/hallucinated value
 *   into a maximum score, which is the unsafe direction for a safety benchmark.
 */
function validateRawScore(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value < 0 || value > 100) return null;
  return round1(value);
}

/**
 * Extract the first balanced top-level JSON object from a string by scanning
 * from the FIRST '{' to its matching '}' via brace-depth balance, tolerant of
 * leading AND trailing prose. String contents are skipped so braces inside JSON
 * string literals do not affect the depth count.
 *
 * The previous regex /\{[\s\S]*\}$/ anchored the closing brace to END-of-string,
 * so any trailing prose ("{...}.", "{...}\n\nNote: ...") made parsing fail and
 * the judge was silently dropped — an unsafe silent loss of an evaluation.
 */
function extractJsonObject(input: string): string | null {
  const start = input.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }

  return null;
}

export function parseJudgeResponse(input: string): JudgeResult | null {
  const cleaned = input.replace(/```json/gi, "").replace(/```/g, "").trim();
  const block = extractJsonObject(cleaned) ?? cleaned;
  let parsed: unknown;

  try {
    parsed = JSON.parse(block);
  } catch {
    try {
      parsed = JSON.parse(block.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      // A response was present but unparseable: surface the drop rather than
      // letting the judge silently disappear from the combined score.
      logger.warn("judge unparseable", { len: input.length, preview: input.slice(0, 120) });
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    logger.warn("judge non-object", { len: input.length, preview: input.slice(0, 120) });
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const verdictRaw = typeof obj.verdict === "string" ? obj.verdict.toUpperCase() : "PARTIAL";
  const verdict = verdictRaw === "PASS" || verdictRaw === "FAIL" || verdictRaw === "PARTIAL" ? verdictRaw : "PARTIAL";

  const rawScores = (obj.scores ?? {}) as Record<string, unknown>;
  const scores: Partial<Record<Dim, number>> = {};
  for (const dim of DIMS) {
    // Preserve the judge's RAW [0,100] value (no floor, no Likert rescale here);
    // combineScores' single judgeScoresAreLikert decision owns scale handling.
    const value = validateRawScore(rawScores[dim]);
    if (value !== null) scores[dim] = value;
  }

  const critical_failures = Array.isArray(obj.critical_failures)
    ? obj.critical_failures
        .map((entry) => entry as Partial<JudgeFailure>)
        .map((entry) => ({
          dim: DIMS.includes(entry.dim as Dim) ? (entry.dim as Dim) : "CRIT",
          issue: typeof entry.issue === "string" ? entry.issue : "unspecified",
          evidence: typeof entry.evidence === "string" ? entry.evidence : "",
        }))
    : [];

  const missing = Array.isArray(obj.missing) ? obj.missing.filter((entry): entry is string => typeof entry === "string") : [];
  const hallucinated = Array.isArray(obj.hallucinated) ? obj.hallucinated.filter((entry): entry is string => typeof entry === "string") : [];
  const spot_checks = Array.isArray(obj.spot_checks)
    ? obj.spot_checks
        .map((entry) => entry as Partial<JudgeSpotCheck>)
        .filter((entry) => typeof entry.claim === "string")
        .map((entry) => ({
          claim: entry.claim ?? "",
          ok: Boolean(entry.ok),
          by: typeof entry.by === "string" ? entry.by : "",
        }))
    : [];

  return {
    verdict,
    scores,
    overall: validateRawScore(obj.overall),
    critical_failures,
    missing,
    hallucinated,
    spot_checks,
    fix: typeof obj.fix === "string" ? obj.fix : "",
  };
}

function buildGoldContext(benchCase?: BenchCase): string {
  if (!benchCase) return "";
  const goldFindings = (benchCase.goldFindings ?? [])
    .slice(0, 12)
    .map((item) => `- ${item.negated ? "NEGATED " : ""}${item.severity}: ${item.finding}`)
    .join("\n");
  const criticalFindings = (benchCase.criticalFindings ?? []).slice(0, 8).map((item) => `- ${item}`).join("\n");
  const guidelines = (benchCase.guidelineExpectations ?? [])
    .slice(0, 8)
    .map((item) => `- ${item.guidelineId}: ${item.expectedClassification ?? "classification n/a"}; recommendation=${item.expectedRecommendation ?? item.recommendationRequired ?? "n/a"}`)
    .join("\n");
  const reference = benchCase.referenceReport ? benchCase.referenceReport.slice(0, 3000) : "";
  return [
    goldFindings ? `GOLD_FINDINGS:\n${goldFindings}` : "",
    criticalFindings ? `CRITICAL_FINDINGS:\n${criticalFindings}` : "",
    guidelines ? `GUIDELINE_EXPECTATIONS:\n${guidelines}` : "",
    reference ? `REFERENCE_REPORT_EXCERPT:\n${reference}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildJudgePrompt(localeKey: LocaleKey, exam: string, findings: string, html: string, canaryToken?: string, benchCase?: BenchCase): string {
  const locale = getLocale(localeKey);
  const goldContext = buildGoldContext(benchCase);
  const contamination = canaryToken
    ? `CONTAMINATION CHECK: If the report contains any of the following red flags, add a critical_failure with dim="CRIT" and issue="contamination-suspect": (1) verbatim benchmark identifiers, case IDs, or suite metadata; (2) the canary token "${canaryToken}"; (3) suspiciously memorized boilerplate that exactly matches known benchmark prompts rather than responding to the clinical findings. This is a benchmark integrity check.`
    : "";
  return [
    "You are an adversarial radiology QA judge.",
    locale.judgeInstructions,
    ...(contamination ? [contamination] : []),
    "Return JSON only.",
    `EXAM: ${exam}`,
    `FINDINGS: ${findings}`,
    ...(goldContext ? [goldContext] : []),
    `REPORT_HTML:\n${html}`,
    'JSON schema:',
    '{"verdict":"PASS|PARTIAL|FAIL","scores":{"CRIT":0-100,"QUAL":0-100,"TERM":0-100,"GUIDE":0-100,"RAG":0-100},"overall":0-100,"critical_failures":[{"dim":"CRIT","issue":"...","evidence":"..."}],"missing":["..."],"hallucinated":["..."],"spot_checks":[{"claim":"...","ok":true,"by":"..."}],"fix":"..."}',
  ].join("\n\n");
}
