import { ProviderError } from "../errors.js";
import { estimateCost, type Pricing } from "../normalize.js";
import { fetchWithRetry, isRetriableStatus } from "./http.js";
import type { GenerationInput, GenerationOutput, JudgeAdapter, JudgeOutput, TraceEvent } from "../types.js";

type OpenRouterDataCollection = "allow" | "deny";

function resolveDataCollection(value?: string): OpenRouterDataCollection {
  return value === "allow" ? "allow" : "deny";
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
  }, { provider: "openrouter" });

  if (!response.ok) {
    const text = await response.text();
    throw new ProviderError(`OpenRouter ${response.status}: ${text}`, {
      provider: "openrouter",
      status: response.status,
      retriable: isRetriableStatus(response.status),
    });
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

export function buildOpenRouterGenerator(apiKey: string, model: string, pricing?: Pricing, options?: { maxTokens?: number; temperature?: number; noSystemPrompt?: boolean; dataCollection?: OpenRouterDataCollection }) {
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
        dataCollection: options?.dataCollection,
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
