import { estimateCost, parseRetryAfterMs, type Pricing } from "../normalize.js";
import type { GenerationInput, GenerationOutput, JudgeAdapter, JudgeOutput, TraceEvent } from "../types.js";

type ExtraPayload = Record<string, unknown>;
type HeaderMap = Record<string, string>;

type OpenAICompatibleConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: HeaderMap;
  body?: ExtraPayload;
  authHeader?: string;
  authPrefix?: string;
  maxTokens?: number;
  temperature?: number;
};

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: { content?: unknown };
    text?: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string } | string;
};

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("Missing baseUrl for openai-compatible provider.");
  if (/\/chat\/completions(?:\?|$)/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
}

function buildHeaders(config: OpenAICompatibleConfig): HeaderMap {
  const headers: HeaderMap = {
    "content-type": "application/json",
    ...(config.headers ?? {}),
  };

  const authHeader = config.authHeader ?? "Authorization";
  if (config.apiKey && headers[authHeader] === undefined) {
    headers[authHeader] = `${config.authPrefix ?? "Bearer "}${config.apiKey}`;
  }

  return headers;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as OpenAICompatibleResponse;
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") return parsed.error.message;
  } catch {
    // fall through
  }
  return text;
}

const RETRY_DELAYS = [1000, 3000, 8000];
const RETRIABLE_CODES = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !RETRIABLE_CODES.has(response.status) || attempt === RETRY_DELAYS.length) {
        return response;
      }
      const delay = RETRY_DELAYS[attempt] ?? 8000;
      const waitMs = parseRetryAfterMs(response.headers.get("retry-after"), delay);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === RETRY_DELAYS.length) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt] ?? 8000));
    }
  }
  throw lastError ?? new Error("Unexpected retry exhaustion");
}

export async function callOpenAICompatible(args: {
  config: OpenAICompatibleConfig;
  systemPrompt?: string;
  prompt: string;
  pricing?: Pricing;
}): Promise<GenerationOutput & { trace: TraceEvent }> {
  const started = Date.now();
  const response = await fetchWithRetry(resolveChatCompletionsUrl(args.config.baseUrl), {
    method: "POST",
    headers: buildHeaders(args.config),
    body: JSON.stringify({
      ...(args.config.body ?? {}),
      model: args.config.model,
      temperature: args.config.temperature ?? 0.2,
      max_tokens: args.config.maxTokens ?? 4096,
      messages: [
        ...(args.systemPrompt ? [{ role: "system", content: args.systemPrompt }] : []),
        { role: "user", content: args.prompt },
      ],
    }),
  });

  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(`OpenAI-compatible ${response.status}: ${details}`);
  }

  const data = (await response.json()) as OpenAICompatibleResponse;
  const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "";
  const text = extractText(content);
  const usage = {
    inputTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
  };
  const costUsd = estimateCost(usage, args.pricing);

  return {
    html: text,
    raw: text,
    usage,
    model: args.config.model,
    costUsd,
    trace: {
      step: "llm",
      model: args.config.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      ms: Date.now() - started,
    },
  };
}

export function buildOpenAICompatibleGenerator(config: OpenAICompatibleConfig, pricing?: Pricing) {
  return {
    name: `openai-compatible:${config.model}`,
    scaffoldId: "mini-laibench-agent-v1",
    async run(input: GenerationInput): Promise<GenerationOutput> {
      return callOpenAICompatible({
        config,
        pricing,
        systemPrompt: input.systemPrompt,
        prompt: `Exam: ${input.exam}\nFindings: ${input.findings}\n\nGenerate the complete radiology report. Output only HTML.`,
      });
    },
  };
}

export function buildOpenAICompatibleJudge(config: OpenAICompatibleConfig, pricing?: Pricing): JudgeAdapter {
  return {
    name: `openai-compatible-judge:${config.model}`,
    provider: "openai-compatible",
    modelLabel: config.model,
    async run(prompt: string): Promise<JudgeOutput> {
      const result = await callOpenAICompatible({
        config: { ...config, temperature: config.temperature ?? 0, maxTokens: config.maxTokens ?? 2048 },
        pricing,
        prompt,
      });
      return {
        text: result.raw,
        usage: result.usage,
        costUsd: result.costUsd,
        model: result.model,
        trace: { step: "judge", model: result.model, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, costUsd: result.costUsd, ms: result.trace.ms },
      };
    },
  };
}
