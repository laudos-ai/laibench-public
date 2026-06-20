/**
 * Typed error hierarchy for laibench.
 *
 * These classes let callers distinguish failure modes (bad invocation vs.
 * upstream provider failure vs. data integrity vs. validation) without
 * string-matching on messages. Exit-code mapping is owned by the CLI layer.
 */

/** Invalid invocation: bad flags, missing arguments, unusable configuration. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Upstream provider (HTTP endpoint or subprocess) failed to produce a usable response. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly attempt?: number;
  readonly retriable: boolean;

  constructor(
    message: string,
    options: { provider: string; status?: number; attempt?: number; retriable?: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.attempt = options.attempt;
    this.retriable = options.retriable ?? false;
  }
}

/** Data integrity violation: hash mismatch, tampered artifact, broken provenance chain. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** Schema or content validation failure on cases, suites, submissions, or runs. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
