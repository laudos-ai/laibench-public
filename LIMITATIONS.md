# Limitations

An honest account of what LAIBench does not do, what it cannot yet do reliably,
and what it should not be used for. Read this file together with
[BENCHMARK_CARD.md](BENCHMARK_CARD.md), [DATASET_CARD.md](DATASET_CARD.md),
[EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md), and
[GOVERNANCE_AND_PRIVACY.md](GOVERNANCE_AND_PRIVACY.md).

> **LAIBench is a technical benchmark framework, not a medical device, not
> regulatory approval, and not clinical validation.** It must not be used as the
> sole basis for a clinical deployment decision. All clinical use requires
> qualified human oversight, local validation, institutional governance, and
> applicable legal/regulatory review.

## What LAIBench does not measure

- **Image interpretation.** LAIBench evaluates a text-to-text mapping: a locked
  exam descriptor plus a findings string in, an HTML report out. The benchmark
  has no access to pixel data and does not measure detection, classification,
  segmentation, or image–text alignment. It is not a diagnostic-accuracy study.
- **Triage prioritisation.** LAIBench does not measure whether a system ranks
  worklists correctly or selects which study to read first.
- **Clinical outcome.** A high LAIBench result does not predict patient outcome.
  No outcome data is in the loop.
- **Workflow time-savings or productivity.** LAIBench does not measure reading
  speed, dictation latency, or downstream signing time inside a clinical
  workflow.
- **Financial impact for clinicians or institutions.** Productivity- and
  revenue-savings claims are out of scope, and the maintainer avoids them for
  medical-advertising-compliance reasons.
- **Patient safety in deployment.** A LAIBench result is one pre-deployment
  input among many. It does not replace clinical engineering review, medical-
  device regulatory review, or board-certified radiologist sign-off.
- **Multimodal or agentic behaviour beyond reporting.** Tool use, multi-turn
  dialogue under uncertainty, EHR/FHIR navigation, and DICOM SR write-back are
  out of scope for the public harness. See [docs/agent-track.md](docs/agent-track.md)
  for how agent submissions are scoped within those bounds.

## What LAIBench cannot yet do reliably

- **Distinguish paraphrase from clinically equivalent variation universally.**
  Synonym groups and locale-aware evaluators address common cases, but they do
  not cover every clinically valid wording. Genuinely equivalent reports can be
  scored differently at the margins.
- **Resist contamination-aware models.** Canary tokens and contamination
  controls detect naive overlap between evaluation text and training data; they
  are **necessary but not sufficient**. A model adversarially trained to evade
  canaries, or one trained on paraphrased derivatives of the corpus, can defeat
  these controls. Treat contamination defences as a deterrent, not a guarantee.
- **Adjudicate genuinely ambiguous cases automatically.** Where two reports are
  both clinically acceptable, the rubric (see [RUBRIC.md](RUBRIC.md)) and the
  human protocol in [docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md)
  require human adjudication. The harness flags such cases; it does not resolve
  them on its own.
- **Estimate generalisation beyond its case mix.** The public synthetic demo
  cases, and the gated corpus used for official evaluation, reflect a specific
  curation and recombination pipeline applied to a single curated reporting
  corpus. Performance may not transfer to a different institution, scanner mix,
  modality distribution, or reporting style.

## Known biases

- **Locale.** Brazilian Portuguese content is overrepresented relative to
  American English. The two public suites
  ([suites/lite-public.pt-BR.json](suites/lite-public.pt-BR.json),
  [suites/lite-public.en-US.json](suites/lite-public.en-US.json)) are parallel
  but synthetic and tiny; they are not balanced clinical samples.
- **Modality.** CT and MR are more common than ultrasound, radiography, and
  mammography. Modality-specific terminology checks are correspondingly more
  mature for CT/MR.
- **Single-corpus synthesis bias.** The clinical-style cases used for official
  evaluation are derived by extractive recombination from a single source
  corpus. Institutional and demographic features of that corpus are not declared
  publicly and may bias terminology, exam mix, and section conventions. The
  source corpus is not part of this repository (see
  [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md)).
- **Rule-based difficulty.** Difficulty and criticality are assigned by
  deterministic heuristics, not radiologist-perceived difficulty. Keyword-based
  critical-finding detection can miss phrasing variants.
- **Vendor self-evaluation.** LAIBench is maintained by Laudos.AI, a commercial
  radiology-reporting vendor. This is a conflict of interest. It is disclosed on
  the leaderboard and governed by the mitigations in
  [GOVERNANCE_AND_PRIVACY.md](GOVERNANCE_AND_PRIVACY.md); a vendor-maintained
  benchmark should be read with that context in mind.

## Validation status (not yet published)

- **Human inter-rater reliability.** Agreement statistics (Cohen's κ, Fleiss' κ,
  Krippendorff's α) are implemented in the harness, and the human adjudication
  procedure is specified in
  [docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md).
  However, **no human-versus-human reliability result has been published yet.**
  No current LAIBench score should be described as radiologist-adjudicated.
- **DOI and preprint identifier.** **No DOI has been minted** and **no formal
  LAIBench methods preprint (arXiv/medRxiv) has been published yet.** The
  methodology of record is
  [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).
  Note that the separate "Beyond Templates" theory paper on report variability
  is **not** the benchmark methodology and should not be cited as such.
- **Independent submissions.** The external submission process is documented in
  [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md) and
  [docs/public-submissions.md](docs/public-submissions.md). The public
  leaderboard is young; independent third-party submissions are still
  accumulating.
- **Comprehensive privacy sweep of real-derived text.** Automated PHI/PII
  scanning is not sufficient to certify de-identification. Manual privacy,
  legal, and ethics review is required before any real-derived clinical text is
  released, per [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md). The public cases
  in this repository are synthetic and therefore not subject to that gate.

## A note on the ranking metric

The public ranking metric is the **Strict PASS rate**: a case passes only when
every clinically decisive gate holds, reported with a bootstrap 95% confidence
interval. The five per-dimension scores (CRIT 30%, QUAL 25%, TERM 20%,
GUIDE 15%, RAG 10%) are **diagnostic**, not the ranking metric. A high weighted
average can still coexist with critical-gate failures; do not read the weighted
score as a safety claim. See [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md)
and [RUBRIC.md](RUBRIC.md) for exact gate semantics.

## Use cases LAIBench supports today

- Pre-deployment, pre-procurement evaluation of radiology reporting systems and
  agents.
- Regression evaluation across versions of the same system.
- Failure-mode taxonomy for procurement and RFP comparisons.
- Reproducible scoring against a public, versioned benchmark contract.

## Use cases LAIBench does not support

- Clinical decision-making for individual patients.
- Certifying that a system is safe for clinical deployment.
- Marketing claims framed as substitution for radiologists.
- Estimates of productivity, revenue, or time-savings.
- Cross-track or cross-suite aggregated leaderboard claims (tracks and suites are
  not merged into a single rank).

For questions, corrections, or to report a problem with these limitations,
contact **oi@laudos.ai**.
