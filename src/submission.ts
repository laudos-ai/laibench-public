import { readFile } from "node:fs/promises";
import type { BenchCase, SubmissionPrediction, SubmissionValidation } from "./types.js";

export async function readPredictionsJsonl(path: string): Promise<SubmissionPrediction[]> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const predictions: SubmissionPrediction[] = [];
  const errors: string[] = [];

  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as SubmissionPrediction;
      predictions.push(parsed);
    } catch (error) {
      errors.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (errors.length > 0) throw new Error(`Invalid JSONL in ${path}: ${errors.join("; ")}`);
  return predictions;
}

// Top-level keys permitted by schemas/prediction-record.schema.json
// (additionalProperties:false). Anything else fails validation.
const ALLOWED_PREDICTION_KEYS = new Set(["instance_id", "model_output", "metadata", "model_name_or_path"]);

export function validatePredictions(cases: BenchCase[], predictions: SubmissionPrediction[]): SubmissionValidation {
  const expectedIds = cases.map((item) => item.id);
  const receivedIds = predictions.map((item) => item.instance_id);
  const receivedCount = new Map<string, number>();
  const emptyOutputs: string[] = [];
  const errors: string[] = [];

  predictions.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      errors.push(`prediction ${index + 1}: not an object`);
      return;
    }
    if (typeof item.instance_id !== "string" || item.instance_id.trim() === "") errors.push(`prediction ${index + 1}: missing instance_id`);
    if (typeof item.model_output !== "string") errors.push(`prediction ${index + 1}: missing model_output`);
    else if (item.model_output.trim() === "") emptyOutputs.push(item.instance_id);
    if (
      "metadata" in item &&
      (item.metadata === null || typeof item.metadata !== "object" || Array.isArray(item.metadata))
    ) {
      errors.push(`prediction ${index + 1}: metadata must be an object when provided`);
    }
    // Enforce the published prediction-record schema's additionalProperties:false at
    // the top level. A submission cannot smuggle scoring inputs (e.g. retrievedDocIds)
    // as unknown top-level keys and still validate as eligible.
    const unknownKeys = Object.keys(item).filter((k) => !ALLOWED_PREDICTION_KEYS.has(k));
    if (unknownKeys.length > 0) errors.push(`prediction ${index + 1}: unknown keys not allowed: ${unknownKeys.join(", ")}`);

    const key = item.instance_id;
    receivedCount.set(key, (receivedCount.get(key) ?? 0) + 1);
  });

  const expectedSet = new Set(expectedIds);
  const receivedSet = new Set(receivedIds);
  const missingIds = expectedIds.filter((id) => !receivedSet.has(id));
  const duplicateIds = Array.from(receivedCount.entries()).filter(([, count]) => count > 1).map(([id]) => id);
  const extraIds = receivedIds.filter((id) => !expectedSet.has(id));

  if (missingIds.length > 0) errors.push(`missing cases: ${missingIds.join(", ")}`);
  if (duplicateIds.length > 0) errors.push(`duplicate cases: ${duplicateIds.join(", ")}`);
  if (extraIds.length > 0) errors.push(`extra cases: ${extraIds.join(", ")}`);
  if (emptyOutputs.length > 0) errors.push(`empty outputs: ${emptyOutputs.join(", ")}`);

  return {
    valid: errors.length === 0,
    expectedIds,
    receivedIds,
    missingIds,
    duplicateIds,
    extraIds,
    emptyOutputs,
    errors,
  };
}

export function materializeCaseHtmlMap(predictions: SubmissionPrediction[]): Map<string, SubmissionPrediction> {
  return new Map(predictions.map((item) => [item.instance_id, item]));
}
