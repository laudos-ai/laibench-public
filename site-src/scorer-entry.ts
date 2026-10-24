/**
 * LAIBench in-browser scorer — the SAME TypeScript scoring code the CLI runs,
 * bundled with esbuild (scripts/build-site-scorer.mjs). Deterministic only: no
 * LLM judge, no network. Nothing typed into the page leaves the browser.
 */
import { benchmarkCase } from "../src/benchmark.js";
import { suiteHashFromCases, caseHash } from "../src/provenance.js";
import { WEIGHTS, DIMS } from "../src/scoring.js";
import { evaluateSourceCriticals } from "../src/evaluators/source-critical.js";
import type { BenchCase, LocaleKey } from "../src/types.js";
// @ts-ignore — plain ESM, shared with the CLI reference agent
import { buildReferenceReport } from "../examples/reference-agent.mjs";
import { sha256Hex } from "./shims/crypto.js";

export const BENCHMARK_VERSION = "__BENCHMARK_VERSION__";
export const SCORING_HASH = "__SCORING_HASH__";

export async function scoreReport(input: { exam: string; findings: string; locale: LocaleKey; html: string; id?: string }) {
  const benchCase = { id: input.id ?? "browser", exam: input.exam, findings: input.findings, locale: input.locale } as BenchCase;
  const r = await benchmarkCase({ case: benchCase, locale: input.locale, providedHtml: input.html, providerLabel: "browser", modelLabel: "browser" });
  return {
    verdict: r.verdict,
    score: r.combinedOverall,
    dims: r.combined,
    detDims: r.detDims,
    detOverall: r.detOverall,
    gateReasons: r.gateReasons,
    checks: r.checks,
    criteriaPassed: r.criteriaPassed,
    criteriaTotal: r.criteriaTotal,
    allPass: r.allPass,
    meta: r.meta,
  };
}

export { buildReferenceReport, suiteHashFromCases, caseHash, sha256Hex, WEIGHTS, DIMS, evaluateSourceCriticals };
