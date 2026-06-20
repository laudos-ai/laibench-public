/**
 * Tiny dependency-free structured logger.
 *
 * Each event is one line that is both human-legible and machine-parseable:
 *
 *   INFO release-guard ok mode=public warnings=0
 *   ERROR release-guard issue path=cases/x.json rule=public-answer-key msg="..."
 *
 * Levels: info/warn/error. info goes to stdout, warn/error go to stderr, so a
 * caller can still separate machine output from diagnostics by stream. Field
 * values are space- and quote-safe (quoted when they contain whitespace).
 * Use `raw` to emit a verbatim payload (for example a JSON result) without a
 * level prefix.
 */

export type LogLevel = "info" | "warn" | "error";

function serialize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return '""';
  return /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

function format(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
  const parts = [level.toUpperCase(), message];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${serialize(value)}`);
    }
  }
  return parts.join(" ");
}

export const logger = {
  info(message: string, fields?: Record<string, unknown>): void {
    process.stdout.write(format("info", message, fields) + "\n");
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    process.stderr.write(format("warn", message, fields) + "\n");
  },
  error(message: string, fields?: Record<string, unknown>): void {
    process.stderr.write(format("error", message, fields) + "\n");
  },
  /** Emit a verbatim payload to stdout with no level prefix. */
  raw(text: string): void {
    process.stdout.write(text + "\n");
  },
};
