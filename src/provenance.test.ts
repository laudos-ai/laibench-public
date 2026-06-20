import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { caseHash, suiteHashFromCases, runHash, leaderboardHash, DEFAULT_SCORING_FILES } from "./provenance.js";
import type { BenchCase, RunManifest, SuiteRunResult } from "./types.js";

const c1: BenchCase = { id: "A", exam: "tc cranio", findings: "ok", locale: "pt-BR" };
const c2: BenchCase = { id: "B", exam: "tc torax", findings: "ok", locale: "pt-BR" };

describe("caseHash", () => {
  it("returns 64-char hex sha256", () => {
    const h = caseHash(c1);
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
  it("is stable across calls", () => {
    assert.equal(caseHash(c1), caseHash(c1));
  });
  it("differs between cases", () => {
    assert.notEqual(caseHash(c1), caseHash(c2));
  });
  it("differs when findings change", () => {
    const cMod: BenchCase = { ...c1, findings: "different" };
    assert.notEqual(caseHash(c1), caseHash(cMod));
  });
  it("differs when score-affecting answer keys change", () => {
    const base: BenchCase = {
      ...c1,
      goldFindings: [{ finding: "small hemorrhage", severity: "critical" }],
      referenceReport: "<b>Findings</b><br>small hemorrhage",
      retrievalGold: [{ documentId: "doc-1", relevance: 3 }],
    };
    assert.notEqual(caseHash(base), caseHash({ ...base, referenceReport: "<b>Findings</b><br>normal" }));
    assert.notEqual(caseHash(base), caseHash({ ...base, retrievalGold: [{ documentId: "doc-2", relevance: 3 }] }));
    assert.notEqual(caseHash(base), caseHash({ ...base, goldFindings: [{ finding: "small hemorrhage", severity: "major" }] }));
  });
});

describe("suiteHashFromCases", () => {
  it("is order-independent", () => {
    assert.equal(suiteHashFromCases([c1, c2]), suiteHashFromCases([c2, c1]));
  });
  it("changes when a case content changes", () => {
    const cMod: BenchCase = { ...c1, exam: "X" };
    assert.notEqual(suiteHashFromCases([c1, c2]), suiteHashFromCases([cMod, c2]));
  });
  it("changes when score-affecting answer keys change", () => {
    const keyed: BenchCase = { ...c1, referenceReport: "reference A" };
    const changed: BenchCase = { ...keyed, referenceReport: "reference B" };
    assert.notEqual(suiteHashFromCases([keyed, c2]), suiteHashFromCases([changed, c2]));
  });
});

describe("runHash", () => {
  const manifest: Omit<RunManifest, "validation" | "createdAt"> = {
    benchmarkName: "laibench",
    benchmarkVersion: "2.0.0",
    runName: "test",
    suiteId: "test-suite",
    suiteLabel: "test",
    suiteVisibility: "public",
    suiteHash: "deadbeef",
    locale: "pt-BR",
    track: "model",
    provider: "openrouter",
    modelLabel: "claude-sonnet-4.6",
      entityName: "test",
      entityType: "research",
      systemType: "raw-model",
      comparisonClass: "test",
    scaffoldId: null,
    judgeProvider: "openrouter",
    judgeModel: "claude-opus-4.6",
    evaluationMode: "local",
    submissionMode: "generator",
    comparableKey: "k",
    canaryToken: "TOKEN",
  };

  it("changes when scoring hash changes", () => {
    const h1 = runHash({ suiteHash: "S1", manifest, scoringHash: "X" });
    const h2 = runHash({ suiteHash: "S1", manifest, scoringHash: "Y" });
    assert.notEqual(h1, h2);
  });

  it("changes when suite hash changes", () => {
    const h1 = runHash({ suiteHash: "S1", manifest, scoringHash: "X" });
    const h2 = runHash({ suiteHash: "S2", manifest, scoringHash: "X" });
    assert.notEqual(h1, h2);
  });
});

describe("leaderboardHash", () => {
  const baseRun = (n: string, avg: number): SuiteRunResult => ({
    manifest: {
      benchmarkName: "laibench",
      benchmarkVersion: "2.0.0",
      createdAt: "",
      runName: n,
      suiteId: "s",
      suiteLabel: "",
      suiteVisibility: "public",
      suiteHash: "deadbeef",
      locale: "pt-BR",
      track: "model",
      provider: "x",
      modelLabel: n,
      entityName: "test",
      entityType: "research",
      systemType: "raw-model",
      comparisonClass: "test",
      scaffoldId: null,
      judgeProvider: null,
      judgeModel: null,
      evaluationMode: "local",
      submissionMode: "generator",
      validation: { valid: true, expectedIds: [], receivedIds: [], missingIds: [], duplicateIds: [], extraIds: [], emptyOutputs: [], errors: [] },
      comparableKey: "k",
    },
    summary: { accuracyRate: 0, averageOverall: avg, passRate: 0, strictPassRate: 0, averageLatencyMs: 0, totalCostUsd: 0, verdictCounts: { PASS: 0, PARTIAL: 0, FAIL: 0 }, averagePerDim: {} },
    results: [],
  });

  it("is order-independent", () => {
    const h1 = leaderboardHash([baseRun("a", 80), baseRun("b", 70)]);
    const h2 = leaderboardHash([baseRun("b", 70), baseRun("a", 80)]);
    assert.equal(h1, h2);
  });
  it("changes when a score changes", () => {
    const h1 = leaderboardHash([baseRun("a", 80)]);
    const h2 = leaderboardHash([baseRun("a", 81)]);
    assert.notEqual(h1, h2);
  });
});

/**
 * Provenance coverage guard.
 *
 * The scoringHash only protects what DEFAULT_SCORING_FILES lists. If a module
 * that actually runs during scoring (e.g. the hard CRIT gate logic in
 * clinical-match / critical-extractor / locales) is omitted, silent tampering
 * of that module leaves scoringHash unchanged — defeating the entire chain.
 *
 * This test statically walks the runtime import graph (excluding `import type`)
 * from the scoring entrypoints and asserts every reachable module under src/ is
 * pinned in DEFAULT_SCORING_FILES. Any future omission fails here.
 */
describe("DEFAULT_SCORING_FILES covers the scoring import graph", () => {
  // Repo root = parent of this file's dir (src/). cwd-independent.
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

  /**
   * Extract runtime module specifiers from a TS source file.
   * - Handles single- and multi-line `import { ... } from "..."`.
   * - Excludes `import type { ... } from "..."` (type-only, no runtime edge).
   * - Inline `{ type X, y }` is a runtime import (the statement still executes),
   *   so it is INCLUDED — matching ESM/verbatimModuleSyntax semantics.
   */
  function runtimeSpecifiers(source: string): string[] {
    const specs: string[] = [];
    // Match each import statement up to its `from "..."`. `[\s\S]*?from` is
    // non-greedy and the global flag resumes after each match, so multi-line
    // imports are captured without spanning across statements (no `import`
    // keyword ever appears inside the brace clause).
    const re = /\bimport(\s+type)?\b[\s\S]*?from\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const isTypeOnly = Boolean(m[1]);
      if (isTypeOnly) continue;
      specs.push(m[2]);
    }
    return specs;
  }

  /** Resolve a relative .js specifier to a repo-root-relative src/ path, or null. */
  function resolveToSrcPath(specifier: string, fromFileRel: string): string | null {
    if (!specifier.startsWith(".")) return null; // node: / bare specifiers
    const fromDirAbs = dirname(resolve(repoRoot, fromFileRel));
    const tsSpecifier = specifier.replace(/\.js$/, ".ts");
    const targetAbs = resolve(fromDirAbs, tsSpecifier);
    const rel = relative(repoRoot, targetAbs).split("\\").join("/");
    if (!rel.startsWith("src/")) return null;
    return rel;
  }

  function walk(entrypoints: string[]): Set<string> {
    const reachable = new Set<string>();
    const queue = [...entrypoints];
    while (queue.length > 0) {
      const fileRel = queue.shift()!;
      if (reachable.has(fileRel)) continue;
      reachable.add(fileRel);
      const source = readFileSync(resolve(repoRoot, fileRel), "utf8");
      for (const spec of runtimeSpecifiers(source)) {
        const dep = resolveToSrcPath(spec, fileRel);
        if (dep && !reachable.has(dep)) queue.push(dep);
      }
    }
    return reachable;
  }

  function evaluatorEntrypoints(): string[] {
    const dir = "src/evaluators";
    return readdirSync(resolve(repoRoot, dir))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `${dir}/${f}`)
      .sort();
  }

  it("self-check: the parser distinguishes runtime from type-only imports", () => {
    const src = [
      'import { round1 } from "./normalize.js";',
      'import type { Dim } from "./types.js";',
      'import {\n  a,\n  b,\n} from "../clinical-match.js";',
      'import { type X, y } from "./extract.js";',
    ].join("\n");
    assert.deepEqual(runtimeSpecifiers(src).sort(), ["../clinical-match.js", "./extract.js", "./normalize.js"]);
  });

  it("every runtime module reachable from scoring entrypoints is pinned in DEFAULT_SCORING_FILES", () => {
    const entrypoints = ["src/scoring.ts", ...evaluatorEntrypoints()];
    const reachable = walk(entrypoints);

    const pinned = new Set(DEFAULT_SCORING_FILES.map((p) => p.split("\\").join("/")));
    const missing = [...reachable].filter((f) => !pinned.has(f)).sort();

    assert.deepEqual(
      missing,
      [],
      `These runtime scoring modules are not pinned in DEFAULT_SCORING_FILES — silent tampering of them would NOT change scoringHash. Add them: ${missing.join(", ")}`,
    );
  });

  it("includes the gate-deciding modules the audit identified as missing", () => {
    // Regression anchor: these decide the hard CRIT gate. The pre-fix list
    // omitted them, so this assertion FAILS on the old DEFAULT_SCORING_FILES.
    const pinned = new Set(DEFAULT_SCORING_FILES.map((p) => p.split("\\").join("/")));
    for (const required of [
      "src/clinical-match.ts",
      "src/extractors/critical-extractor.ts",
      "src/locales/index.ts",
      "src/locales/types.ts",
      "src/locales/en-US.ts",
      "src/locales/pt-BR.ts",
    ]) {
      assert.ok(pinned.has(required), `DEFAULT_SCORING_FILES must pin ${required}`);
    }
  });
});
