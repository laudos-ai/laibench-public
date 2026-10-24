#!/usr/bin/env node
// Bundle the real LAIBench scorer for the website (site/assets/laibench-scorer.js).
// Usage: node scripts/build-site-scorer.mjs [--out site/assets/laibench-scorer.js]
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outIdx = process.argv.indexOf("--out");
const outfile = resolve(root, outIdx > 0 ? process.argv[outIdx + 1] : "site/assets/laibench-scorer.js");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// scoringHash is computed from the pinned scoring files exactly like the CLI.
const { buildProvenanceManifest } = await import("../src/provenance.ts").catch(async () => {
  throw new Error("run with tsx: npx tsx scripts/build-site-scorer.mjs");
});
process.chdir(root);
const prov = await buildProvenanceManifest({ benchmarkVersion: pkg.version, suites: [] });

mkdirSync(dirname(outfile), { recursive: true });
const shim = (p) => resolve(root, "site-src/shims", p);
await build({
  entryPoints: [resolve(root, "site-src/scorer-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  outfile,
  alias: {
    "node:crypto": shim("crypto.ts"),
    "node:fs/promises": shim("node-io.ts"),
    "node:fs": shim("node-io.ts"),
    "node:path": shim("node-io.ts"),
    "node:url": shim("node-io.ts"),
    "node:process": shim("process.ts"),
  },
  // log.ts writes to process.stdout/stderr (judge warnings only, unreachable
  // without a judge). Map them to inert locals so no code path can throw.
  define: {
    "process.env.LAIBENCH_DEBUG": "undefined",
    "process.stdout": "__lbStd",
    "process.stderr": "__lbStd",
    "process.argv": "__lbArgv",
  },
  banner: { js: `/* LAIBench ${pkg.version} in-browser scorer · scoringHash ${prov.scoringHash} · MIT · https://github.com/laudos-ai/laibench-public */\nvar __lbStd={write(){return true}},__lbArgv=[];` },
  plugins: [{
    name: "stamp",
    setup(b) {
      b.onLoad({ filter: /scorer-entry\.ts$/ }, async (args) => ({
        loader: "ts",
        contents: readFileSync(args.path, "utf8")
          .replace("__BENCHMARK_VERSION__", pkg.version)
          .replace("__SCORING_HASH__", prov.scoringHash),
      }));
    },
  }],
});
console.log(`Wrote ${outfile} (scoringHash ${prov.scoringHash})`);
