import { estimateCost, type Pricing } from "../normalize.js";
import type { GenerationInput, GenerationOutput, JudgeAdapter, JudgeOutput, TraceEvent } from "../types.js";

const RETRY_DELAYS = [1000, 3000, 8000];
const RETRIABLE_CODES = new Set([429, 500, 502, 503, 504]);
type OpenRouterDataCollection = "allow" | "deny";

function resolveDataCollection(value?: string): OpenRouterDataCollection {
  return value === "allow" ? "allow" : "deny";
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !RETRIABLE_CODES.has(response.status) || attempt === RETRY_DELAYS.length) {
        return response;
      }
      const delay = RETRY_DELAYS[attempt] ?? 8000;
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? Math.min(Number(retryAfter) * 1000, 30_000) : delay;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === RETRY_DELAYS.length) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt] ?? 8000));
    }
  }
  throw lastError ?? new Error("Unexpected retry exhaustion");
}

export async function callOpenRouter(args: {
  apiKey: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  pricing?: Pricing;
  dataCollection?: OpenRouterDataCollection;
}): Promise<GenerationOutput & { trace: TraceEvent }> {
  const started = Date.now();
  const response = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.apiKey}`,
      "HTTP-Referer": "https://laudos.ai",
      "X-Title": "laibench",
    },
    body: JSON.stringify({
      model: args.model,
      temperature: args.temperature ?? 0.2,
      max_tokens: args.maxTokens ?? 4096,
      messages: [
        ...(args.systemPrompt ? [{ role: "system", content: args.systemPrompt }] : []),
        { role: "user", content: args.prompt },
      ],
      provider: {
        data_collection: resolveDataCollection(args.dataCollection ?? process.env.OPENROUTER_DATA_COLLECTION),
        allow_fallbacks: true,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const usage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
  const costUsd = estimateCost(usage, args.pricing);

  return {
    html: data.choices?.[0]?.message?.content ?? "",
    raw: data.choices?.[0]?.message?.content ?? "",
    usage,
    model: args.model,
    costUsd,
    trace: {
      step: "llm",
      model: args.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      ms: Date.now() - started,
    },
  };
}

export function buildOpenRouterGenerator(apiKey: string, model: string, pricing?: Pricing, options?: { maxTokens?: number; temperature?: number; noSystemPrompt?: boolean }) {
  return {
    name: `openrouter:${model}`,
    scaffoldId: "mini-laibench-agent-v1",
    async run(input: GenerationInput): Promise<GenerationOutput> {
      return callOpenRouter({
        apiKey,
        model,
        pricing,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        systemPrompt: options?.noSystemPrompt ? undefined : input.systemPrompt,
        prompt: `Exam: ${input.exam}\nFindings: ${input.findings}\n\nGenerate the complete radiology report. Output only HTML.`,
      });
    },
  };
}

export function buildOpenRouterJudge(apiKey: string, model: string, pricing?: Pricing, options?: { maxTokens?: number; temperature?: number }): JudgeAdapter {
  return {
    name: `openrouter-judge:${model}`,
    provider: "openrouter",
    modelLabel: model,
    async run(prompt: string): Promise<JudgeOutput> {
      const result = await callOpenRouter({
        apiKey,
        model,
        prompt,
        pricing,
        maxTokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0,
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
