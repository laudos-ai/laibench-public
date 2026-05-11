import { getLocale } from "./locales/index.js";
import { clampScore, clampScore100 } from "./normalize.js";
import { DIMS } from "./scoring.js";
import type { BenchCase, Dim, JudgeFailure, JudgeResult, JudgeSpotCheck, LocaleKey } from "./types.js";

export function parseJudgeResponse(input: string): JudgeResult | null {
  const cleaned = input.replace(/```json/gi, "").replace(/```/g, "").trim();
  const block = cleaned.match(/\{[\s\S]*\}$/)?.[0] ?? cleaned;
  let parsed: unknown;

  try {
    parsed = JSON.parse(block);
  } catch {
    try {
      parsed = JSON.parse(block.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const verdictRaw = typeof obj.verdict === "string" ? obj.verdict.toUpperCase() : "PARTIAL";
  const verdict = verdictRaw === "PASS" || verdictRaw === "FAIL" || verdictRaw === "PARTIAL" ? verdictRaw : "PARTIAL";

  const rawScores = (obj.scores ?? {}) as Record<string, unknown>;
  const scores: Partial<Record<Dim, number>> = {};
  for (const dim of DIMS) {
    const raw = rawScores[dim];
    const value = typeof raw === "number" && raw > 5 ? clampScore100(raw) : clampScore(raw);
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
    overall: typeof obj.overall === "number" && obj.overall > 5 ? clampScore100(obj.overall) : clampScore(obj.overall),
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
