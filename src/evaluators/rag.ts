/**
 * Retrieval evaluator.
 * If case has retrievalGold: compute Precision@k, Recall@k, MRR, nDCG.
 * If no retrieval data: UNSCORED (skip).
 * Support retrieval+generation pipeline evaluation.
 */

import { normalizeLoose, stripTags } from "../normalize.js";
import type { BenchCase, Check, EvaluatorResult, ExamMeta, LocaleKey, RetrievalRelevance } from "../types.js";

function structuralScore(checks: Check[]): number {
  if (checks.length === 0) return 100;
  const weight = (check: Check): number => check.severity === "critical" ? 5 : check.severity === "major" ? 2 : 0.5;
  const total = checks.reduce((sum, check) => sum + weight(check), 0);
  const passed = checks.reduce((sum, check) => sum + (check.passed ? weight(check) : 0), 0);
  return Math.round((passed / total) * 100);
}

function structuralRagFallbackChecks(structuralChecks: Check[]): Check[] {
  return structuralChecks.filter((check) => check.dim === "RAG" && check.id !== "R05");
}

function unsupportedTechniqueDetails(reportHtml: string, benchCase: BenchCase): string[] {
  const report = normalizeLoose(stripTags(reportHtml));
  const source = normalizeLoose([
    benchCase.exam,
    benchCase.findings,
    benchCase.referenceReport ?? "",
  ].join(" "));
  const candidates = [
    { label: "T1 sequence", rx: /\bt1\b/ },
    { label: "T2 sequence", rx: /\bt2\b/ },
    { label: "FLAIR sequence", rx: /\bflair\b/ },
    { label: "DWI sequence", rx: /\bdwi\b|\bdifusao\b/ },
    { label: "axial acquisition", rx: /\baxial\b|\baxiais\b/ },
    { label: "sagittal acquisition", rx: /\bsagital\b|\bsagitais\b/ },
    { label: "coronal acquisition", rx: /\bcoronal\b|\bcoronais\b/ },
    { label: "slice thickness", rx: /\b\d+(?:[.,]\d+)?\s*mm\s+de\s+espessura\b|\bthickness\b/ },
  ];

  return candidates
    .filter(({ rx }) => rx.test(report) && !rx.test(source))
    .map(({ label }) => label);
}

// ---- IR metrics ----

/**
 * Compute Discounted Cumulative Gain for a ranked list of relevance scores.
 */
function dcg(relevances: number[]): number {
  let score = 0;
  for (let i = 0; i < relevances.length; i++) {
    score += (Math.pow(2, relevances[i]) - 1) / Math.log2(i + 2);
  }
  return score;
}

/**
 * Compute Ideal DCG for the best possible ranking from a full gold set.
 * BUG 4 FIX: iDCG must be computed from ALL gold relevances sorted descending,
 * not just from the retrieved slice. Otherwise nDCG is inflated.
 */
function idcg(allGoldRelevances: number[], k: number): number {
  const sorted = [...allGoldRelevances].sort((a, b) => b - a);
  return dcg(sorted.slice(0, k));
}

/**
 * Compute normalized Discounted Cumulative Gain.
 * @param relevances - relevance scores in retrieval order
 * @param allGoldRelevances - all gold relevance scores (for ideal ranking)
 */
function ndcg(relevances: number[], allGoldRelevances: number[]): number {
  const ideal = idcg(allGoldRelevances, relevances.length);
  if (ideal === 0) return 0;
  return dcg(relevances) / ideal;
}

/**
 * Compute nDCG@k for top-k results.
 * @param relevances - relevance scores in retrieval order
 * @param allGoldRelevances - all gold relevance scores (for ideal ranking)
 * @param k - cutoff
 */
function ndcgAtK(relevances: number[], allGoldRelevances: number[], k: number): number {
  const topK = relevances.slice(0, k);
  const ideal = idcg(allGoldRelevances, k);
  if (ideal === 0) return 0;
  return dcg(topK) / ideal;
}

/**
 * Compute Precision@k: fraction of top-k results that are relevant.
 */
function precisionAtK(relevances: number[], k: number, threshold = 1): number {
  const topK = relevances.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter((r) => r >= threshold).length;
  return relevant / topK.length;
}

/**
 * Compute Recall@k: fraction of all relevant documents found in top-k.
 */
function recallAtK(relevances: number[], allRelevances: number[], k: number, threshold = 1): number {
  const totalRelevant = allRelevances.filter((r) => r >= threshold).length;
  if (totalRelevant === 0) return 1; // no relevant docs, recall is trivially 1
  const topK = relevances.slice(0, k);
  const foundRelevant = topK.filter((r) => r >= threshold).length;
  return foundRelevant / totalRelevant;
}

/**
 * Compute Mean Reciprocal Rank: 1/rank of first relevant result.
 */
function mrr(relevances: number[], threshold = 1): number {
  for (let i = 0; i < relevances.length; i++) {
    if (relevances[i] >= threshold) return 1 / (i + 1);
  }
  return 0;
}

// ---- Main evaluator ----

/**
 * Evaluate retrieval quality.
 * Requires retrievalGold on the case; otherwise returns UNSCORED.
 */
export function evaluateRetrieval(
  reportHtml: string,
  benchCase: BenchCase,
  _locale: LocaleKey,
  _meta: ExamMeta,
  structuralChecks: Check[],
  retrievedDocIds?: string[],
): EvaluatorResult {
  const checks: Check[] = [];
  const details: Record<string, unknown> = {};

  // If no retrieval gold data, fall back to structural RAG checks or skip
  if (!benchCase.retrievalGold || benchCase.retrievalGold.length === 0) {
    // If there are structural RAG checks, use them
    const ragChecks = structuralRagFallbackChecks(structuralChecks);
    const unsupported = unsupportedTechniqueDetails(reportHtml, benchCase);
    if (unsupported.length > 0) {
      ragChecks.push({
        dim: "RAG",
        id: "R04",
        name: "No unsupported acquisition details",
        severity: "major",
        passed: false,
        evidence: unsupported.join(", "),
      });
    }
    if (ragChecks.length > 0) {
      details.mode = "structural-fallback";
      details.unsupportedTechniqueDetails = unsupported;
      const score = structuralScore(ragChecks);
      return { dim: "RAG", score, checks: ragChecks, details };
    }

    // No gold data and no structural checks -> UNSCORED
    details.mode = "unscored";
    return {
      dim: "RAG",
      score: -1, // sentinel for "UNSCORED"
      checks: [],
      details,
    };
  }

  // Build relevance map from gold
  const goldMap = new Map<string, number>();
  for (const item of benchCase.retrievalGold) {
    goldMap.set(item.documentId, item.relevance);
  }

  // If no retrieved documents provided, we can't compute IR metrics
  // This happens when running without a retrieval pipeline
  if (!retrievedDocIds || retrievedDocIds.length === 0) {
    details.mode = "retrieval-gold-present-no-pipeline";
    details.note = "retrievalGold present but no retrieval pipeline results to evaluate";

    // Still check structural RAG checks if available
    const ragChecks = structuralRagFallbackChecks(structuralChecks);
    if (ragChecks.length > 0) {
      const score = structuralScore(ragChecks);
      return { dim: "RAG", score, checks: ragChecks, details };
    }

    return { dim: "RAG", score: -1, checks: [], details };
  }

  details.mode = "retrieval-evaluation";

  // Build relevance array in retrieval order
  const relevances = retrievedDocIds.map((id) => goldMap.get(id) ?? 0);
  const allRelevances = benchCase.retrievalGold.map((item) => item.relevance);

  // Compute metrics at various K values
  const kValues = [1, 3, 5, 10].filter((k) => k <= retrievedDocIds.length);

  for (const k of kValues) {
    const pk = precisionAtK(relevances, k);
    const rk = recallAtK(relevances, allRelevances, k);
    const nk = ndcgAtK(relevances, allRelevances, k);

    details[`precision@${k}`] = Number(pk.toFixed(3));
    details[`recall@${k}`] = Number(rk.toFixed(3));
    details[`ndcg@${k}`] = Number(nk.toFixed(3));
  }

  const mrrScore = mrr(relevances);
  const ndcgAll = ndcg(relevances, allRelevances);
  details.mrr = Number(mrrScore.toFixed(3));
  details.ndcg = Number(ndcgAll.toFixed(3));
  details.retrievedCount = retrievedDocIds.length;
  details.goldCount = benchCase.retrievalGold.length;

  // Generate checks based on metrics
  const primaryK = Math.min(5, retrievedDocIds.length);
  const pk5 = precisionAtK(relevances, primaryK);
  const rk5 = recallAtK(relevances, allRelevances, primaryK);
  const nk5 = ndcgAtK(relevances, allRelevances, primaryK);

  checks.push({
    dim: "RAG",
    id: "RG01",
    name: `Precision@${primaryK}`,
    severity: "major",
    passed: pk5 >= 0.6,
    evidence: `P@${primaryK}=${(pk5 * 100).toFixed(0)}%`,
  });

  checks.push({
    dim: "RAG",
    id: "RG02",
    name: `Recall@${primaryK}`,
    severity: "critical",
    passed: rk5 >= 0.5,
    evidence: `R@${primaryK}=${(rk5 * 100).toFixed(0)}%`,
  });

  checks.push({
    dim: "RAG",
    id: "RG03",
    name: `nDCG@${primaryK}`,
    severity: "major",
    passed: nk5 >= 0.5,
    evidence: `nDCG@${primaryK}=${(nk5 * 100).toFixed(0)}%`,
  });

  checks.push({
    dim: "RAG",
    id: "RG04",
    name: "Mean Reciprocal Rank",
    severity: "major",
    passed: mrrScore >= 0.5,
    evidence: `MRR=${(mrrScore * 100).toFixed(0)}%`,
  });

  // Composite score: weighted combination of metrics
  // Recall-heavy since missing relevant documents impacts generation quality
  const score = Math.round(
    rk5 * 40 + // recall most important
    pk5 * 20 + // precision matters
    nk5 * 25 + // ranking quality
    mrrScore * 15 // first relevant result position
  );

  return { dim: "RAG", score: Math.min(100, score), checks, details };
}
