import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { benchmarkCase } from "./benchmark.js";
import { suiteHashFromCases } from "./provenance.js";
import { sha256Hex } from "../site-src/shims/crypto.js";
import type { BenchCase } from "./types.js";
// @ts-ignore
import { buildReferenceReport } from "../examples/reference-agent.mjs";

// The website runs the scorer in the browser. It must be the SAME scorer: this
// test bundles it exactly as scripts/build-site-scorer.mjs does and requires
// identical verdicts, scores, gate reasons and check outcomes to the CLI path.
const root = resolve(new URL(".", import.meta.url).pathname, "..");

describe("browser crypto shim", () => {
  it("sha256 matches node:crypto (ASCII, UTF-8, empty, block boundaries)", () => {
    const samples = ["", "a", "abc", "pneumotórax à direita — ≥ 3 mm", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)];
    for (const s of samples) assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s.slice(0, 20)));
  });
});

describe("in-browser scorer parity with the CLI scorer", () => {
  let site: { scoreReport: (i: unknown) => Promise<any>; suiteHashFromCases: (c: unknown[]) => string; BENCHMARK_VERSION: string };
  const cases = JSON.parse(readFileSync(join(root, "cases/public/synthetic-demo.en-US.json"), "utf8")) as BenchCase[];

  before(async () => {
    const out = join(mkdtempSync(join(tmpdir(), "laibench-site-")), "scorer.mjs");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(root, "scripts/build-site-scorer.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    site = await import(pathToFileURL(out).href);
  });

  it("suiteHash computed by the bundle equals the CLI's", () => {
    assert.equal(site.suiteHashFromCases(cases), suiteHashFromCases(cases));
  });

  it("identical results on reference, degraded and adversarial reports", async () => {
    const variants = (c: BenchCase): string[] => [
      buildReferenceReport({ exam: c.exam, findings: c.findings, locale: "en-US" }),
      buildReferenceReport({ exam: c.exam, findings: "No acute abnormality.", locale: "en-US" }),
      buildReferenceReport({ exam: c.exam, findings: `${c.findings} Small right apical pneumothorax.`, locale: "en-US" }),
      "<p>**Markdown** report</p>",
    ];
    for (const c of cases.slice(0, 20)) {
      for (const html of variants(c)) {
        const cli = await benchmarkCase({ case: c, locale: "en-US", providedHtml: html, providerLabel: "browser", modelLabel: "browser" });
        const web = await site.scoreReport({ exam: c.exam, findings: c.findings, locale: "en-US", html, id: c.id });
        assert.equal(web.verdict, cli.verdict, c.id);
        assert.equal(web.score, cli.combinedOverall, c.id);
        assert.deepEqual(web.gateReasons, cli.gateReasons, c.id);
        assert.deepEqual(web.checks.map((k: any) => [k.id, k.passed]), cli.checks.map((k) => [k.id, k.passed]), c.id);
      }
    }
  });
});

describe("published site artifacts are in sync with the scoring source", () => {
  it("site/assets/laibench-scorer.js and site/provenance.json carry the current scoringHash", async () => {
    const { buildProvenanceManifest } = await import("./provenance.js");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const prev = process.cwd();
    process.chdir(root);
    const prov = await buildProvenanceManifest({ benchmarkVersion: pkg.version, suites: [] });
    process.chdir(prev);
    const bundle = readFileSync(join(root, "site/assets/laibench-scorer.js"), "utf8");
    assert.ok(bundle.includes(`scoringHash ${prov.scoringHash}`), "site scorer bundle is stale: run `npm run site:build`");
    const siteProv = JSON.parse(readFileSync(join(root, "site/provenance.json"), "utf8"));
    assert.equal(siteProv.scoringHash, prov.scoringHash, "site/provenance.json is stale: run `npm run site:build`");
    assert.equal(siteProv.benchmarkVersion, pkg.version);
  });
});
