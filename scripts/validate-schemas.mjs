#!/usr/bin/env node
// Validate that the published JSON Schemas accept the data this repo actually ships.
// Guards against schema drift. Runs in CI; depends only on committed files.
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
let failures = 0;

// 1) Every schema must itself be a compilable JSON Schema.
const schemas = {};
for (const f of readdirSync("schemas").filter((f) => f.endsWith(".schema.json"))) {
  try { schemas[f] = ajv.compile(load(join("schemas", f))); console.log(`✅ compiles: schemas/${f}`); }
  catch (e) { failures++; console.log(`❌ invalid schema schemas/${f}: ${e.message}`); }
}

// 2) Every public case must validate against case.schema.json.
const caseValidate = schemas["case.schema.json"];
if (caseValidate) {
  let ok = 0, bad = 0;
  for (const f of readdirSync("cases/public").filter((f) => f.endsWith(".json"))) {
    for (const c of load(join("cases/public", f))) {
      if (caseValidate(c)) ok++;
      else { bad++; failures++; console.log(`❌ cases/public/${f}#${c.id}: ${ajv.errorsText(caseValidate.errors)}`); }
    }
  }
  console.log(`${bad ? "❌" : "✅"} case.schema vs cases/public/*: ${ok} pass / ${bad} fail`);
}

// 3) Submission template (if present) must validate against prediction-record.schema.json.
const predValidate = schemas["prediction-record.schema.json"];
const tmpl = ["examples/submission-template.jsonl"].find(existsSync);
if (predValidate && tmpl) {
  let ok = 0, bad = 0;
  for (const [i, line] of readFileSync(tmpl, "utf8").trim().split("\n").entries()) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (predValidate(rec)) ok++;
    else { bad++; failures++; console.log(`❌ ${tmpl}#${i}: ${ajv.errorsText(predValidate.errors)}`); }
  }
  console.log(`${bad ? "❌" : "✅"} prediction-record vs ${tmpl}: ${ok} pass / ${bad} fail`);
}

console.log(failures ? `\n${failures} schema validation failure(s)` : "\nAll schemas validate against shipped data.");
process.exit(failures ? 1 : 0);
