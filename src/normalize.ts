export function normalizeLoose(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function round1(value: number): number {
  return Number(value.toFixed(1));
}

export function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Supports both forms in
 * RFC 7231: delta-seconds ("120") and an HTTP-date ("Wed, 21 Oct 2025 07:28:00 GMT").
 * Returns `fallbackMs` when the header is absent or unparseable, and clamps the
 * result to [0, maxMs]. (The previous code did `Number(header)`, which yields NaN
 * for the HTTP-date form and produced `setTimeout(NaN)` = no backoff.)
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, fallbackMs: number, nowMs: number = Date.now(), maxMs = 30_000): number {
  if (!headerValue) return fallbackMs;
  const seconds = Number(headerValue);
  let ms: number;
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const dateMs = Date.parse(headerValue);
    if (Number.isNaN(dateMs)) return fallbackMs;
    ms = dateMs - nowMs;
  }
  if (!Number.isFinite(ms) || ms < 0) return fallbackMs;
  return Math.min(ms, maxMs);
}

export type Pricing = {
  inputPer1M?: number;
  outputPer1M?: number;
};

export function estimateCost(usage: { inputTokens?: number; outputTokens?: number }, pricing?: Pricing): number | undefined {
  if (!pricing || (pricing.inputPer1M === undefined && pricing.outputPer1M === undefined)) return undefined;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * (pricing.inputPer1M ?? 0);
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * (pricing.outputPer1M ?? 0);
  return roundCost(input + output);
}

export function clampScore(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.max(1, Math.min(5, round1(value)));
}

export function clampScore100(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, round1(value)));
}

export function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function matchAll(rx: RegExp, input: string): string[] {
  const flags = rx.flags.includes("g") ? rx.flags : `${rx.flags}g`;
  const global = new RegExp(rx.source, flags);
  return input.match(global) ?? [];
}

export function extractMeasurements(input: string): string[] {
  return Array.from(new Set((input.match(/\b\d+(?:[\.,]\d+)?\s*(?:mm|cm)\b/gi) ?? []).map((value) => normalizeLoose(value))));
}

export function extractLateralityTokens(input: string): string[] {
  const n = normalizeLoose(input);
  const result = new Set<string>();
  if (/\b(dir|direit[ao])\b|\bright\b/.test(n)) result.add("right");
  if (/\b(esq|esquerd[ao])\b|\bleft\b/.test(n)) result.add("left");
  if (/bilateral|bilaterais|bilaterally/.test(n)) result.add("bilateral");
  return Array.from(result);
}

export function extractLevelTokens(input: string): string[] {
  return Array.from(new Set((input.match(/\b[CTLSP]\d(?:\s*[-/]\s*[CTLSP]?\d)?\b/gi) ?? []).map((value) => value.replace(/\s+/g, "").toUpperCase())));
}
