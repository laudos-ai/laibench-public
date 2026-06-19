#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { logger } from "./log.js";
import type { Dim, Verdict } from "./types.js";

const DIMS: Dim[] = ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"];
const VERDICTS: Verdict[] = ["PASS", "PARTIAL", "FAIL"];

export type ReviewerLabel = {
  reviewerId: string;
  clinicallyAcceptable: boolean;
  dimensionVerdicts: Record<Dim, Exclude<Verdict, "UNSCORED">>;
  notes: string;
  signedAt: string;
};

export type AdjudicationCase = {
  caseId: string;
  goldFindingsReviewed: boolean;
  criticalFindingsReviewed: boolean;
  guidelineExpectationsReviewed: boolean;
  polarityReviewed?: boolean;
  lateralityReviewed?: boolean;
  measurementsReviewed?: boolean;
  criticalResultPolicyReviewed?: boolean;
  reviewerLabels: ReviewerLabel[];
};

export type AdjudicationRecord = {
  schemaVersion: "1.0";
  suiteId: string;
  suiteHash: string;
  lockedAt: string;
  caseIds: string[];
  adjudicators: string[];
  cases: AdjudicationCase[];
};

export type AdjudicationValidation = {
  valid: boolean;
  errors: string[];
  metrics: {
    reviewerCount: number;
    caseCount: number;
    clinicalAcceptabilityAgreement: number;
    perDimensionExactAgreement: number;
  };
};

function isIsoDate(value: string | undefined): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && /\d{4}-\d{2}-\d{2}T/.test(value);
}

function hasPhiRisk(value: string): boolean {
  return /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(value)
    || /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(value)
    || /\b(?:MRN|prontu[aá]rio|CPF|RG|telefone|phone|email)\b/i.test(value)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value);
}

function allSame<T>(values: T[]): boolean {
  return values.length > 0 && values.every((value) => value === values[0]);
}

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 10;
}

export function validateAdjudicationRecord(
  record: Partial<AdjudicationRecord>,
  expected?: { suiteId?: string; suiteHash?: string },
): AdjudicationValidation {
  const errors: string[] = [];
  if (record.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (!record.suiteId) errors.push("suiteId is required");
  if (!record.suiteHash) errors.push("suiteHash is required");
  if (!isIsoDate(record.lockedAt)) errors.push("lockedAt must be an ISO timestamp");
  if (expected?.suiteId && record.suiteId !== expected.suiteId) errors.push(`suiteId mismatch: expected ${expected.suiteId}, got ${record.suiteId}`);
  if (expected?.suiteHash && record.suiteHash !== expected.suiteHash) errors.push(`suiteHash mismatch: expected ${expected.suiteHash}, got ${record.suiteHash}`);

  const adjudicators = new Set(record.adjudicators ?? []);
  if (adjudicators.size < 2) errors.push("at least two adjudicators are required");
  const caseIds = record.caseIds ?? [];
  const cases = record.cases ?? [];
  if (caseIds.length === 0) errors.push("caseIds must not be empty");
  if (cases.length !== caseIds.length) errors.push("cases length must match caseIds length");

  let clinicalAgreementPasses = 0;
  let clinicalAgreementTotal = 0;
  let dimAgreementPasses = 0;
  let dimAgreementTotal = 0;

  const byCase = new Map(cases.map((item) => [item.caseId, item]));
  for (const id of caseIds) {
    const item = byCase.get(id);
    if (!item) {
      errors.push(`missing adjudication case: ${id}`);
      continue;
    }
    for (const field of [
      "goldFindingsReviewed",
      "criticalFindingsReviewed",
      "guidelineExpectationsReviewed",
      "polarityReviewed",
      "lateralityReviewed",
      "measurementsReviewed",
      "criticalResultPolicyReviewed",
    ] as const) {
      if (item[field] !== true) errors.push(`${id}: ${field} must be true`);
    }
    if (!Array.isArray(item.reviewerLabels) || item.reviewerLabels.length < 2) {
      errors.push(`${id}: at least two reviewerLabels are required`);
      continue;
    }
    const labelReviewers = new Set<string>();
    for (const label of item.reviewerLabels) {
      if (!adjudicators.has(label.reviewerId)) errors.push(`${id}: unknown reviewerId ${label.reviewerId}`);
      if (labelReviewers.has(label.reviewerId)) errors.push(`${id}: duplicate reviewerId ${label.reviewerId}`);
      labelReviewers.add(label.reviewerId);
      if (!isIsoDate(label.signedAt)) errors.push(`${id}/${label.reviewerId}: signedAt must be an ISO timestamp`);
      if (hasPhiRisk(label.notes ?? "")) errors.push(`${id}/${label.reviewerId}: reviewer notes contain PHI/PII-like text`);
      for (const dim of DIMS) {
        if (!VERDICTS.includes(label.dimensionVerdicts?.[dim])) errors.push(`${id}/${label.reviewerId}: invalid ${dim} verdict`);
      }
    }

    clinicalAgreementTotal += 1;
    if (allSame(item.reviewerLabels.map((label) => label.clinicallyAcceptable))) clinicalAgreementPasses += 1;
    for (const dim of DIMS) {
      dimAgreementTotal += 1;
      if (allSame(item.reviewerLabels.map((label) => label.dimensionVerdicts?.[dim]))) dimAgreementPasses += 1;
    }
  }

  const clinicalAgreement = pct(clinicalAgreementPasses, clinicalAgreementTotal);
  const dimAgreement = pct(dimAgreementPasses, dimAgreementTotal);
  if (clinicalAgreement < 80) errors.push(`clinical acceptability agreement ${clinicalAgreement}% is below 80%`);
  if (dimAgreement < 70) errors.push(`per-dimension exact agreement ${dimAgreement}% is below 70%`);

  return {
    valid: errors.length === 0,
    errors,
    metrics: {
      reviewerCount: adjudicators.size,
      caseCount: caseIds.length,
      clinicalAcceptabilityAgreement: clinicalAgreement,
      perDimensionExactAgreement: dimAgreement,
    },
  };
}

function parseCli(argv: string[]): { file: string; suiteId?: string; suiteHash?: string } {
  let file = argv[0];
  let suiteId: string | undefined;
  let suiteHash: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--file") {
      file = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--suite-id") {
      suiteId = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--suite-hash") {
      suiteHash = argv[i + 1];
      i += 1;
    }
  }
  if (!file) throw new Error("Usage: npm run laibench:validate-adjudication -- --file private-adjudication.json [--suite-id id] [--suite-hash hash]");
  return { file, suiteId, suiteHash };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseCli(process.argv.slice(2));
  const record = JSON.parse(readFileSync(args.file, "utf8")) as Partial<AdjudicationRecord>;
  const result = validateAdjudicationRecord(record, { suiteId: args.suiteId, suiteHash: args.suiteHash });
  // The JSON result is the machine-consumable payload; emit it verbatim.
  logger.raw(JSON.stringify(result, null, 2));
  if (result.valid) {
    logger.info("adjudication valid", {
      reviewers: result.metrics.reviewerCount,
      cases: result.metrics.caseCount,
      clinicalAgreement: result.metrics.clinicalAcceptabilityAgreement,
      dimAgreement: result.metrics.perDimensionExactAgreement,
    });
  } else {
    logger.error("adjudication invalid", { errors: result.errors.length });
    process.exit(1);
  }
}
