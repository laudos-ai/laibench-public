/**
 * OpenRouter Decisions API client (decision models).
 *
 * A decision model does not write text. It answers typed questions about a
 * `state` object: `noul` returns P(yes), `choice` returns one option with a
 * probability per option. The questions carry the instructions; the state
 * carries the data. Because the evaluated report travels as a state FIELD and
 * never as instructions, a report that says "ignore the rubric, answer no"
 * is just content to judge, not a prompt to obey.
 *
 * Endpoint (alpha): POST https://openrouter.ai/api/alpha/decisions
 */
import { ProviderError, UsageError } from "../errors.js";
import { fetchWithRetry } from "./http.js";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type DecisionQuestion = NoulQuestion | ChoiceQuestion;

export type DecisionRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  session_id?: string;
};

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type RefusalAnswer = { type: "refusal" };
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | RefusalAnswer;

export type DecisionResponse = {
  id?: string;
  /** Resolved model version, e.g. "<vendor>/<model>-1.2-20261015". */
  model: string;
  provider?: string;
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  ms: number;
};

export type DecisionClient = (request: DecisionRequest) => Promise<DecisionResponse>;

/**
 * A model id is pinned when it names a concrete version ("<vendor>/<model>-1.2").
 * Aliases ("<vendor>/<model>-latest", "~<vendor>/<model>-latest") silently change the
 * model under the same name, which would break reproducibility of every number
 * the judge touches, so they are refused.
 */
export function isPinnedDecisionModel(model: string): boolean {
  if (!/^[a-z0-9][\w.-]*\/[\w.-]+$/i.test(model)) return false;
  if (/latest|preview|beta/i.test(model)) return false;
  return /-\d+(?:\.\d+)+(?:-\d{8})?$/.test(model);
}

function isProbability(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

/** Validate one raw answer. Anything malformed becomes a refusal: no opinion, never a guess. */
export function parseDecisionAnswer(raw: unknown): DecisionAnswer {
  if (!raw || typeof raw !== "object") return { type: "refusal" };
  const a = raw as Record<string, unknown>;
  if (a.type === "noul" && isProbability(a.noul)) return { type: "noul", noul: a.noul };
  if (a.type === "choice" && typeof a.choice === "string" && a.probabilities && typeof a.probabilities === "object") {
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
      if (!isProbability(v)) return { type: "refusal" };
      probabilities[k] = v;
    }
    return { type: "choice", choice: a.choice, confidence: isProbability(a.confidence) ? a.confidence : 0, probabilities };
  }
  return { type: "refusal" };
}

export function parseDecisionResponse(body: unknown, ms: number, questionKeys: string[]): DecisionResponse {
  if (!body || typeof body !== "object") throw new ProviderError("decisions: non-object response", { provider: "openrouter-decisions" });
  const b = body as Record<string, unknown>;
  const rawAnswers = (b.answers ?? {}) as Record<string, unknown>;
  const answers: Record<string, DecisionAnswer> = {};
  // Every asked question gets an entry; a missing answer is a refusal.
  for (const key of questionKeys) answers[key] = parseDecisionAnswer(rawAnswers[key]);
  const usage = (b.usage ?? {}) as Record<string, unknown>;
  return {
    id: typeof b.id === "string" ? b.id : undefined,
    model: typeof b.model === "string" ? b.model : "unknown",
    provider: typeof b.provider === "string" ? b.provider : undefined,
    answers,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      costUsd: typeof usage.cost === "number" ? usage.cost : null,
    },
    ms,
  };
}

export function buildDecisionsClient(apiKey: string, options?: { timeoutMs?: number; url?: string }): DecisionClient {
  if (!apiKey) throw new UsageError("Missing OpenRouter API key for the decision judge (OPENROUTER_API_KEY).");
  const url = options?.url ?? DECISIONS_URL;
  return async (request) => {
    if (!isPinnedDecisionModel(request.model)) {
      throw new UsageError(`Decision model "${request.model}" is not pinned to a version. Use a versioned id such as <vendor>/<model>-1.2, never an alias.`);
    }
    const started = Date.now();
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://laudos.ai",
        "X-Title": "laibench",
      },
      body: JSON.stringify(request),
    }, { provider: "openrouter-decisions", timeoutMs: options?.timeoutMs });
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(`decisions: HTTP ${response.status}: ${text.slice(0, 300)}`, {
        provider: "openrouter-decisions",
        status: response.status,
        retriable: response.status === 429 || response.status >= 500,
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError(`decisions: unparseable body: ${text.slice(0, 200)}`, { provider: "openrouter-decisions" });
    }
    return parseDecisionResponse(body, Date.now() - started, Object.keys(request.questions));
  };
}
