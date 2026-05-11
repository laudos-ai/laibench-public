import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPredictionsJsonl, validatePredictions } from "./submission.js";
import type { BenchCase, SubmissionPrediction } from "./types.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const cases: BenchCase[] = [
  {
    id: "R001",
    exam: "TC de cranio sem contraste",
    findings: "Sem alteracoes agudas.",
  },
];

describe("validatePredictions", () => {
  it("accepts the public submission template shape", async () => {
    const templatePath = join(ROOT, "examples/submission-template.jsonl");
    const predictions = await readPredictionsJsonl(templatePath);
    const validation = validatePredictions(cases, predictions);
    assert.equal(validation.valid, true);
    assert.equal(predictions.length, 1);
    assert.match(readFileSync(join(ROOT, "schemas/prediction-record.schema.json"), "utf8"), /prediction record/);
  });

  it("accepts public-safe metadata objects in frozen predictions", () => {
    const predictions: SubmissionPrediction[] = [
      {
        instance_id: "R001",
        model_output: "<center><b>TC DE CRANIO</b></center><br>Normal.",
        metadata: { evidenceIds: ["doc-1", "doc-2"] },
      },
    ];

    const validation = validatePredictions(cases, predictions);
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.errors, []);
  });

  it("rejects malformed prediction metadata", () => {
    const predictions = [
      {
        instance_id: "R001",
        model_output: "<center><b>TC DE CRANIO</b></center><br>Normal.",
        metadata: ["doc-1"],
      },
    ] as unknown as SubmissionPrediction[];

    const validation = validatePredictions(cases, predictions);
    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /metadata must be an object/);
  });
});
