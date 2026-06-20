import { spawn } from "node:child_process";
import { ProviderError } from "../errors.js";
import type { GenerationInput, GenerationOutput, LocaleKey } from "../types.js";

// Credential vars belonging to the benchmark's OWN providers/judges. The --cmd
// subprocess is an ARBITRARY evaluated agent (the system under test), so we must
// not hand it our provider credentials. We strip an EXACT denylist of the keys
// the benchmark itself reads — NOT a broad `*_API_KEY` pattern — so the evaluated
// agent's OWN credentials (e.g. GEMINI_API_KEY, its own service tokens) are
// preserved and the command provider stays backward compatible. PATH/HOME/etc.
// are untouched.
const BENCHMARK_CREDENTIAL_VARS = new Set<string>([
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "ANTHROPIC_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
]);

// Any credential in the benchmark's OWN LAIBENCH_ namespace (e.g. a future
// LAIBENCH_JUDGE_API_KEY). Scoped to the LAIBENCH_ prefix so it can never match
// an evaluated agent's own credential vars.
const LAIBENCH_CREDENTIAL_RX = /^LAIBENCH_.*(?:KEY|TOKEN|SECRET)$/i;

function isBenchmarkCredential(key: string): boolean {
  return BENCHMARK_CREDENTIAL_VARS.has(key) || LAIBENCH_CREDENTIAL_RX.test(key);
}

/**
 * Build the environment for the spawned --cmd subprocess by stripping ONLY the
 * benchmark's own provider/judge credential variables (exact-name denylist plus
 * the LAIBENCH_ namespace). Backward compatible: every other variable — including
 * the evaluated agent's OWN credentials (e.g. GEMINI_API_KEY) — is preserved.
 */
export function buildCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (isBenchmarkCredential(key)) continue;
    filtered[key] = value;
  }
  return filtered;
}

function timeoutFailureHtml(locale: LocaleKey, timeoutMs: number): string {
  if (locale === "en-US") {
    return `<center><b>AGENT OPERATIONAL FAILURE</b></center><br><b>Findings</b><br>Command exceeded ${timeoutMs}ms without returning a report.<br><b>Impression</b><br>Operational failure of the evaluated agent.`;
  }
  return `<center><b>FALHA OPERACIONAL DO AGENTE</b></center><br><b>Achados</b><br>Comando excedeu ${timeoutMs}ms sem retornar laudo.<br><b>Conclusao</b><br>Falha operacional do agente avaliado.`;
}

export function buildCommandGenerator(command: string) {
  return {
    name: `command:${command}`,
    scaffoldId: null,
    async run(input: GenerationInput): Promise<GenerationOutput> {
      const stdout = await new Promise<string>((resolve, reject) => {
        const timeoutMs = Number(process.env.LAIBENCH_COMMAND_TIMEOUT_MS ?? 180_000);
        const child = spawn(command, {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          // Never leak our provider/judge credentials into the evaluated agent.
          env: buildCommandEnv(process.env),
        });

        let out = "";
        let err = "";
        let timedOut = false;
        let closed = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // child.killed only means "signal sent", not "exited"; escalate to
          // SIGKILL after a grace period unless 'close' has actually fired.
          setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, 2000).unref();
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          out += String(chunk);
        });

        child.stderr.on("data", (chunk) => {
          err += String(chunk);
        });

        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on("close", (code) => {
          closed = true;
          clearTimeout(timeout);
          if (timedOut && process.env.LAIBENCH_COMMAND_ERROR_AS_REPORT === "1") {
            return resolve(JSON.stringify({
              html: timeoutFailureHtml(input.locale, timeoutMs),
              metadata: {
                operationalFailure: true,
                timeoutMs,
              },
            }));
          }
          if (timedOut) return reject(new ProviderError(`Command timed out after ${timeoutMs}ms: ${command}`, { provider: "command", retriable: true }));
          if (code !== 0) return reject(new ProviderError(`Command exited with code ${code}: ${err || out}`, { provider: "command" }));
          resolve(out);
        });

        // A dead child emits EPIPE on stdin; without a listener that becomes an
        // uncaught 'error' event and crashes the whole suite process. Swallow it
        // here — the 'close' handler reports the real failure.
        child.stdin.on("error", () => {});
        try {
          child.stdin.end(JSON.stringify(input));
        } catch {
          // Child already gone; outcome is settled by the 'close'/'error' handlers.
        }
      });

      const trimmed = stdout.trim();
      if (!trimmed) throw new ProviderError("Command generator returned empty output", { provider: "command" });

      try {
        const parsed = JSON.parse(trimmed) as { html?: string; metadata?: Record<string, unknown> };
        if (typeof parsed.html === "string" && parsed.html.trim()) {
          return { html: parsed.html, raw: parsed.html, metadata: parsed.metadata, model: command, costUsd: 0 };
        }
      } catch {
        // fall through to raw HTML
      }

      return { html: trimmed, raw: trimmed, model: command, costUsd: 0 };
    },
  };
}
