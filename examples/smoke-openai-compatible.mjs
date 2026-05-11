import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const port = 8787;
const baseUrl = `http://127.0.0.1:${port}/v1`;

function waitForReady(child) {
  return new Promise((resolveReady, rejectReady) => {
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (text.includes("mock-openai-server listening")) {
        child.stdout.off("data", onData);
        resolveReady();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk.toString()));
    child.on("exit", (code) => rejectReady(new Error(`mock server exited early with code ${code}`)));
  });
}

const server = spawn(process.execPath, [resolve(repoRoot, "examples/mock-openai-server.mjs")], {
  cwd: repoRoot,
  env: { ...process.env, MOCK_OPENAI_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForReady(server);

  const cli = spawn(process.execPath, [
    resolve(repoRoot, "node_modules/tsx/dist/cli.mjs"),
    "src/cli.ts",
    "suite",
    "--suite", "suites/lite-public.pt-BR.json",
    "--provider", "openai-compatible",
    "--base-url", baseUrl,
    "--model", "mock-generator",
    "--judge-provider", "openai-compatible",
    "--judge-base-url", baseUrl,
    "--judge-model", "mock-judge",
    "--run-name", "mock-openai-compatible",
    "--out", "runs/mock-openai-compatible.json",
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  const [code] = await once(cli, "exit");
  if (code !== 0) throw new Error(`CLI exited with code ${code}`);
} finally {
  server.kill("SIGTERM");
}
