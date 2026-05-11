/**
 * Backward-compatible entry point for deterministic checks.
 * Delegates to the structural evaluator.
 *
 * NOTE: The actual check logic now lives in src/evaluators/structural.ts.
 * This file is kept for backward compatibility with existing imports.
 */

import { runStructuralChecks } from "./evaluators/structural.js";
import type { Check, ExamMeta, LocaleKey } from "./types.js";

/**
 * Run deterministic structural checks on a report.
 * @deprecated Use runStructuralChecks from src/evaluators/structural.ts directly.
 */
export function runDeterministicChecks(html: string, meta: ExamMeta, findingsInput: string, localeKey: LocaleKey): Check[] {
  return runStructuralChecks(html, meta, findingsInput, localeKey);
}
