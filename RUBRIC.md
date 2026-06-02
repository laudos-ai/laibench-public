# LAIBench Scoring Rubric

This rubric defines, in human-auditable terms, how LAIBench scores a model's
radiology report against a locked case. It is the companion to the code that
actually computes scores:

- Deterministic, content-aware checks: [`src/evaluators/`](src/evaluators/)
  (`crit.ts`, `qual.ts`, `guide.ts`, `rag.ts`, and the structural/terminology
  layer in `structural.ts`).
- Locale-specific terminology, forbidden openers, modality vocabulary, and judge
  instructions: [`src/locales/`](src/locales/) (`pt-BR.ts`, `en-US.ts`).
- Optional adversarial LLM judge: [`src/judge.ts`](src/judge.ts).
- Score aggregation, dimension caps, and gate logic:
  [`src/scoring.ts`](src/scoring.ts).

Adjudicating radiologists may use the 0-5 tables below directly when reviewing
outputs; the per-dimension and Strict PASS machinery downstream is derived from
the same definitions. The end-to-end flow (evaluator order, judge combination
modes, and verdict thresholds) is specified in
[`EVALUATION_PROTOCOL.md`](EVALUATION_PROTOCOL.md), and the methodology of record
for the public leaderboard is
[`docs/laibench-leaderboard-methods.md`](docs/laibench-leaderboard-methods.md).

> All examples in this document are synthetic. They are not derived from patient
> data. The only clinical-style cases shipped in this repository are the
> synthetic demo cases referenced by the public lite suites
> ([`suites/lite-public.pt-BR.json`](suites/lite-public.pt-BR.json),
> [`suites/lite-public.en-US.json`](suites/lite-public.en-US.json)). The full
> clinical corpus, difficulty splits, hidden test set, and private scoring assets
> are gated and are **not** in this repository — see
> [`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md).

---

## Scope and conflict-of-interest note

LAIBench is maintained by Laudos.AI, a commercial radiology-reporting vendor.
This rubric is published so that scores can be independently audited and
reproduced. LAIBench is a benchmark framework, not a medical device, not
clinical validation, and not regulatory approval. See
[`LIMITATIONS.md`](LIMITATIONS.md) and
[`GOVERNANCE_AND_PRIVACY.md`](GOVERNANCE_AND_PRIVACY.md).

---

## Dimensions and weights

| Dimension | Weight | What it measures |
| --------- | -----: | ---------------- |
| **CRIT** — Critical finding preservation | 30% | Every declared critical finding is reported, correctly lateralised, not negated, in the right section. |
| **QUAL** — Clinical quality | 25% | Gold findings preserved with correct severity; no hallucinated findings; pertinent negatives where required. |
| **TERM** — Terminology correctness | 20% | Modality- and locale-appropriate vocabulary; valid classification grades; no forbidden openers/terms. |
| **GUIDE** — Guideline adherence | 15% | Applicable guideline applied, valid classification value, correct recommendation tied to the guideline. |
| **RAG** — Retrieval fidelity | 10% | (Retrieval-enabled systems only) Evidence IDs valid, laterality/levels/measurements/order preserved. |

These weights are the canonical defaults declared in `WEIGHTS` in
[`src/scoring.ts`](src/scoring.ts). A dimension with no applicable checks is
marked `UNSCORED` and its weight is redistributed proportionally across the
scored dimensions, so the weighted overall always sums over the dimensions that
actually applied to the case. RAG is `UNSCORED` for systems that do not perform
retrieval.

---

## Per-dimension 0-5 levels (adjudication-facing)

When a radiologist adjudicates, each dimension is scored on this shared 0-5
scale. The same severities drive the deterministic checks (`minor` / `major` /
`critical`) and the judge.

| Score | Meaning |
| ----: | ------- |
| 5 | Indistinguishable from a board-certified radiologist's compliant report on this dimension. |
| 4 | Minor issue, no clinical impact. |
| 3 | Major issue, no immediate safety impact. |
| 2 | Major issue with patient-management impact. |
| 1 | Critical issue — case fails this dimension. |
| 0 | Severe critical issue — case fails the entire run on this dimension. |

A score of `1` or `0` on **CRIT** is a *critical fail*: it caps the case overall
and forces a `FAIL` verdict (see "How Strict PASS is derived" below).

### Error definitions

- **Critical error** — a missed critical finding; negation of a
  critical-positive finding; laterality flip on a lateralised finding; inversion
  of a classification-system value (e.g. BI-RADS 5 reported as BI-RADS 2); or a
  fabricated measurement that changes management.
- **Major error** — a missing pertinent positive or pertinent negative that is
  not classified as critical; a forbidden term or forbidden opener; a misapplied
  guideline; a structural break.
- **Minor error** — a stylistic or formatting deviation that does not change
  clinical meaning; a synonym variant within the same canonical group.
- **Omission** — the output does not mention something present in the case input.
- **Hallucination** — the output mentions something not supported by the case
  input.
- **Acceptable style variation** — different ordering of optional sections,
  paraphrase within a canonical synonym group, or locale-specific phrasing where
  the locale rules ([`src/locales/`](src/locales/)) allow it.

---

## CRIT — Critical finding preservation (30%)

Implemented in [`src/evaluators/crit.ts`](src/evaluators/crit.ts). When the case
declares `criticalFindings` gold labels, the evaluator computes recall,
precision, and F1 against detected mentions (negation-aware) and emits a separate
critical check for each missed finding.

| Score | Behaviour |
| ----: | --------- |
| 5 | All declared critical findings reported, lateralised correctly, with correct measurements, in the correct section. |
| 4 | All critical findings present and correct; one minor stylistic deviation in phrasing. |
| 3 | One major error not affecting safety (e.g. measurement rounded but unit-correct, severity adjective softened but still flagged). |
| 2 | Major error with management impact (e.g. critical finding present only in FINDINGS, not in IMPRESSION). |
| 1 | Critical error: a declared critical finding is missing, negated, or laterality-flipped. |
| 0 | Multiple critical errors, or an explicit "no critical findings" statement when one is declared. |

Synthetic examples:

- **Score 5** — Case declares `criticalFindings: ["pulmonary embolism (segmental,
  right)"]`. Report states "Embolia pulmonar segmentar à direita" in IMPRESSION
  and again in FINDINGS, with the segmental level preserved.
- **Score 1** — Same input; report states "Sem evidência de embolia pulmonar"
  (negation of a declared critical-positive finding).
- **Score 0** — Same input; report states "Sem achados críticos" (explicit
  denial).

---

## QUAL — Clinical quality (25%)

Implemented in [`src/evaluators/qual.ts`](src/evaluators/qual.ts). With
`goldFindings` present, the evaluator performs severity-aware finding matching
(exact / partial / missed / hallucinated) using canonical synonym groups so that
clinically equivalent phrasings are not penalised.

| Score | Behaviour |
| ----: | --------- |
| 5 | Every gold finding represented with correct severity and modality vocabulary; no hallucinations; pertinent negatives present where the case context requires them. |
| 4 | All gold findings present; minor severity-adjective swap within the same canonical synonym group. |
| 3 | One pertinent positive or pertinent negative missing without safety impact, OR one mild hallucination not in input. |
| 2 | Two or more pertinent positives missing, OR one hallucination with management impact. |
| 1 | Multiple hallucinations or systematic severity inflation. |
| 0 | Report fabricates findings that materially change clinical management. |

Synthetic examples:

- **Score 5** — Gold: "nódulo pulmonar 6 mm lobo superior direito". Report:
  "Nódulo pulmonar de 6 mm no lobo superior direito; recomenda-se seguimento
  conforme Fleischner." Same severity, same modality vocabulary, consistent
  recommendation.
- **Score 3** — Same gold; report: "Nódulo pulmonar de 7 mm no lobo superior
  direito" (measurement off, within reported rounding tolerance).
- **Score 0** — Same gold; report: "Massa pulmonar de 6 cm" (severity inflation
  plus size fabrication).

---

## TERM — Terminology correctness (20%)

Driven by the locale specifications in [`src/locales/`](src/locales/)
(`forbiddenTerms`, `forbiddenOpeners`, `modalityVocab`, classification-name
checks) and applied in the structural/terminology layer
[`src/evaluators/structural.ts`](src/evaluators/structural.ts). Classification
names and grades are validated against the per-system valid-value sets used by
the guideline engine (e.g. BI-RADS, TI-RADS, PI-RADS, LI-RADS, Bosniak,
Lung-RADS).

| Score | Behaviour |
| ----: | --------- |
| 5 | Modality-appropriate vocabulary; classification systems used with a valid grade and exact name; no forbidden opener. |
| 4 | One minor stylistic deviation (e.g. an acceptable abbreviation expanded, or a locale-appropriate alternative). |
| 3 | One non-critical term outside the canonical vocabulary, but the synonym group is recognised. |
| 2 | Forbidden opener, forbidden term, or modality-mismatched vocabulary in a non-critical section. |
| 1 | Classification-system error (wrong grade or wrong name) on a non-critical case. |
| 0 | Classification system inverted on a safety-critical case (e.g. BI-RADS 5 reported as BI-RADS 2). |

Synthetic examples:

- **Score 5** — Mammography case; report uses "BI-RADS 4B" with an
  ACR-consistent category description and a locale-compliant opener.
- **Score 2** — Mammography case; report opens with an opener listed in
  `forbiddenOpeners` for the pt-BR locale.
- **Score 0** — Gold finding is clearly BI-RADS 5; report writes "BI-RADS 2".

---

## GUIDE — Guideline adherence (15%)

Implemented in [`src/evaluators/guide.ts`](src/evaluators/guide.ts) via a modular
guideline engine (applicability → presence → correctness). When the case carries
`guidelineExpectations` gold, the report is validated against the expected
classification value and recommendation; otherwise the engine detects the
applicable system from context and falls back to anatomy-coverage checks.

| Score | Behaviour |
| ----: | --------- |
| 5 | All applicable guidelines applied; classification value within valid range; recommendation present and correctly tied to the guideline. |
| 4 | Guideline applied with one minor phrasing deviation. |
| 3 | Guideline applied but recommendation phrasing differs from canonical text without changing the management action. |
| 2 | Guideline applied but recommendation omits a sub-step (e.g. follow-up interval not stated). |
| 1 | Wrong guideline applied (e.g. Fleischner where Lung-RADS is the canonical system for the case). |
| 0 | Guideline applied with an inverted recommendation that changes the management action. |

Synthetic examples:

- **Score 5** — Pulmonary-nodule case classified per Fleischner with the correct
  interval recommendation tied to size and risk.
- **Score 1** — Same case; report uses Lung-RADS framing on a non-screening
  study.
- **Score 0** — Same case; report recommends "no follow-up" for a 14 mm solid
  nodule.

---

## RAG — Retrieval fidelity (10%)

Applicable only to retrieval-enabled systems; otherwise `UNSCORED`. Implemented
in [`src/evaluators/rag.ts`](src/evaluators/rag.ts), which computes
Precision@k, Recall@k, MRR, and nDCG against `retrievalGold` and checks that
evidence IDs, laterality, levels, and measurements are preserved into the report.

| Score | Behaviour |
| ----: | --------- |
| 5 | All cited evidence IDs valid and present in the retrieval space, ordered consistently with use, with correct laterality and measurements. |
| 4 | All evidence IDs valid; one minor ordering deviation. |
| 3 | One evidence ID missing where the case requires retrieval, but no clinical impact. |
| 2 | Multiple missing evidence IDs, OR a single laterality swap between retrieval and report. |
| 1 | Hallucinated evidence ID, OR a measurement preserved from retrieval but inverted in the report. |
| 0 | Systematic fabrication of retrieval IDs or evidence not present in the retrieval space. |

Synthetic examples:

- **Score 5** — System retrieves three findings, references them in order, with
  measurements and laterality matching.
- **Score 1** — System cites `evidence-id-7`, which does not exist in the
  retrieval index for this case.

---

## Deterministic vs. judge components

Each dimension can be scored two ways. Both produce a 0-100 dimension score, and
both are combined in [`src/scoring.ts`](src/scoring.ts):

1. **Deterministic checks (always run).** The evaluators in
   [`src/evaluators/`](src/evaluators/) emit individual `Check` records with a
   `severity` of `minor`, `major`, or `critical`. Dimension scores are derived
   from pass/total ratios with severity-aware caps: any `critical` check failure
   caps the dimension score (and triggers the gate), and three or more `major`
   failures cap the dimension at 70. These checks are fully reproducible and do
   not depend on any model.

2. **Adversarial judge (optional, frozen).** When enabled,
   [`src/judge.ts`](src/judge.ts) builds a locale-specific prompt (using
   `judgeInstructions` from [`src/locales/`](src/locales/)), supplies the gold
   context, and parses a strict JSON verdict with per-dimension 0-100 scores plus
   explicit `critical_failures`, `missing`, and `hallucinated` lists. The judge
   model and configuration are pinned for a run so judging is repeatable; the
   hidden production judge configuration is not part of this repository.

**How they combine.** `combineScores` in [`src/scoring.ts`](src/scoring.ts)
merges the two per declared scoring mode:

- `conservative-min` — the combined dimension score is `min(deterministic,
  judge)`. This is the calibration/regression default and never lets the judge
  inflate a deterministic result.
- `judge-primary` — the pinned judge provides the primary 0-100 report-quality
  score, while the deterministic critical checks still act as hard gates.

In both modes the deterministic critical checks are gates: a deterministic
critical failure (or a judge-reported critical failure) forces a `FAIL` verdict
regardless of the weighted score. When the judge phase is unavailable, the run is
marked `degraded` and the deterministic scores stand on their own with reduced
confidence.

---

## How Strict PASS is derived

The **primary public ranking metric is the Strict PASS rate**: the fraction of
cases that pass, where a case passes only if **every clinically decisive gate
holds**. Per-dimension 0-100 scores are diagnostic — they explain *why* a case
passed or failed — but they are not the ranking metric.

A case earns `PASS` only when **all** of the following hold (see
`combineScores` in [`src/scoring.ts`](src/scoring.ts)):

1. **No critical failure.** No deterministic `critical` check failed, and (when
   judging is enabled) the judge reported no `critical_failures`. Any critical
   failure forces `FAIL` outright.
2. **Weighted overall meets the pass threshold.** The weight-normalised
   combination of the scored dimensions is at or above the configured
   `passThreshold` (default `84`). Between the partial and pass thresholds the
   case is `PARTIAL`; below the partial threshold (default `60`) it is `FAIL`.

The headline leaderboard number is the proportion of cases with a `PASS` verdict
under these gates, reported with a **bootstrap 95% confidence interval**.
Per-dimension means, the non-fail rate, and the failure taxonomy are reported
alongside it as diagnostics, never as the rank. Superiority between two systems
is only claimed under paired testing on the same suite hash. The leaderboard
tooling recomputes case overalls, verdict counts, and suite hashes from raw run
artifacts before publishing, so manually edited summary fields cannot inflate a
result.

For the full verdict pipeline and reporting requirements, see
[`EVALUATION_PROTOCOL.md`](EVALUATION_PROTOCOL.md) and
[`docs/laibench-leaderboard-methods.md`](docs/laibench-leaderboard-methods.md).

---

## Adjudication

When a deterministic check and the judge disagree by more than one rubric level,
a board-certified radiologist adjudicates and their score becomes the reference.
The procedure:

1. The adjudicator reads the locked case, ignoring any model output.
2. The adjudicator writes their own "ideal" report.
3. The adjudicator reads the model output and scores each dimension 0-5 using the
   tables above.
4. The adjudicator labels every error as critical / major / minor / acceptable.
5. The adjudicator records a free-text comment whenever a dimension scores 0 or 1.

The full procedure — including how cases are locked, how comments are recorded,
and how ties are resolved — is in
[`docs/radiologist-adjudication-protocol.md`](docs/radiologist-adjudication-protocol.md).

**Status of human validation.** Published human inter-rater reliability for
LAIBench labels has **not yet been released**, and judge-versus-radiologist
calibration is ongoing. Gold findings in the current public methodology are
heuristically derived rather than fully radiologist-adjudicated. Treat
per-dimension scores accordingly and consult
[`LIMITATIONS.md`](LIMITATIONS.md) before drawing strong clinical conclusions.

---

## Auditing a score

To reproduce and audit any score:

- The dimensions, weights, severity caps, and gate/threshold logic are in
  [`src/scoring.ts`](src/scoring.ts).
- The content-aware checks per dimension are in
  [`src/evaluators/`](src/evaluators/), and the terminology/structural layer
  (TERM and structure) is in
  [`src/evaluators/structural.ts`](src/evaluators/structural.ts).
- Locale rules (forbidden openers/terms, modality vocabulary, classification
  names, judge instructions) are in [`src/locales/`](src/locales/).
- The judge prompt and JSON contract are in [`src/judge.ts`](src/judge.ts).
- Score, submission, and case shapes are defined in
  [`schemas/score.schema.json`](schemas/score.schema.json),
  [`schemas/submission.schema.json`](schemas/submission.schema.json), and
  [`schemas/case.schema.json`](schemas/case.schema.json).

Questions, suspected scoring bugs, or adjudication disputes:
[oi@laudos.ai](mailto:oi@laudos.ai). See also
[`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/public-submissions.md`](docs/public-submissions.md).
