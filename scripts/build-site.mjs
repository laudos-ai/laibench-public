#!/usr/bin/env node
// One-command website build: bundles the real scorer, copies the public cases,
// and writes the provenance manifest the "Verify" section checks against.
//   npx tsx scripts/build-site.mjs        (npm run site:build)
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/build-site-scorer.mjs"], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

mkdirSync("site/cases", { recursive: true });
copyFileSync("cases/public/synthetic-demo.en-US.json", "site/cases/synthetic-demo.en-US.json");
console.log("Copied public synthetic cases → site/cases/");

const { buildProvenanceManifest } = await import("../src/provenance.ts");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cases = JSON.parse(readFileSync("cases/public/synthetic-demo.en-US.json", "utf8"));
const prov = await buildProvenanceManifest({
  benchmarkVersion: pkg.version,
  suites: [{ suiteId: "lite-public.en-US", locale: "en-US", cases }],
});
delete prov.generatedAt; // keep the file byte-stable across rebuilds
writeFileSync("site/provenance.json", JSON.stringify(prov, null, 1) + "\n");
console.log(`Wrote site/provenance.json (scoringHash ${prov.scoringHash})`);
