/**
 * Perturbation outcome evaluator.
 *
 * Given a perturb-matrix output (one synthetic adversarial output per case+kind)
 * and a SuiteRunResult that scored those outputs, decide whether each
 * perturbation was *caught* by the bench.
 *
 * Catch rule:
 *   - If perturbation expected dim D at severity S, the case-result must show
 *     either (a) a det check failing on D with severity ≥ S, OR
 *            (b) a judge critical_failure on D, OR
 *            (c) a combined dim score below the per-severity floor:
 *                  critical → < 60
 *                  major    → < 80
 *                  minor    → < 90
 *
 * The pipeline is:
 *   1. `perturb-matrix --suite X --out perturb.json`
 *   2. Submit perturb samples as predictions to the same suite
 *      (caseId → perturbed text). Each prediction inherits the case's gold.
 *   3. `eval-submission --predictions perturb-predictions.jsonl`
 *   4. Pass the resulting run + the perturb matrix to `summarizePerturbationRun`.
 */

import type { BenchCase, CaseRunResult, SuiteRunResult } from "./types.js";
import type { PerturbationKind, PerturbationSpec, PerturbedSample } from "./perturb.js";
import { PERTURBATIONS, applyPerturbation, summarizeRobustness } from "./perturb.js";

const SEVERITY_FLOOR: Record<"critical" | "major" | "minor", number> = {
  critical: 60,
  major: 80,
  minor: 90,
};

export type PerturbationLink = {
  caseId: string; // original case id
  kind: PerturbationKind;
  predictionId: string; // id of the prediction in the run (often `${caseId}__${kind}`)
};

export function isPerturbationCaught(spec: PerturbationSpec, result: CaseRunResult): boolean {
  const floor = SEVERITY_FLOOR[spec.expectedSeverity];

  for (const dim of spec.expectedDims) {
    // (a) deterministic check fail at expected severity
    const failedDet = result.checks.some(
      (c) => c.dim === dim && !c.passed && c.severity === spec.expectedSeverity,
    );
    if (failedDet) return true;

    // (b) judge critical failure on dim
    const judgeFlag = result.judge?.critical_failures.some((f) => f.dim === dim);
    if (judgeFlag) return true;

    // (c) combined dim score below severity floor
    const combined = result.combined[dim];
    if (combined !== null && combined !== undefined && combined < floor) return true;
  }
  return false;
}

export function summarizePerturbationRun(
  run: SuiteRunResult,
  links: PerturbationLink[],
): ReturnType<typeof summarizeRobustness> {
  const byPred = new Map<string, CaseRunResult>(run.results.map((r) => [r.case.id, r]));
  const outcomes = links
    .map((link) => {
      const result = byPred.get(link.predictionId);
      if (!result) return null;
      const spec = PERTURBATIONS[link.kind];
      return { kind: link.kind, caught: isPerturbationCaught(spec, result) };
    })
    .filter((x): x is { kind: PerturbationKind; caught: boolean } => x !== null);
  return summarizeRobustness(outcomes);
}

/**
 * Build the (case × perturbation) matrix using each case's reference text.
 * Returns the synthetic predictions list and the link table for catch evaluation.
 */
export function buildPerturbationDataset(
  cases: BenchCase[],
  options: { kinds?: PerturbationKind[] } = {},
): { samples: PerturbedSample[]; links: PerturbationLink[] } {
  const kinds = (options.kinds ?? (Object.keys(PERTURBATIONS) as PerturbationKind[])) as PerturbationKind[];
  const samples: PerturbedSample[] = [];
  const links: PerturbationLink[] = [];
  for (const c of cases) {
    const source = c.referenceReport ?? c.findings;
    for (const kind of kinds) {
      const text = applyPerturbation(kind, c, source);
      samples.push({ caseId: c.id, kind, text, spec: PERTURBATIONS[kind] });
      links.push({ caseId: c.id, kind, predictionId: c.id });
    }
  }
  return { samples, links };
}
