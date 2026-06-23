#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { logger } from "./log.js";
import { validateAdjudicationRecord, type AdjudicationRecord } from "./adjudication.js";

export type ReleaseMode = "private" | "public";

export type ReleaseFile = {
  path: string;
  content?: string;
};

export type ReleaseIssue = {
  path: string;
  rule: string;
  severity: "error" | "warn";
  message: string;
};

const RAW_DATA_EXT = /\.(?:csv|tsv|xlsx?|parquet|arrow|feather|sqlite3?|db|duckdb|dcm|dicom|nii(?:\.gz)?|mha)$/i;
const PRIVATE_PATH = /(?:^|\/)(?:data\/(?:raw|private|gated|hidden|official|source|corpus)|private-data|corpus|cases\/(?:private|hidden|gated|official))(?:\/|$)/i;
// Generic private-corpus filename heuristics (cleaned-text dumps, HF shard
// exports, merged CSVs). Kept brand/size-agnostic on purpose so the public guard
// does not name any specific private dataset while still blocking the shapes.
const PRIVATE_NAME = /(?:clean[_-]?\d+k|train-00000-of-|test-00000-of-|merged.*\.csv)/i;
const SECRET_PATTERN = /\b(?:sk_live|sk-lf|ghp|gho|supabase_service_role)_[A-Za-z0-9_-]{12,}\b/;
const CALENDAR_DATE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/;
const PUBLIC_DERIVED_MARKER = /(?:Merged CSV fixture|MERGED-PTBR-|public-merged-csv|merged-csv|CSV mesclado)/i;
const PUBLIC_ANSWER_KEY = /"(?:goldFindings|criticalFindings|referenceReport|guidelineExpectations|retrievalGold)"\s*:/;

// Public artifacts whose prose must not assert clinical validation / independent
// review of scored or public cases unless a signed adjudication record backs it.
// Matches site/data.js, any leaderboard markdown (the rendered public board), and
// the root data-access policy (a public claim document about the controlled suite).
const PUBLIC_CLAIM_ARTIFACT = /^(?:site\/data\.js|leaderboard\/(?:.*\/)?[^/]+\.md|DATA_ACCESS_POLICY\.md)$/i;

// Affirmative clinical-validation / independent-review claims about the scored or
// public cases. These are the strings that require a backing adjudication record.
const CLINICAL_VALIDATION_CLAIM =
  /\b(?:clinically reviewed|clinically validated|clinical validation|radiologist[- ]adjudicated|independent (?:third[- ]party )?(?:validation|adjudication|review)|third[- ]party (?:validation|adjudication|review)|externally validated|independently validated|clinicamente (?:validad|revisad)\w*|valida[çc][ãa]o cl[íi]nica|adjudicad\w* por radiologista|validad\w* (?:de forma )?independente|valida[çc][ãa]o (?:independente|de terceiros)|revis[ãa]o (?:independente|de terceiros)|validad\w* externamente)\b/i;

// Negation / scoping qualifiers that turn a CLINICAL_VALIDATION_CLAIM match into an
// honest, non-overclaiming statement (e.g. "not clinically reviewed", "must not be
// used to claim clinical validation", "this is not an independent third-party
// validation", "internal data-quality process ... not third-party"). When any of
// these appear in the SAME sentence as the claim, the sentence is not an assertion
// of validation and is therefore safe.
const CLINICAL_CLAIM_NEGATION =
  /\b(?:not|never|no|without|tracked as future work|future work|must not|cannot|is not|are not|were not|was not|internal data[- ]quality|not an? independent|not a? third[- ]party|n[ãa]o|nem|sem|processo interno de qualidade|qualidade interna|trabalho futuro)\b/i;

function splitSentences(text: string): string[] {
  // Split on sentence boundaries (period/semicolon/newline). Crude but sufficient:
  // a claim and its qualifier ("...; this is not an independent...") are kept apart
  // ONLY when separated by a boundary, so qualifiers must sit in the claim's clause.
  return text.split(/(?<=[.;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// True when the artifact prose makes an UNSUBSTANTIATED affirmative claim that the
// scored/public cases were clinically validated or independently reviewed. Honest,
// negated, or internal-data-quality-scoped statements are not flagged.
function assertsClinicalValidation(content: string): boolean {
  for (const sentence of splitSentences(content)) {
    CLINICAL_VALIDATION_CLAIM.lastIndex = 0;
    const claim = CLINICAL_VALIDATION_CLAIM.exec(sentence);
    if (!claim) continue;
    // A qualifier neutralizes the claim only when it sits in the SAME CLAUSE, before
    // the claim phrase. The sentence splitter only breaks on .;\n, so a comma- or
    // conjunction-joined leading negation in an UNRELATED clause ("We do not
    // overclaim, and every scored case was clinically validated ...") must not
    // shelter the affirmative claim. Re-split on commas and coordinating
    // conjunctions and inspect only the clause that contains the claim.
    const claimGlobalIdx = claim.index;
    // Find clause boundaries (commas + coordinating conjunctions) within the sentence.
    // NB: bare PT "e" (and) is deliberately EXCLUDED — after accent folding it is
    // indistinguishable from "é" (is), so including it would split "não é uma
    // validação" and strip the "não" from the claim's clause (false positive on an
    // honest negated PT statement). Comma-joined PT evasions are still caught by the
    // comma boundary; "mas"/"porém"/etc. cover PT contrast.
    const clauseBoundary = /,|\b(?:and|but|yet|while|whereas|however|though|although|mas|porem|porém|contudo|entretanto|todavia)\b/gi;
    let clauseStart = 0;
    let m: RegExpExecArray | null;
    clauseBoundary.lastIndex = 0;
    while ((m = clauseBoundary.exec(sentence)) !== null) {
      if (m.index + m[0].length <= claimGlobalIdx) clauseStart = m.index + m[0].length;
      else break;
      if (clauseBoundary.lastIndex === m.index) clauseBoundary.lastIndex++;
    }
    const beforeClaimInClause = sentence.slice(clauseStart, claimGlobalIdx);
    if (CLINICAL_CLAIM_NEGATION.test(beforeClaimInClause)) continue;
    return true;
  }
  return false;
}

// Pull every 64-hex suiteHash referenced by public artifacts so the adjudication
// record (if any) can be checked against the suite that is actually published.
function extractSuiteHashes(files: ReleaseFile[]): Set<string> {
  const hashes = new Set<string>();
  for (const file of files) {
    const path = normPath(file.path);
    if (!PUBLIC_CLAIM_ARTIFACT.test(path)) continue;
    const content = file.content ?? "";
    for (const match of content.matchAll(/"suiteHash"\s*:\s*"([0-9a-f]{16,})"/gi)) {
      hashes.add(match[1]);
    }
  }
  return hashes;
}

// Locate a signed adjudication record in the tracked file set and validate it
// against the published suiteHash(es). Returns true only when at least one record
// passes validateAdjudicationRecord for a published suiteHash.
function hasValidAdjudicationFor(files: ReleaseFile[], suiteHashes: Set<string>): boolean {
  for (const file of files) {
    const path = normPath(file.path);
    if (!/adjudication.*\.json$/i.test(path)) continue;
    const content = file.content;
    if (!content) continue;
    let record: Partial<AdjudicationRecord>;
    try {
      record = JSON.parse(content) as Partial<AdjudicationRecord>;
    } catch {
      continue;
    }
    if (suiteHashes.size === 0) {
      if (validateAdjudicationRecord(record).valid) return true;
      continue;
    }
    for (const suiteHash of suiteHashes) {
      if (validateAdjudicationRecord(record, { suiteHash }).valid) return true;
    }
  }
  return false;
}

function isCaseLevelArtifact(path: string): boolean {
  return /^(?:cases\/|leaderboard\/(?:artifacts|frozen)\/|runs\/)/.test(path)
    && /\.(?:json|jsonl|csv|tsv)$/i.test(path);
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function auditReleaseFiles(files: ReleaseFile[], mode: ReleaseMode): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];

  for (const file of files) {
    const path = normPath(file.path);
    const content = file.content ?? "";

    if (RAW_DATA_EXT.test(path)) {
      issues.push({
        path,
        rule: "raw-data-extension",
        severity: "error",
        message: "Raw tabular/imaging data files must not be tracked in this repository.",
      });
    }

    if (PRIVATE_PATH.test(path)) {
      issues.push({
        path,
        rule: mode === "public" ? "private-path-public-release" : "private-path-tracked",
        severity: mode === "public" ? "error" : "warn",
        message: mode === "public"
          ? "Private/gated data paths cannot be present in a public release."
          : "Private/gated data path is tracked; this is allowed only while the repository remains private.",
      });
    }

    if (PRIVATE_NAME.test(path)) {
      issues.push({
        path,
        rule: "private-corpus-name",
        severity: "error",
        message: "Filename matches private corpus or merged-export naming patterns.",
      });
    }

    if (SECRET_PATTERN.test(content)) {
      issues.push({
        path,
        rule: "secret-pattern",
        severity: "error",
        message: "Potential live credential found in tracked content.",
      });
    }

    if (mode === "public") {
      if (isCaseLevelArtifact(path) && PUBLIC_DERIVED_MARKER.test(content)) {
        issues.push({
          path,
          rule: "public-derived-marker",
          severity: "error",
          message: "Merged-CSV/private-derived fixture marker found in a public-release scan.",
        });
      }
      // Answer keys (goldFindings/criticalFindings/referenceReport/...) must not
      // appear in public case files OR in any rendered public claim artifact
      // (site/data.js, leaderboard markdown). Previously scoped to cases/public/
      // only, so an answer key embedded in site/data.js was caught by a test but
      // not by the deploy-gating guard.
      if ((/^cases\/public\//.test(path) || PUBLIC_CLAIM_ARTIFACT.test(path)) && PUBLIC_ANSWER_KEY.test(content)) {
        issues.push({
          path,
          rule: "public-answer-key",
          severity: "error",
          message: "Public case files and claim artifacts must not expose answer keys or reference reports.",
        });
      }
      if (/^(cases|leaderboard|site)\//.test(path) && CALENDAR_DATE.test(content)) {
        issues.push({
          path,
          rule: "calendar-date-public-artifact",
          severity: "error",
          message: "Calendar dates in public artifacts can enable linkage and require manual review/redaction.",
        });
      }
    }
  }

  if (mode === "public") {
    // Adjudication-claim gate: a public artifact (site/data.js, leaderboard
    // markdown) must not assert that the scored/public cases were clinically
    // validated or independently reviewed unless a signed adjudication record
    // (validateAdjudicationRecord) passes for the published suiteHash. An honest,
    // internal-data-quality-scoped, non-third-party statement is NOT a claim and
    // is left untouched, so this exits clean on a truthful disclosure.
    const claimingArtifacts = files.filter((file) => {
      const path = normPath(file.path);
      return PUBLIC_CLAIM_ARTIFACT.test(path) && assertsClinicalValidation(file.content ?? "");
    });
    if (claimingArtifacts.length > 0) {
      const suiteHashes = extractSuiteHashes(files);
      const substantiated = hasValidAdjudicationFor(files, suiteHashes);
      if (!substantiated) {
        for (const file of claimingArtifacts) {
          issues.push({
            path: normPath(file.path),
            rule: "unsubstantiated-clinical-validation-claim",
            severity: "error",
            message: "Public artifact asserts clinical validation / independent review of scored or public cases, but no signed adjudication record (validateAdjudicationRecord) backs the published suiteHash.",
          });
        }
      }
    }
  }

  return issues;
}

function listFilesystemFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "runs" || entry.name === "predictions") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesystemFiles(root, abs));
    else if (entry.isFile()) files.push(relative(root, abs));
  }
  return files;
}

function listTrackedFiles(root: string): string[] {
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split(/\n+/);
  return listFilesystemFiles(root);
}

function loadReleaseFiles(root: string): ReleaseFile[] {
  return listTrackedFiles(root).map((path) => {
    const abs = resolve(root, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { path };
    const size = statSync(abs).size;
    if (size > 2_000_000 || /\.(?:pdf|zip|png|jpg|jpeg|gif|webp|mp4|mov)$/i.test(path)) return { path };
    return { path, content: readFileSync(abs, "utf8") };
  });
}

function parseCli(argv: string[]): { root: string; mode: ReleaseMode } {
  let root = process.cwd();
  let mode: ReleaseMode = "private";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      root = resolve(argv[i + 1] ?? root);
      i += 1;
    } else if (argv[i] === "--mode") {
      const raw = argv[i + 1];
      if (raw !== "private" && raw !== "public") throw new Error(`Invalid --mode: ${raw}`);
      mode = raw;
      i += 1;
    }
  }
  return { root, mode };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { root, mode } = parseCli(process.argv.slice(2));
  const issues = auditReleaseFiles(loadReleaseFiles(root), mode);
  const blocking = issues.filter((issue) => issue.severity === "error");
  for (const issue of issues) {
    const emit = issue.severity === "error" ? logger.error : logger.warn;
    emit("release-guard issue", { path: issue.path, rule: issue.rule, msg: issue.message });
  }
  if (blocking.length > 0) {
    logger.error("release-guard blocked", { mode, blocking: blocking.length });
    process.exit(1);
  }
  logger.info("release-guard ok", { mode, warnings: issues.length });
}
