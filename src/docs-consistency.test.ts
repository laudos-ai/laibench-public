import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Public-truth-drift guard: a cloud-private / aggregate-only suite (casesPath
// null, evaluationMode "cloud-private") cannot be run locally. Documentation
// must therefore never show a runnable `--suite suites/<that>.json` CLI command,
// or a public reader copy-pastes a command that fails ("suite does not ship
// cases"). This test fails if any README/docs command targets such a suite.
describe("docs/consistency: no local command runs a cloud-private suite", () => {
  it("README and docs never invoke a casesPath-null / cloud-private suite via --suite", () => {
    const root = process.cwd();
    const suitesDir = join(root, "suites");

    const cloudPrivate: string[] = [];
    for (const f of readdirSync(suitesDir)) {
      if (!f.endsWith(".json")) continue;
      const s = JSON.parse(readFileSync(join(suitesDir, f), "utf8")) as {
        evaluationMode?: string;
        casesPath?: string | null;
      };
      if (s.evaluationMode === "cloud-private" || s.casesPath === null) {
        cloudPrivate.push(f.replace(/\.json$/, ""));
      }
    }
    assert.ok(cloudPrivate.length > 0, "expected at least one cloud-private suite (lite-public.pt-BR)");

    const docFiles: string[] = [];
    if (existsSync(join(root, "README.md"))) docFiles.push(join(root, "README.md"));
    const docsDir = join(root, "docs");
    if (existsSync(docsDir)) {
      for (const f of readdirSync(docsDir)) if (f.endsWith(".md")) docFiles.push(join(docsDir, f));
    }

    const violations: string[] = [];
    for (const file of docFiles) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!line.includes("--suite")) return;
        for (const id of cloudPrivate) {
          if (line.includes(`suites/${id}.json`)) {
            violations.push(`${file.replace(`${root}/`, "")}:${i + 1} → local --suite command targets cloud-private suite "${id}"`);
          }
        }
      });
    }

    assert.equal(
      violations.length,
      0,
      `Docs must not show local CLI commands against cloud-private suites (use lite-public.en-US for runnable examples):\n${violations.join("\n")}`,
    );
  });
});
