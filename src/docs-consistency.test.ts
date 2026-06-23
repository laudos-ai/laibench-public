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

  it("README benchmarkVersion badge matches package.json version", () => {
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const readme = readFileSync(join(root, "README.md"), "utf8");
    assert.ok(
      readme.includes(`benchmarkVersion-${pkg.version}`),
      `README benchmarkVersion badge must match package.json version (${pkg.version}). Update the shields.io badge.`,
    );
  });

  it("no public doc affirmatively calls the controlled (cloud-private) suite an open/open-download benchmark", () => {
    const root = process.cwd();
    const docFiles: string[] = [];
    if (existsSync(join(root, "README.md"))) docFiles.push(join(root, "README.md"));
    const docsDir = join(root, "docs");
    if (existsSync(docsDir)) for (const f of readdirSync(docsDir)) if (f.endsWith(".md")) docFiles.push(join(docsDir, f));
    const bad: string[] = [];
    for (const file of docFiles) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const l = line.toLowerCase();
        // a line that ties the controlled/pt-BR suite to "open" affirmatively
        const mentionsControlled = l.includes("pt-br") || l.includes("controlled");
        const callsOpen = /\bopen[- ](?:benchmark|download)\b/.test(l);
        const negated = /\bnot\b|\bnão\b|\bdo not\b|disallow|never|must not/.test(l);
        if (mentionsControlled && callsOpen && !negated) {
          bad.push(`${file.replace(`${root}/`, "")}:${i + 1}`);
        }
      });
    }
    assert.equal(bad.length, 0, `The controlled suite must never be called an open/open-download benchmark:\n${bad.join("\n")}`);
  });

  it("public board (site/data.js) is aggregate-only — no controlled case IDs or raw findings", () => {
    const root = process.cwd();
    const p = join(root, "site", "data.js");
    if (!existsSync(p)) return; // site assets not in this checkout
    const raw = readFileSync(p, "utf8").trim();
    const json = raw.replace(/^window\.LAIBENCH_DATA\s*=\s*/, "").replace(/;\s*$/, "");
    const data = JSON.parse(json) as { locales?: Record<string, { cases?: unknown }> };
    const FORBIDDEN = new Set([
      "caseId", "case_id", "instanceId", "instance_id", "goldFindings",
      "criticalFindings", "referenceReport", "model_output", "prediction", "predictions",
    ]);
    const bad: string[] = [];
    const walk = (o: unknown, path: string): void => {
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o as Record<string, unknown>)) {
        if (FORBIDDEN.has(k)) bad.push(`${path}.${k}`);
        walk((o as Record<string, unknown>)[k], `${path}.${k}`);
      }
    };
    walk(data, "data");
    for (const lk of Object.keys(data.locales ?? {})) {
      if (Array.isArray(data.locales![lk].cases)) bad.push(`locales.${lk}.cases is an array (must be an aggregate count)`);
    }
    assert.equal(bad.length, 0, `site/data.js must be aggregate-only (no per-case identifiers or raw findings); found: ${bad.join(", ")}`);
  });
});

// Count/hash drift guard: the en-US public suite's case count and suite hash must
// agree across the suite manifest, the actual case file, GOVERNANCE.md, and the
// benchmark card. This pins the "12 vs 49" class of drift that a prior review
// caught manually.
import { suiteHashFromCases } from "./provenance.js";
import type { BenchCase } from "./types.js";

describe("docs/consistency: en-US public suite count + hash are pinned across artifacts", () => {
  const root = process.cwd();
  const suite = JSON.parse(readFileSync(join(root, "suites/lite-public.en-US.json"), "utf8")) as {
    caseCount: number; casesPath: string;
  };
  const cases = JSON.parse(readFileSync(join(root, "suites", suite.casesPath), "utf8")) as BenchCase[];

  it("suite caseCount equals the actual number of cases shipped", () => {
    assert.equal(suite.caseCount, cases.length, `suite caseCount=${suite.caseCount} but case file has ${cases.length}`);
  });

  it("GOVERNANCE.md and the benchmark card state the same case count", () => {
    const gov = readFileSync(join(root, "GOVERNANCE.md"), "utf8");
    assert.ok(gov.includes(`${cases.length} synthetic`), `GOVERNANCE.md must say "${cases.length} synthetic"`);
    const card = readFileSync(join(root, "docs/benchmark-cards.md"), "utf8");
    assert.ok(new RegExp(`Case count \\| ${cases.length}\\b`).test(card), `benchmark card must show Case count | ${cases.length}`);
  });

  it("benchmark card suite hash equals the recomputed hash of the shipped cases", () => {
    const card = readFileSync(join(root, "docs/benchmark-cards.md"), "utf8");
    const recomputed = suiteHashFromCases(cases);
    assert.ok(card.includes(recomputed), `card must list the en-US suite hash ${recomputed}`);
  });
});
