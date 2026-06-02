# Governance and Privacy

This document describes how LAIBench is governed, how the project manages the
conflict of interest created by its commercial maintainer, what controls are in
place to deter and detect gaming, and how the project handles privacy and the
boundary between public and gated data.

LAIBench is maintained by **Laudos.AI**, a commercial radiology-reporting
vendor. That relationship is a conflict of interest, and this document discloses
it openly and describes the mitigations that make the public results auditable
by third parties.

- Public repository: <https://github.com/laudos-ai/laibench-public>
- Public website / leaderboard: <https://laibench.laudos.ai>
- Version: 2.0.0
- Governance / privacy / security contact: **oi@laudos.ai**

---

## 1. Medical and scope disclaimer

LAIBench is an evaluation framework. It is **not a medical device** and does not
provide diagnosis, treatment, or care recommendations for any individual
patient. A score on LAIBench does not certify the clinical safety, efficacy, or
regulatory status of any system under evaluation.

A system that scores well on LAIBench has not, by that fact alone, been
validated for clinical use. A system that scores poorly has not, by that fact
alone, been shown to be unsafe. LAIBench is one pre-deployment input among many,
to be interpreted by a qualified clinical team.

Systems are evaluated as **text generators** — finding-to-report writers — not
as autonomous decision-makers. LAIBench does not authorise, support, or
recommend autonomous diagnostic agents in clinical use. Any clinical deployment
of a radiology-reporting system requires board-certified radiologist sign-off on
every signed report, a documented institutional governance process, and a
documented escalation path for critical findings. LAIBench does not replace
human review at any step.

---

## 2. Data boundary: what is and is not in this repository

The single most important governance fact about LAIBench is the boundary between
public and gated data. The full policy is in
[DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md); the summary follows.

### 2.1 Shipped in this public repository

- **Synthetic demonstration cases only.** The only clinical-style cases in this
  repository are
  [`cases/public/synthetic-demo.pt-BR.json`](cases/public/synthetic-demo.pt-BR.json)
  and
  [`cases/public/synthetic-demo.en-US.json`](cases/public/synthetic-demo.en-US.json).
  They exist for installation checks, smoke tests, and harness review. They are
  **not** a representative clinical dataset and must not be used to claim
  clinical validation.
- The public "lite" suites that reference those demo cases:
  [`suites/lite-public.pt-BR.json`](suites/lite-public.pt-BR.json) and
  [`suites/lite-public.en-US.json`](suites/lite-public.en-US.json).
- The framework, schemas, documentation, and site assets.

The synthetic demo cases carry an explicit disclaimer that they are not derived
from patient data.

### 2.2 Gated — NOT in this repository

The following are **private or gated** and are **not** present in this
repository under any path:

- The full clinical corpus and any real-derived clinical text.
- Difficulty splits and the RAB suites.
- The hidden test set and its answer keys.
- Private scoring criteria.

Official LAIBench evaluation uses a **larger gated dataset under controlled
access**. That dataset is not downloadable from this repository. Access requires
written approval and a controlled-access or data-use agreement whose terms
include: no redistribution; no re-identification attempts; no public reposting of
cases, prompts, reports, hidden tasks, answer keys, or scoring criteria; no
training or fine-tuning on gated data unless explicitly authorised in writing;
and incident reporting for suspected leakage. See
[DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md) for the binding terms.

Nothing in this document should be read as describing gated data as if it ships
in this repository. It does not.

---

## 3. Privacy posture

### 3.1 De-identification of public material

The public material in this repository is built to be free of patient
identifiers. The synthetic demo cases and the synthetic examples under
[`examples/`](examples/mock-agent.mjs) are constructed, not extracted from
patient records, and are not linkable to a specific patient.

For gated, real-derived material, automated PHI/PII scanning alone is **not**
treated as sufficient to approve release. Manual privacy review, legal review,
and ethics or institutional review where applicable are required before any
real-derived clinical text could ever be released — and, per the data boundary
above, none is released into this public repository.

### 3.2 Submissions must be de-identified

Any submission text other than the system's own output — for example retrieved
evidence or prompt examples — must not contain:

- Patient names, initials, document numbers (CPF, RG, MRN, prontuário), dates of
  birth, dates of admission, or other temporal identifiers tied to a specific
  episode;
- Named clinicians signing a source report;
- Named institutions in a way that can be linked to a specific patient.

The submission contract in [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md) restates
this requirement.

### 3.3 If you find identifiable content

If you discover patient-identifiable content in any file in this repository:

1. Stop using or sharing that file.
2. Report it through the channel in [SECURITY.md](SECURITY.md).
3. Provide enough context (file path, line number, partial quote) for the
   maintainer to triage without further exposing the data.

Confirmed identifiable content is removed from the public repository, and the
removal is logged with the affected file path and the date.

### 3.4 Privacy frameworks — awareness, not certification

LAIBench operates with awareness of the frameworks below. **The project does not
claim compliance certification under any of them, and LAIBench is not certified
LGPD-, GDPR-, or HIPAA-compliant.**

- **LGPD (Brazil):** the maintainer operates under Brazilian jurisdiction. The
  public LAIBench cases are constructed not to be linkable to a specific
  patient.
- **GDPR (EU):** researchers or hospitals using LAIBench inside the EU remain
  responsible for ensuring that anything they submit (prompts, retrieval
  indices, run logs) complies with GDPR.
- **HIPAA (US):** LAIBench is not a covered entity. Hospitals subject to HIPAA
  must not transmit Protected Health Information through LAIBench. The public
  suites are not PHI.

Compliance with any of these frameworks for a given deployment is the deploying
institution's responsibility, not LAIBench's.

---

## 4. Conflict-of-interest disclosure

**The maintainer of LAIBench is Laudos.AI, a commercial company that develops a
radiology-reporting product.** The maintainer therefore has a direct conflict of
interest with respect to runs submitted by competing vendors, and with respect
to any maintainer-submitted runs that appear on the same leaderboard.

This is a vendor-maintained benchmark. The self-evaluation risk is real: a
commercial party scoring itself and its competitors can, in principle, shade
results in its favour. LAIBench's response is not to deny that risk but to make
the results **independently reproducible** so that the risk can be checked rather
than trusted.

### 4.1 Mitigations in place

1. **Recompute-before-publish.** The harness is deterministic. Public leaderboard
   rows are **recomputed from the submitted predictions** before publication
   using the public scoring code in this repository. The maintainer cannot change
   a competitor's published score without changing the public harness, and any
   such change is visible in the public Git history.
2. **Maintainer flag.** Rows submitted by the maintainer organisation carry a
   `maintainer_flag` (see
   [`schemas/leaderboard.schema.json`](schemas/leaderboard.schema.json)) so that
   maintainer-submitted entries are visibly distinguished from third-party
   entries everywhere they appear.
3. **Standing COI notice.** The conflict-of-interest disclosure is surfaced
   alongside the public leaderboard, not buried in a single page.
4. **Documented rejections.** The maintainer commits to not silently rejecting
   competing submissions. Every rejection is documented in the corresponding
   public pull request, with a stated reason.

### 4.2 Honest status

External co-maintainers have **not yet** been confirmed, and no independent
audit of maintainer-submitted rows has yet been published. Until independent
review is in place, the mitigations above (public harness, public predictions,
recompute-before-publish, maintainer flag, documented rejections) are what make
the results checkable. Readers evaluating maintainer-submitted rows should treat
them in light of this disclosure and re-run the public harness if they want an
independent number.

---

## 5. Anti-gaming controls

LAIBench's primary public ranking metric is the **Strict PASS rate** — a case
passes only if every clinically decisive gate holds — reported with a bootstrap
95% confidence interval. Per-dimension scores (CRIT 30%, QUAL 25%, TERM 20%,
GUIDE 15%, RAG 10%) are **diagnostic**, not the ranking metric. Because a single
headline number invites optimisation against the metric rather than the task, the
following controls apply. The full scoring rules are in the methodology of record,
[docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).

### 5.1 Canary tokens and contamination control

The gated suites carry **canary tokens** — unique, traceable markers embedded so
that leakage of gated cases into a public corpus, a training set, or a prompt
example can be detected after the fact. A submission whose output reproduces a
canary, or whose behaviour indicates memorisation of gated cases, is treated as
contaminated and is not eligible for the public leaderboard. The hidden test set
is reserved for hosted or tightly controlled evaluation precisely so that it
cannot be optimised against.

### 5.2 Recompute-before-publish

As in §4.1, every published row is recomputed from the submitted prediction
records (see
[`schemas/prediction-record.schema.json`](schemas/prediction-record.schema.json)
and [`schemas/submission.schema.json`](schemas/submission.schema.json)) using the
public harness. A submitter cannot self-report a Strict PASS rate; the number on
the leaderboard is the number the public scorer produces from the submitted
predictions against the locked suite.

### 5.3 Grouped leaderboard keys

Rows are **grouped by a comparable key** and never silently merged across
incompatible configurations. Two rows only share a row group when every key field
matches — including `benchmark_version`, `suite_id`, `suite_hash`, `locale`,
`track`, and the model/scaffold identity. A change to `model_version`,
`prompt_version`, `harness_version`, `scaffold_class`, or `judge_model` produces a
**new** row rather than overwriting an old one, and re-running the identical
configuration does not mint a new row. This prevents cherry-picking a favourable
run and presenting it as a comparison against differently-configured systems. The
key fields are defined in
[`schemas/leaderboard.schema.json`](schemas/leaderboard.schema.json).

### 5.4 Locked suites and provenance

Each suite is locked and identified by a suite hash. Run artifacts record the
provenance chain (case → suite → scoring → run), the harness version, and the
commit SHA, so that any published row can be traced back to the exact inputs that
produced it. This makes after-the-fact tampering detectable.

---

## 6. Track separation and comparability

LAIBench separates runs by track rather than mixing them into one rank:

- `agent`: highest variance, lowest comparability across submissions.
- `mini-agent`: medium variance, defined scaffold.
- `model`: lowest variance, raw-model baseline.

Tracks are grouped, not blended, on the leaderboard. See
[docs/agent-track.md](docs/agent-track.md) for the agent-track rules.

---

## 7. Using LAIBench before a clinical deployment

LAIBench provides a controlled pre-deployment score. It does **not** provide, and
must not be treated as a substitute for, the steps a deploying institution still
owes:

1. Re-evaluate the system on the institution's own data distribution, not only on
   LAIBench public cases.
2. Run the system through institutional clinical-engineering review.
3. Run the system through the institution's medical-device or governance review
   where applicable.
4. Confirm board-certified radiologist sign-off on every clinical output.
5. Maintain continuous monitoring and a rollback plan.

Appropriate uses of LAIBench include: one input in vendor selection; a baseline
for in-house regression evaluation across model versions; a structured
failure-mode taxonomy for procurement RFPs; and a public, comparable score that
an institution can cite. None of these is sufficient on its own to authorise
clinical deployment.

---

## 8. Governance status and roadmap

LAIBench is, today, a vendor-maintained project. The following items are
**planned but not yet in place**, and are stated here honestly rather than as
accomplished facts:

- Confirming at least one external co-maintainer who is not a Laudos.AI employee.
- Publishing named maintainers, roles, and a breaking-change RFC procedure.
- A public submission-review queue so that turnaround time is visible.
- A documented appeal path for rejected submissions.
- A sponsor-disclosure section listing any funding or in-kind support the project
  receives.

Two further items of honest status: **no human inter-rater reliability study has
been published** for the adjudication protocol, and **no DOI has been minted**
for the benchmark. Both are described as not yet published; neither should be
cited as if it exists. The radiologist adjudication process is documented in
[docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md).

---

## 9. Related documents

- [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md) — binding public/gated data terms.
- [SECURITY.md](SECURITY.md) — responsible disclosure, including PHI exposure and suspected gaming.
- [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md) — submission contract and de-identification requirements.
- [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md) and [RUBRIC.md](RUBRIC.md) — how scoring works.
- [LIMITATIONS.md](LIMITATIONS.md) — known limitations of the benchmark.
- [LICENSE_POLICY.md](LICENSE_POLICY.md) and [TRADEMARK.md](TRADEMARK.md) — licensing (Proprietary Source-Available) and trademark terms.
- [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md) — methodology of record.
- [docs/public-submissions.md](docs/public-submissions.md) — how to submit a public run.

> Note: the "Beyond Templates" preprint is a separate theory paper on report
> variability and does **not** describe this benchmark. Do not cite it as the
> LAIBench methodology; the methodology of record is
> [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).

---

## 10. Contact

- Operational governance questions: open a GitHub issue with the `governance`
  label.
- Sensitive concerns (PHI exposure, conflict-of-interest complaint, suspected
  gaming): use the responsible-disclosure channel in [SECURITY.md](SECURITY.md),
  or email **oi@laudos.ai**.
