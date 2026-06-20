export type Dim = "CRIT" | "QUAL" | "TERM" | "GUIDE" | "RAG";
export type Severity = "critical" | "major" | "minor";
export type Verdict = "PASS" | "PARTIAL" | "FAIL" | "UNSCORED";
export type LocaleKey = "pt-BR" | "en-US";
export type Modality = "CT" | "MRI" | "US" | "XR" | "MG" | "MX";
export type Region = "head" | "chest" | "abdomen" | "spine" | "urinary" | "pelvis" | "breast" | "thyroid" | "neck" | "unknown";
export type Confidence = "high" | "medium" | "low";
export type TrackId = "mini-agent" | "model" | "agent";
export type EntityType = "company" | "team" | "agent" | "model" | "research";
export type SystemType = "product-agent" | "custom-agent" | "mini-agent" | "raw-model";
export type SuiteVisibility = "public" | "verified" | "private";
export type EvaluationMode = "local" | "cloud-private";
export type ScoreCombinationMode = "conservative-min" | "judge-primary";
export type FindingSeverity = "critical" | "major" | "minor" | "incidental";
export type Laterality = "right" | "left" | "bilateral";
export type CaseDifficulty = "easy" | "medium" | "hard";

export type Check = {
  dim: Dim;
  id: string;
  name: string;
  severity: Severity;
  passed: boolean;
  evidence: string;
};

export type DimSummary = {
  score: number | null;
  pass: number;
  total: number;
  critFails: number;
  verdict: Verdict;
  appliedWeight: number;
};

export type TraceEvent = {
  step: string;
  model?: string;
  metadata?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  ms: number;
  error?: string;
};

export type JudgeFailure = {
  dim: Dim;
  issue: string;
  evidence: string;
};

export type JudgeSpotCheck = {
  claim: string;
  ok: boolean;
  by: string;
};

export type JudgeResult = {
  verdict: Exclude<Verdict, "UNSCORED">;
  scores: Partial<Record<Dim, number>>;
  overall: number | null;
  critical_failures: JudgeFailure[];
  missing: string[];
  hallucinated: string[];
  spot_checks: JudgeSpotCheck[];
  fix: string;
};

export type ExamMeta = {
  modality: Modality;
  contrast: boolean;
  region: Region;
  normalizedExam: string;
  normalizedFindings: string;
  abnormalStudy: boolean;
  expectedTitleTokens: string[];
  expectedRegionTokens: string[];
};

export type PreservationPattern = {
  id: string;
  input: RegExp;
  report: RegExp;
  label: string;
};

// --- Gold data types for rich case schema ---

export type GoldFinding = {
  finding: string;
  location?: string;
  laterality?: Laterality;
  severity: FindingSeverity;
  measurements?: string[];
  negated?: boolean;
};

export type GuidelineExpectation = {
  guidelineId: string; // "fleischner" | "birads" | "tirads" | "lirads" | "pirads" | "bosniak" | "lungrads"
  expectedClassification?: string; // e.g. "BI-RADS 4A"
  recommendationRequired?: boolean;
  expectedRecommendation?: string;
};

export type RetrievalRelevance = {
  documentId: string;
  relevance: number; // 0-3 scale
};

export type PatientContext = {
  sex?: string;
  age?: number;
  indication?: string;
};

export type BenchCase = {
  id: string;
  label?: string;
  synthetic?: boolean;
  exam: string;
  findings: string;
  locale?: LocaleKey;
  tags?: string[];
  /** Schema version for forward-compatible case migration */
  schemaVersion?: string;
  // Rich gold data (optional, backward-compatible)
  goldFindings?: GoldFinding[];
  referenceReport?: string;
  criticalFindings?: string[];
  guidelineExpectations?: GuidelineExpectation[];
  retrievalGold?: RetrievalRelevance[];
  patientContext?: PatientContext;
  difficulty?: CaseDifficulty;
};

export type SuiteManifest = {
  benchmarkName: "laibench" | "laibench-pro";
  benchmarkVersion: string;
  id: string;
  label: string;
  description: string;
  locale: LocaleKey;
  visibility: SuiteVisibility;
  evaluationMode: EvaluationMode;
  casesPath: string | null;
  caseCount: number;
  tags: string[];
  recommendedTrack: TrackId;
  canonicalScaffold: string | null;
  canonicalJudgeModel: string | null;
  notes?: string;
};

export type GenerationInput = {
  exam: string;
  findings: string;
  locale: LocaleKey;
  systemPrompt: string;
};

export type GenerationOutput = {
  html: string;
  raw: string;
  metadata?: Record<string, unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  costUsd?: number;
  model?: string;
};

export type JudgeOutput = {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  costUsd?: number;
  model?: string;
  trace: TraceEvent;
};

export type GeneratorAdapter = {
  name: string;
  scaffoldId?: string | null;
  run(input: GenerationInput): Promise<GenerationOutput>;
};

export type JudgeAdapter = {
  name: string;
  provider: string;
  modelLabel: string;
  run(prompt: string): Promise<JudgeOutput>;
};

export type SubmissionPrediction = {
  instance_id: string;
  model_name_or_path?: string;
  model_output: string;
  metadata?: Record<string, unknown>;
};

export type SubmissionValidation = {
  valid: boolean;
  expectedIds: string[];
  receivedIds: string[];
  missingIds: string[];
  duplicateIds: string[];
  extraIds: string[];
  emptyOutputs: string[];
  errors: string[];
};

export type PublicSubmissionValidation = {
  valid: boolean;
  expectedCount: number;
  receivedCount: number;
  missingCount: number;
  duplicateCount: number;
  extraCount: number;
  emptyOutputCount: number;
  errors: string[];
};

// --- Evaluator result types ---

export type FindingMatch = {
  goldFinding: string;
  severity: FindingSeverity;
  matchType: "exact" | "partial" | "missed";
  matchedText?: string;
};

export type HallucinatedFinding = {
  text: string;
  confidence: Confidence;
};

export type EvaluatorResult = {
  dim: Dim;
  score: number; // 0-100
  checks: Check[];
  details: Record<string, unknown>;
};

export type CaseRunResult = {
  case: BenchCase;
  locale: LocaleKey;
  rawHtml: string;
  normalizedHtml: string;
  sanitizedHtml: string;
  meta: ExamMeta;
  checks: Check[];
  detDims: Record<Dim, DimSummary>;
  detOverall: number;
  judge: JudgeResult | null;
  combined: Record<Dim, number | null>;
  combinedOverall: number;
  /** LAB-style task completion: every scored criterion/check for the case passed. */
  allPass?: boolean;
  criteriaPassed?: number;
  criteriaTotal?: number;
  verdict: Exclude<Verdict, "UNSCORED">;
  confidence: Confidence;
  phaseStatus: "complete" | "degraded";
  gateReasons: string[];
  costUsd: number;
  latencyMs: number;
  trace: TraceEvent[];
};

export type SuiteSummary = {
  /** Compatibility field: strict PASS gate rate. Public surfaces should not label this as image/model accuracy. */
  accuracyRate: number;
  /** LAB-style headline metric: percent of cases where every criterion/check passed. */
  allPassRate?: number;
  allPassCount?: number;
  /** Diagnostic metric: pooled pass rate across all binary criteria/checks. */
  criterionPassRate?: number;
  criteriaPassed?: number;
  criteriaTotal?: number;
  averageOverall: number;
  passRate: number;
  strictPassRate: number;
  averageLatencyMs: number;
  totalCostUsd: number;
  verdictCounts: Record<Exclude<Verdict, "UNSCORED">, number>;
  averagePerDim: Partial<Record<Dim, number>>;
};

export type RunManifest = {
  benchmarkName: "laibench" | "laibench-pro";
  benchmarkVersion: string;
  createdAt: string;
  runName: string;
  suiteId: string;
  suiteLabel: string;
  suiteVisibility: SuiteVisibility;
  suiteHash: string;
  locale: LocaleKey;
  track: TrackId;
  provider: string;
  modelLabel: string;
  entityName: string;
  entityType: EntityType;
  systemType: SystemType;
  comparisonClass: string;
  scaffoldId: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
  scoreMode?: ScoreCombinationMode;
  evaluationMode: EvaluationMode;
  submissionMode: "generator" | "predictions";
  validation: SubmissionValidation;
  comparableKey: string;
  /** Unique per-run canary token for contamination detection */
  canaryToken?: string;
  notes?: string;
};

export type SuiteRunResult = {
  manifest: RunManifest;
  summary: SuiteSummary;
  results: CaseRunResult[];
};

export type DifficultyBreakdown = {
  difficulty: CaseDifficulty;
  caseCount: number;
  allPassRate?: number;
  criterionPassRate?: number;
  averageOverall: number;
  accuracyRate: number;
  passRate: number;
  strictPassRate: number;
};

export type LeaderboardEntry = {
  rank: number | null;
  eligible: boolean;
  runName: string;
  provider: string;
  modelLabel: string;
  entityName: string;
  entityType: EntityType;
  systemType: SystemType;
  comparisonClass: string;
  locale: LocaleKey;
  track: TrackId;
  scaffoldId: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
  allPassRate?: number;
  allPassCount?: number;
  criterionPassRate?: number;
  criteriaPassed?: number;
  criteriaTotal?: number;
  averageOverall: number;
  accuracyRate: number;
  passRate: number;
  strictPassRate: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  averagePerDim: Partial<Record<Dim, number>>;
  sourceFile: string;
  comparableKey: string;
  suiteId: string;
  validation: PublicSubmissionValidation;
  perDifficulty?: DifficultyBreakdown[];
};

export type LeaderboardGroup = {
  comparableKey: string;
  suiteId: string;
  locale: LocaleKey;
  track: TrackId;
  scaffoldId: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
  scoreMode?: ScoreCombinationMode;
  entries: LeaderboardEntry[];
};

export type Leaderboard = {
  createdAt: string;
  benchmarkVersion: string;
  groups: LeaderboardGroup[];
};

export type CompareRow = {
  caseId: string;
  caseLabel: string;
  aOverall: number;
  bOverall: number;
  delta: number;
  aVerdict: Exclude<Verdict, "UNSCORED">;
  bVerdict: Exclude<Verdict, "UNSCORED">;
};
