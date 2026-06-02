# Benchmark Card

| Field          | Value                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Name           | LAIBench                                                                                                        |
| Version        | 2.0.0 (see [`package.json`](package.json) and the public suite manifests)                                      |
| Maintainer     | Laudos.AI — a commercial radiology-reporting vendor (see conflict-of-interest disclosure below)                |
| Repository     | <https://github.com/laudos-ai/laibench-public>                                                                 |
| Public website | <https://laibench.laudos.ai>                                                                                    |
| License        | Proprietary Source-Available — all rights reserved (code, schemas, and case JSON) + a separate Trademark Policy. See [`LICENSE`](LICENSE), [`LICENSE_POLICY.md`](LICENSE_POLICY.md), [`TRADEMARK.md`](TRADEMARK.md). |
| DOI            | Not yet minted.                                                                                                 |
| Citation       | See [`CITATION.cff`](CITATION.cff).                                                                             |

> **Scope of this repository.** This is the public-safe export of LAIBench. It ships
> the framework, schemas, documentation, and a tiny set of **synthetic demo cases**
> only. The full clinical corpus, difficulty splits, hidden test set, answer keys, and
> private scoring criteria are **not** in this repository; they are private/gated under
> controlled access. See [`DATASET_CARD.md`](DATASET_CARD.md) and
> [`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md).

## Objective

LAIBench measures whether a complete reporting system can convert a locked clinical
input (an exam descriptor plus concise findings) into a faithful radiology report.
It is a system-level evaluation, not a single-model probe.

## Clinical scope

- Radiology report generation only. LAIBench does not evaluate image classification,
  detection, segmentation, triage prioritisation, or any task that takes pixel data
  as input.
- Modalities referenced across cases (per case `tags`) include computed tomography
  (CT), magnetic resonance (MR), radiography (XR), ultrasonography (US), and
  mammography. The synthetic demo cases that ship in this repository cover only a
  small subset; exact coverage of the public export is documented in
  [`DATASET_CARD.md`](DATASET_CARD.md).
- Languages: Brazilian Portuguese (pt-BR, primary) and American English (en-US,
  cross-locale validation).

## Tasks evaluated

1. Finding-to-report generation: produce a structured radiology report given the exam
   descriptor and findings.
2. Critical-finding preservation: do not silently drop, negate, or invert clinically
   decisive findings.
3. Terminology and structural compliance: keep modality-appropriate vocabulary,
   classification systems, and report structure.
4. Hallucination control: do not introduce findings, measurements, or recommendations
   absent from the locked input.
5. Auditability: produce output that supports downstream traceability of model
   identity, suite, and scoring configuration.

## Target audience

- Vendors of radiology reporting systems running pre-deployment evaluation.
- Hospital procurement and clinical engineering teams requesting a reproducible
  benchmark in vendor RFPs.
- Researchers publishing on radiology report generation or LLM-as-judge evaluation in
  clinical text.
- Maintainers of multilingual radiology evaluation harnesses.

LAIBench is not built for end-users or patients and does not certify clinical use.

## Unit of evaluation

A _case_: an exam descriptor plus a set of concise findings plus optional public-safe
expectations (`criticalFindings`, `goldFindings`, `guidelineExpectations`,
`patientContext`).

## Expected input

- A locked JSON case object conforming to [`schemas/case.schema.json`](schemas/case.schema.json).
- No image pixels.
- No clinical history beyond what is present in the case object.

## Expected output

- A radiology report in the allowed report subset declared in
  [`EVALUATION_PROTOCOL.md`](EVALUATION_PROTOCOL.md).
- The output must satisfy the prediction-record contract
  ([`schemas/prediction-record.schema.json`](schemas/prediction-record.schema.json)).

## Metrics

Per-case scores are reported across five dimensions. These dimensions are diagnostic;
they are **not** the ranking metric.

| Dimension | Weight (clinical mix) | Purpose                                                                            |
| --------- | --------------------- | --------------------------------------------------------------------------------- |
| CRIT      | 30%                   | Critical-finding preservation, unsafe negation, laterality, measurement integrity |
| QUAL      | 25%                   | Clinical quality, severity-aware matching, hallucination resistance               |
| TERM      | 20%                   | Locale-specific terminology, modality vocabulary, classification systems          |
| GUIDE     | 15%                   | Guideline applicability and recommendation correctness                            |
| RAG       | 10%                   | Evidence fidelity, order, laterality, levels, measurements                        |

**Primary public ranking metric: Strict PASS rate.** A case passes only when every
clinically decisive gate holds (no missed critical finding, no laterality flip, no
unsafe negation, no structural break, no terminology violation). Per-dimension scores
explain failures but are not aggregated into the ranking.

Supporting statistics reported alongside Strict PASS:

- Bootstrap 95% confidence interval on the Strict PASS rate.
- Per-dimension mean scores (deterministic and judge components).
- Verdict distribution (PASS / PARTIAL / FAIL).
- Failure-taxonomy counts.
- Run provenance hash (case → suite → scoring → run).

The full scoring procedure, gate semantics, and reproducibility requirements are
specified in [`EVALUATION_PROTOCOL.md`](EVALUATION_PROTOCOL.md). The methodology of
record is [`docs/laibench-leaderboard-methods.md`](docs/laibench-leaderboard-methods.md).

## Rubric

See [`RUBRIC.md`](RUBRIC.md) for the dimension definitions and gate criteria.

## Limitations

See [`LIMITATIONS.md`](LIMITATIONS.md). The dominant limitations include:

- No published human inter-rater reliability for the rubric yet.
- The synthetic demo cases in this repository are illustrative only; they are not a
  representative clinical dataset and must not be used to claim clinical validation.
- Geographic and modality coverage of the gated corpus is not exhaustive.
- Canary tokens and a hash chain mitigate data contamination and tampering but do not
  detect every adversarial attack.

## Known risks

- **Vendor self-evaluation risk.** The maintainer (Laudos.AI) is a commercial
  radiology reporting vendor. See [`GOVERNANCE_AND_PRIVACY.md`](GOVERNANCE_AND_PRIVACY.md)
  for the conflict-of-interest disclosure and the rules that mitigate it.
- **Leaderboard gaming risk.** The harness uses canary tokens, score recomputation
  before publication, and grouped-leaderboard keys that prevent mixing incompatible
  runs.

## Recommended use

- Pre-deployment evaluation of report-generation systems and agents.
- Comparative evaluation across model versions of the same system.
- A reproducible CI gate for model upgrades.
- A source of failure-mode counts for prioritising clinical engineering work.

## Use that is not recommended

- Selection of clinical care for individual patients. LAIBench scores are not clinical
  evidence.
- Marketing claims that LAIBench scores certify safety, efficacy, or clinical approval.
- Single-model performance claims framed as substitutes for radiologists.

## Required human supervision

Use of LAIBench inside a clinical organisation requires:

- Board-certified radiologist oversight on every case in the pre-deployment review.
- A documented governance process for which models are eligible for which workflows.
- Documented limits on agent autonomy (no autonomous report signing).

## How to interpret scores

- A higher Strict PASS rate is better, ranked within a comparable group only.
- Per-dimension scores are diagnostic. They explain why a case failed; they do not
  certify clinical quality.
- A high overall score with a single low CRIT score is a regression signal, not a
  safe-deployment signal.

## Official evaluation vs. this repository

The public suites in this repository
([`suites/lite-public.pt-BR.json`](suites/lite-public.pt-BR.json),
[`suites/lite-public.en-US.json`](suites/lite-public.en-US.json)) run on the synthetic
demo cases and are intended for installation checks, smoke tests, and harness review.
Official LAIBench evaluation uses a larger, gated clinical dataset under controlled
access; that dataset is **not** part of this repository. See
[`DATASET_CARD.md`](DATASET_CARD.md) and [`DATA_ACCESS_POLICY.md`](DATA_ACCESS_POLICY.md).

## Versioning

LAIBench follows SemVer:

- **Major (`X.0.0`):** breaking changes to the rubric, case schema, or scoring
  semantics. Existing runs become incomparable.
- **Minor (`x.Y.0`):** additive changes (new suites, additional metrics, additional
  evaluators).
- **Patch (`x.y.Z`):** documentation and bug fixes that do not change scores.

Suite hashes are computed deterministically; the same suite ID at the same hash is the
same data. Two runs only compare if `(benchmarkVersion, suiteId, suiteHash, locale,
track, scaffoldClass, evaluatedEntity, judgeMode)` match.

## Citation

See [`CITATION.cff`](CITATION.cff). No DOI has been minted yet; until a published
methods paper is available, cite the repository at the most recent tagged release.
