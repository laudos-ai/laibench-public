# Evaluation Protocol

This document defines how LAIBench evaluates a system. It is the contract that runs
and leaderboard entries must satisfy. It is written so a third party can reproduce a
result, audit a submission, and understand why a case passed or failed.

LAIBench is maintained by [Laudos.AI](https://laudos.ai), a commercial radiology
reporting vendor. This is a disclosed conflict of interest. The protocol is published
openly, scoring is recomputed by the harness before publication, and the comparability
rules below are designed so that no single party can quietly advantage one system over
another. The official evaluation also draws on a larger gated dataset under controlled
access (see [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md)); that dataset is **not** in
this repository. The only clinical-style cases shipped here are the synthetic demo
cases used by the public lite suites.

For the conceptual companion to this protocol, see [BENCHMARK_CARD.md](BENCHMARK_CARD.md)
and [DATASET_CARD.md](DATASET_CARD.md). For the scoring rubric, see [RUBRIC.md](RUBRIC.md).
For how to submit, see [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md). The methodology of
record for leaderboard reporting is
[docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md). Known
limitations are listed in [LIMITATIONS.md](LIMITATIONS.md).

---

## 1. Unit of evaluation

A **case**: one JSON object from a suite, conforming to
[schemas/case.schema.json](schemas/case.schema.json). The system under evaluation
receives the case and returns one HTML report. Per-case scoring is independent. Scores
aggregate at the suite level after recomputation by the harness.

The public suites in this repository,
[suites/lite-public.pt-BR.json](suites/lite-public.pt-BR.json) and
[suites/lite-public.en-US.json](suites/lite-public.en-US.json), draw on the synthetic
demo cases and are intended for installation checks, smoke tests, and framework review.
Official scores are produced on the larger gated dataset under controlled access.

---

## 2. Input contract

The evaluated system receives, per case, the fields defined in
[schemas/case.schema.json](schemas/case.schema.json):

- `id` — stable case identifier within the suite; locked; used as `instance_id` in
  predictions.
- `exam` — short exam descriptor (modality + anatomy + protocol).
- `findings` — concise text findings, in the case's `locale`, that the system must
  convert into a report.
- `locale` — `pt-BR` or `en-US`. Drives locale-specific evaluators.
- Optional public-safe context: `label`, `tags`, `difficulty`, `criticalFindings`,
  `goldFindings`, `guidelineExpectations`, `patientContext`, `metadata`.

The system must not receive, infer, or use:

- Patient identifiers, named clinicians, or named institutions.
- Information not present in the case object.
- Labels or answer keys from any withheld split.

The case schema forbids identifiers in `patientContext` and `metadata`. Cases that
violate the schema are rejected before they reach a system under evaluation.

---

## 3. Output contract

The system must return, per case, one prediction record conforming to
[schemas/prediction-record.schema.json](schemas/prediction-record.schema.json):

- `instance_id` — the case `id` from the locked suite manifest.
- `model_output` — a single HTML report using the allowed report subset below.
- `model_name_or_path` — optional public display label for the evaluated system.
- `metadata` — optional, public-safe only. Specifically `metadata.evidenceIds`: a list
  of public-safe evidence identifiers, **not** raw evidence text.

Predictions are submitted as JSONL — one record per line. The submission contract is
documented in [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md) and
[docs/public-submissions.md](docs/public-submissions.md).

### Allowed HTML subset

Reports may use only:

```
<center>, <b>, <br>
```

This matches the report subset declared in [README.md](README.md) and the leaderboard
methods. The harness sanitises every output before scoring: tags outside the allowed
subset are stripped, and attributes are not preserved. Sanitisation is applied
identically to every submission so that a report cannot game scoring through markup. An
output that is empty after sanitisation, or that relied on disallowed tags to convey
content, is treated as a content failure for the affected case.

The prediction-record schema sets `additionalProperties: false`. Prompts, routes,
credentials, raw retrieved text, hidden judge configuration, private case content, and
implementation details must not appear in any field.

---

## 4. Dual-phase scoring

Each case is scored in two phases and combined conservatively per dimension. The
authoritative dimension definitions, error tiers, and gate semantics are in
[RUBRIC.md](RUBRIC.md).

### Phase 1 — Deterministic checks

Pure functions on the input/output pair. No model call. The result is deterministic for
a given `(case, output)` pair. Deterministic checks cover:

- Locale-aware normalisation before comparison — Unicode NFKC, non-breaking spaces,
  hyphen variants, curly quotes, and decimal-comma handling between digits.
- Section extraction with exact-match-first and a word-boundary fallback, rejecting
  sub-four-character substring matches to avoid spurious hits.
- Per-dimension checks for CRIT, QUAL, TERM, GUIDE, and RAG (see §5).

### Phase 2 — Adversarial judge (optional)

An LLM-as-judge step probes for hallucinations, contradictions, and unsafe negations
the deterministic phase cannot easily detect. The judge:

- Is invoked only when configured at run time (a judge model is selected explicitly).
- Receives the same locked case and the same system output as the deterministic phase.
- Returns a structured JSON verdict per dimension.
- Is logged with its model identifier and judge mode in the run artifact.

The judge identifier and judge mode are part of the leaderboard comparability key
(§17), so two runs only compare under the same judge configuration. A run with no judge
configured is comparable only with other judge-disabled runs.

### Combination

For each dimension `d`, the conservative (`conservative-min`) combination is:

```
score(d) = min( deterministic(d), adversarial(d) )
```

The minimum is conservative by design: a case cannot earn a high judge score if the
deterministic check failed, and it cannot earn a high deterministic score if the judge
flagged a real problem. When a run instead declares the `judge-primary` mode, the
pinned judge produces the primary report-quality score while deterministic critical
checks remain hard gates; the scoring mode is declared in the run artifact and is part
of the comparability key.

Severity caps are then applied:

- Any critical-finding failure caps the case below PASS (a hard cap). The case cannot
  be ranked as PASS regardless of other dimension scores.
- Multiple major failures cap the case below PASS.

The exact cap thresholds are documented in [RUBRIC.md](RUBRIC.md).

---

## 5. Dimensions and weights

The five dimensions and their clinical weight mix are used for **diagnostic
per-dimension reporting only**. The public ranking metric is Strict PASS (§6), not a
weighted average.

| Dimension | Weight | Failure modes it detects |
| --------- | -----: | ------------------------ |
| CRIT      |    30% | Missed critical finding, unsafe negation, laterality flip, measurement loss |
| QUAL      |    25% | Severity mismatch, hallucination, missing pertinent positive/negative |
| TERM      |    20% | Forbidden terms, forbidden openers, classification-system errors |
| GUIDE     |    15% | Inapplicable guideline used, wrong classification value, missing recommendation |
| RAG       |    10% | Evidence order, laterality, measurements lost between retrieval and report |

These weights match the scoring table in [README.md](README.md) and the leaderboard
methods. The case schema supplies the per-dimension references:
`criticalFindings` drives CRIT, `goldFindings` drives QUAL severity-aware matching, and
`guidelineExpectations` drives GUIDE.

---

## 6. Primary public metric: Strict PASS

A case is **PASS** if and only if every clinically decisive gate holds:

1. No missed critical finding declared in the case.
2. No unsafe negation applied to a critical-positive finding.
3. No laterality flip on a lateralised finding.
4. No structural break (required report sections present and in the right order).
5. No terminology violation (locale forbidden terms or openers, modality mismatches, or
   classification-system errors).
6. No fabricated measurement, classification value, or recommendation that is not
   supported by the locked input.

Strict PASS is **binary per case**. The primary public ranking metric is the
**suite-level Strict PASS rate**, reported with a bootstrap 95% confidence interval
(§9). Per-dimension scores explain *why* a case failed but do not aggregate into the
rank.

---

## 7. Verdict distribution

For diagnostic purposes only, runs also report verdict counts:

- `PASS` — Strict PASS holds.
- `PARTIAL` — deterministic dimensions pass but the judge flags issues (or the reverse),
  the case is above the PARTIAL threshold, and there is no critical fail.
- `FAIL` — anything else.

A critical fail forces `FAIL` regardless of overall score. Verdict counts are
diagnostic context, not the ranking metric.

---

## 8. Reporting outputs

Every run artifact includes:

- Run name, model label, track, scaffold class, judge mode, and judge model.
- Suite ID, suite hash, and locale.
- Per-case overall plus per-dimension deterministic / adversarial / combined scores.
- Suite-level Strict PASS rate, bootstrap 95% CI, and verdict counts.
- Per-dimension means.
- Failure-taxonomy counts.
- Provenance: a case → suite → scoring → run hash chain.
- Sanitised validation reasons for ineligible cases (counts, not raw case lists).

Run artifacts are **recomputed before publication**. Case overalls, suite summaries,
verdict counts, per-dimension means, the comparability key, and the local suite hash are
recomputed by the harness; a manually edited run JSON with inflated scores is rejected
before any public output is produced. This recomputation rule is shared with
[docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).

---

## 9. Bootstrap confidence intervals

Strict PASS rates are reported with a percentile bootstrap 95% CI computed from
case-level binary outcomes. Smaller suites carry wider CIs. The rule of thumb is that a
difference smaller than the half-width of either CI should not be read as significant.
The resample count and seed used for a run are recorded so the interval can be
reproduced.

---

## 10. Discrimination between models

Pairwise comparison between two runs uses a paired bootstrap with shared resample
indices to test the mean overall difference, plus per-dimension breakdowns and
per-modality and per-difficulty stratified deltas (reported only when stratum size is at
least 5). A comparison is reported as `discriminates`, `weak`, or `fails`, based on the
magnitude and CI of the difference. Superiority is never reported without paired testing
on the same suite hash.

---

## 11. Calibration

Calibration reporting covers:

- Test–retest reliability (same judge, multiple runs) to estimate judge stability.
- Cross-judge agreement on verdict labels and on overall scores.
- Rank correlation between deterministic and judge per-case scores.
- Contamination scanning, which reports canary-token leakage and judge-flagged
  contamination signals (§18).

---

## 12. Disagreement handling

- **Deterministic ↔ judge.** Keep the lower per-dimension score, `min(det, adv)`, under
  the conservative mode.
- **Judge ↔ judge** (cross-judge studies). Report agreement statistics; do not silently
  average. The public leaderboard is filtered to a single canonical judge profile per
  row, so cross-judge results are diagnostic, not ranking inputs.
- **Human ↔ judge.** When a radiologist reference is available, the radiologist label is
  the reference and judge labels are treated as the system under evaluation. The
  radiologist-adjudicated validation protocol is documented in
  [docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md).

---

## 13. Ambiguous cases

A case is **ambiguous** if a board-certified radiologist would accept multiple report
wordings as clinically equivalent. The benchmark handles ambiguity by:

- Using synonym groups in QUAL matching.
- Allowing locale-specific structural variations.
- Penalising contradiction, not paraphrase, in adversarial judging.

Cases that fail an ambiguity guard are flagged for adjudication per
[docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md)
and removed from a suite if the adjudication outcome is uncertain.

---

## 14. Critical-error definition

A **critical error** is any of:

- Missed critical finding (the case declares it; the report omits it).
- Negation of a critical-positive finding ("no pulmonary embolism" when the input states
  one is present).
- Laterality flip on a lateralised finding (left ↔ right).
- Inversion of a classification system (e.g. BI-RADS 5 reported as BI-RADS 2).
- Fabricated measurement that materially changes management.

A critical error forces FAIL and caps the case below PASS (§4).

---

## 15. Major-error definition

A **major error** is any of:

- Missing pertinent positive or pertinent negative that is not classified as critical.
- Forbidden term, forbidden opener, or modality mismatch.
- Misapplied guideline.
- Structural break (missing or misordered required section).

---

## 16. Minor-error definition

A **minor error** is any of:

- Stylistic or formatting deviation that does not affect clinical meaning.
- Terminology variant within the same canonical synonym group.
- Optional section-ordering preference.

---

## 17. Comparing runs

Two runs only enter the same leaderboard row when their **comparability key** matches:

```
benchmarkVersion, suiteId, suiteHash, locale, track, scaffoldClass,
evaluatedEntity, judgeMode, judgeModel
```

Runs whose keys differ are placed in separate sections of the public leaderboard table;
they are never mixed as equivalent comparisons. Because `suiteHash` is part of the key,
a run on the public lite suite is never comparable with a run on the gated dataset, and
two runs on different suite versions are never merged into one rank.

---

## 18. Anti-gaming rules

The harness enforces:

1. **Score recomputation.** Case overalls, suite summary, verdict counts, per-dimension
   means, comparability key, and local suite hash are recomputed before leaderboard
   publication. Inflated input fields are rejected.
2. **Canary tokens.** Hidden tokens embedded in suite cases detect benchmark
   contamination via training data. Flagged runs are excluded from ranking.
3. **Hash integrity.** The suite hash is the SHA-256 of the case content. Any
   modification invalidates every prior run on that suite.
4. **Sanitised public artifacts.** Validation reasons are surfaced as counts, not as raw
   case lists. Provider strings, private routes, and credentials are stripped.
5. **No manual edits.** Leaderboard rows do not accept hand-edited score JSON.
6. **Grouped leaderboard.** Incompatible runs do not mix (§17).

---

## 19. Track system

- `agent` — full product agents and multi-step reporting workflows. See
  [docs/agent-track.md](docs/agent-track.md).
- `mini-agent` — a hosted model accessed through the canonical minimal scaffold shipped
  in this repository.
- `model` — a direct raw-model baseline, without product-workflow parity.

Cross-track comparisons are **not** part of the public ranking. Every leaderboard table
documents this. Use `--track agent` for product workflows and multi-step agents; use
`--track model` only for direct raw-model baselines.

---

## 20. Run reproducibility

A reported result is reproducible only if a third party can:

1. Pin the repository to the run's `benchmarkVersion` and commit.
2. Use the suite ID and suite hash from the run artifact.
3. Use the same model, prompt, scaffold class, judge, and judge mode declared in the run
   artifact.
4. Recompute scores from the case outputs using the submission evaluation command.

The run artifact carries enough metadata to perform steps 2–4. Step 1 requires the
public repository to remain accessible. Official scores on the gated dataset are
reproducible only under controlled access, since the gated cases are not committed to
this repository.

---

## 21. Failure modes that disqualify a submission

A submission is rejected (and does not appear on the public leaderboard) when any of the
following holds:

- The prediction JSONL fails
  [schemas/prediction-record.schema.json](schemas/prediction-record.schema.json)
  validation.
- Case IDs are missing, duplicated, or extraneous relative to the locked suite.
- Outputs are empty or rely on disallowed HTML tags.
- The canary-token check flags contamination.
- The provided suite hash does not match the locked suite hash.

---

## 22. Logged metadata

Every run logs only non-sensitive metadata:

- Timestamp, runtime, and harness version.
- Suite ID and hash.
- Model label, scaffold class, and track.
- Judge configuration label (model + mode).
- A process or local-user identifier, hashed.
- The provenance chain hash.

No private prompts, raw retrieved content, credentials, internal routes, or raw case
content appears in published artifacts. The contamination and privacy rules above are
consistent with [GOVERNANCE_AND_PRIVACY.md](GOVERNANCE_AND_PRIVACY.md) and
[SECURITY.md](SECURITY.md).

---

## 23. Honest status and open items

- **Inter-rater reliability.** No human inter-rater reliability values for the rubric
  are published yet. They are not yet available; do not treat any current public score
  as radiologist-adjudicated unless a passing adjudication record exists for the exact
  suite hash, per
  [docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md).
- **DOI.** No DOI has been minted yet. Cite the benchmark via
  [CITATION.cff](CITATION.cff) and this repository until a DOI is published.
- **Gold-finding labels.** Gold findings are heuristically derived, not fully
  radiologist-adjudicated. See [LIMITATIONS.md](LIMITATIONS.md).
- **Scope.** This protocol scores generated report text, not primary image
  interpretation and not downstream clinical outcomes. LAIBench is a technical benchmark
  framework, not a medical device, regulatory approval, or clinical validation. See
  [README.md](README.md) and [LIMITATIONS.md](LIMITATIONS.md).
