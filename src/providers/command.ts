import { spawn } from "node:child_process";
import type { GenerationInput, GenerationOutput } from "../types.js";

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
          env: process.env,
        });

        let out = "";
        let err = "";
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
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
          clearTimeout(timeout);
          if (timedOut && process.env.LAIBENCH_COMMAND_ERROR_AS_REPORT === "1") {
            return resolve(JSON.stringify({
              html: `<center><b>FALHA OPERACIONAL DO AGENTE</b></center><br><b>Achados</b><br>Comando excedeu ${timeoutMs}ms sem retornar laudo.<br><b>Conclusao</b><br>Falha operacional do agente avaliado.`,
              metadata: {
                operationalFailure: true,
                timeoutMs,
              },
            }));
          }
          if (timedOut) return reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
          if (code !== 0) return reject(new Error(`Command exited with code ${code}: ${err || out}`));
          resolve(out);
        });

        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
      });

      const trimmed = stdout.trim();
      if (!trimmed) throw new Error("Command generator returned empty output");

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
