import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCommandEnv, buildCommandGenerator } from "./command.js";
import type { GenerationInput } from "../types.js";

// Hygiene fix (cli-providers-io-4): the command provider runs the --cmd
// subprocess with shell:true. It used to inherit the FULL process.env, handing
// OPENROUTER_API_KEY / OPENAI_API_KEY / OPENAI_COMPAT_API_KEY / ANTHROPIC_API_KEY
// and any LAIBENCH_* judge keys to an arbitrary evaluated agent. The provider
// now passes a FILTERED env that strips those credentials while preserving PATH
// and other needed vars.

// The benchmark's OWN provider/judge credentials (exact names + the LAIBENCH_
// namespace) — these must be stripped before spawning the evaluated agent.
const CREDENTIAL_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "ANTHROPIC_API_KEY",
  "LAIBENCH_JUDGE_API_KEY",
  "LAIBENCH_JUDGE_SECRET",
];

// Credentials that belong to the EVALUATED AGENT (the system under test), not the
// benchmark. These must be PRESERVED — stripping them with a broad `*_API_KEY`
// rule would break a legitimate agent that needs its own provider key.
const AGENT_OWN_KEYS = ["SOME_VENDOR_API_TOKEN", "GEMINI_API_KEY"];

describe("buildCommandEnv strips benchmark provider/judge credentials", () => {
  it("removes the benchmark's own credentials but preserves PATH and the agent's own keys", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/agent",
      LAIBENCH_COMMAND_TIMEOUT_MS: "5000",
      LANG: "en_US.UTF-8",
    };
    for (const key of CREDENTIAL_KEYS) source[key] = "secret-value";
    for (const key of AGENT_OWN_KEYS) source[key] = "agent-own-value";

    const env = buildCommandEnv(source);

    for (const key of CREDENTIAL_KEYS) {
      assert.equal(env[key], undefined, `${key} must be stripped from the subprocess env`);
    }
    // The evaluated agent's OWN credentials must survive (backward compatible:
    // narrow denylist, not a broad *_API_KEY sweep).
    for (const key of AGENT_OWN_KEYS) {
      assert.equal(env[key], "agent-own-value", `${key} (the agent's own credential) must be preserved`);
    }
    // Non-credential vars preserved unchanged.
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal(env.HOME, "/home/agent");
    assert.equal(env.LANG, "en_US.UTF-8");
    // A LAIBENCH_* var that is NOT a credential must survive.
    assert.equal(env.LAIBENCH_COMMAND_TIMEOUT_MS, "5000");
  });

  it("does not mutate the source env object", () => {
    const source: NodeJS.ProcessEnv = { PATH: "/bin", OPENAI_API_KEY: "sk-test" };
    buildCommandEnv(source);
    assert.equal(source.OPENAI_API_KEY, "sk-test", "source env must be left intact");
  });
});

describe("command provider subprocess does not receive credential vars", () => {
  it("the spawned --cmd sees an empty OPENROUTER_API_KEY", async () => {
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-should-not-leak";
    try {
      // The agent echoes a JSON report whose <html> embeds the value of
      // OPENROUTER_API_KEY as seen INSIDE the subprocess. With the scrub it must
      // be empty.
      const script =
        'node -e "const k=process.env.OPENROUTER_API_KEY||\'\';process.stdout.write(JSON.stringify({html:\'<center><b>LEAK[\'+k+\']</b></center>\'}))"';
      const gen = buildCommandGenerator(script);
      const input: GenerationInput = {
        exam: "tc abdome",
        findings: "massa de 2 cm.",
        locale: "pt-BR",
        systemPrompt: "",
      };
      const out = await gen.run(input);
      assert.match(out.html, /LEAK\[\]/, `subprocess leaked the credential: ${out.html}`);
      assert.doesNotMatch(out.html, /sk-or-should-not-leak/, "credential value must not reach the subprocess");
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });
});
