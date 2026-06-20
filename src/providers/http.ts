import { ProviderError } from "../errors.js";

const RETRY_DELAYS = [1000, 3000, 8000];
const RETRIABLE_CODES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_MS = 30_000;

export function isRetriableStatus(status: number): boolean {
  return RETRIABLE_CODES.has(status);
}

function resolveTimeoutMs(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  const fromEnv = Number(process.env.LAIBENCH_REQUEST_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIMEOUT_MS;
}

/** ±25% jitter so concurrent workers don't retry in lockstep. */
function withJitter(ms: number): number {
  return Math.max(0, Math.round(ms * (0.75 + Math.random() * 0.5)));
}

/**
 * Parse a Retry-After header. Only the delta-seconds form is honored; the
 * HTTP-date form yields NaN from Number() and falls back to the backoff delay
 * (previously NaN reached setTimeout and caused instant retry hammering).
 */
function retryAfterToMs(retryAfter: string | null, fallbackMs: number): number {
  if (!retryAfter) return fallbackMs;
  const secs = Number(retryAfter);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : fallbackMs;
}

function isAbortLike(error: Error): boolean {
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared fetch with bounded retries for transient failures.
 *
 * - Retries 429/5xx responses and thrown errors (network, abort/timeout) up to the cap.
 * - Each request is bounded by AbortSignal.timeout (default 120s, override via
 *   options.timeoutMs or LAIBENCH_REQUEST_TIMEOUT_MS).
 * - Returns the final Response for HTTP-level errors so callers can read the body;
 *   throws ProviderError when the fetch itself fails on the final attempt.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: { provider?: string; timeoutMs?: number },
): Promise<Response> {
  const provider = options?.provider ?? "http";
  const timeoutMs = resolveTimeoutMs(options?.timeoutMs);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok || !RETRIABLE_CODES.has(response.status) || attempt === RETRY_DELAYS.length) {
        return response;
      }
      const delay = RETRY_DELAYS[attempt] ?? 8000;
      const waitMs = retryAfterToMs(response.headers.get("retry-after"), delay);
      await sleep(withJitter(waitMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === RETRY_DELAYS.length) {
        const reason = isAbortLike(lastError) ? `timed out after ${timeoutMs}ms` : lastError.message;
        throw new ProviderError(`${provider} request failed (attempt ${attempt + 1}): ${reason}`, {
          provider,
          attempt: attempt + 1,
          retriable: true,
          cause: lastError,
        });
      }
      await sleep(withJitter(RETRY_DELAYS[attempt] ?? 8000));
    }
  }
  throw new ProviderError(`${provider} request failed: retry exhaustion`, {
    provider,
    retriable: true,
    cause: lastError ?? undefined,
  });
}
