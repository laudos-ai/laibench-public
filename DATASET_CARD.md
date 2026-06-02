# Dataset Card

This card describes the data that ships in **this public repository** and, separately, the gated clinical dataset used for official LAIBench evaluation. The two are distinct. Read the boundary below before citing any numbers.

> **What ships here:** only **synthetic demonstration cases** — `cases/public/synthetic-demo.pt-BR.json` and `cases/public/synthetic-demo.en-US.json` — referenced by `suites/lite-public.pt-BR.json` and `suites/lite-public.en-US.json`. These exist for installation checks, smoke tests, and harness review. They are **not** a clinical dataset and must **not** be used to claim clinical validation.
>
> **What does not ship here:** the full clinical corpus, difficulty splits, RAB suites, the hidden test set, answer keys, and private scoring criteria. Those are private/gated and governed by [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md).

| Field             | Value                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Dataset name      | LAIBench public synthetic demo cases                                                           |
| Version           | 2.0.0 (per [`package.json`](./package.json))                                                   |
| Maintainer        | Laudos.AI — a commercial radiology-reporting vendor (see *Conflict of interest* below)         |
| Primary languages | Brazilian Portuguese (pt-BR), American English (en-US)                                          |
| Format            | JSON arrays in `cases/public/`, referenced by suite manifests in `suites/`                      |
| Cases shipped      | 4 synthetic demo cases per locale (8 total): `cases/public/synthetic-demo.{pt-BR,en-US}.json` |
| Schema            | [`schemas/case.schema.json`](./schemas/case.schema.json)                                        |
| License           | Proprietary Source-Available — all rights reserved (code and case JSON) + Trademark Policy                        |

## Conflict of interest

LAIBench is maintained by **Laudos.AI**, a commercial vendor of radiology-reporting software. The benchmark could be used to evaluate products that compete with, or that include, the maintainer's own systems. This conflict is disclosed openly. The methodology of record ([`docs/laibench-leaderboard-methods.md`](./docs/laibench-leaderboard-methods.md)) and the governance documents in this repository are intended to make scoring reproducible and inspectable so that results do not depend on trusting the maintainer.

---

## Public synthetic demo cases (what ships in this repository)

### Purpose

The public cases are **synthetic** — written to exercise the evaluation harness, not to represent real patients or real reporting distributions. Each case is flagged with `"synthetic": true` and a `schemaVersion` of `1.0.0-public-synthetic`. They drive the two public lite suites and the mock-agent smoke tests described in [`README.md`](./README.md). They are deliberately small so that anyone can run the harness end to end on a laptop with no gated access.

The suites that consume them state this directly in their manifests, e.g. `suites/lite-public.pt-BR.json`:

> *"Tiny synthetic-only public demo for local smoke testing. It is not a clinical corpus and is not a public benchmark split."*

### Contents

| Suite                                                        | Cases | Locale | Cases file                              |
| ----------------------------------------------------------- | ----: | ------ | --------------------------------------- |
| [`suites/lite-public.pt-BR.json`](./suites/lite-public.pt-BR.json) |     4 | pt-BR  | `cases/public/synthetic-demo.pt-BR.json` |
| [`suites/lite-public.en-US.json`](./suites/lite-public.en-US.json) |     4 | en-US  | `cases/public/synthetic-demo.en-US.json` |

The demo cases span a small range of modalities and scenarios chosen to cover the scorer's main behaviours:

- **Chest radiograph (XR), normal** — exercises negated/normal findings.
- **Head CT, urgent finding** — exercises critical-finding preservation (the case carries a `criticalFindings` entry).
- **Abdominal ultrasound (US), gallstone** — exercises omission and hallucination handling.
- **Lumbar spine MRI** — exercises structure, location, and laterality handling.

### Structure (per [`schemas/case.schema.json`](./schemas/case.schema.json))

A case is a self-contained JSON object. The required fields are:

| Field      | Type   | Meaning                                                                 |
| ---------- | ------ | ----------------------------------------------------------------------- |
| `id`       | string | Stable case identifier within the suite; used as `instance_id` in predictions. |
| `exam`     | string | Short exam descriptor (modality + anatomy + protocol).                  |
| `findings` | string | Concise text findings, in the case's locale, that the system must turn into a report. |
| `locale`   | string | `pt-BR` or `en-US`; selects locale-specific evaluators.                 |

Optional fields used by the scorer and dashboards:

| Field                   | Type            | Used by | Meaning                                                                                  |
| ----------------------- | --------------- | ------- | ---------------------------------------------------------------------------------------- |
| `label`                 | string          | —       | Human-readable label for dashboards; not used by the scorer.                             |
| `tags`                  | string[]        | —       | Free-form tags (modality, anatomy, scenario).                                            |
| `difficulty`            | enum            | —       | Rule-based difficulty classification (`easy`/`medium`/`hard`/`veryhard`).                |
| `criticalFindings`      | string[]        | CRIT    | Findings the case considers clinically decisive.                                         |
| `goldFindings`          | array           | QUAL    | Reference findings used for severity-aware matching.                                     |
| `guidelineExpectations` | array of objects | GUIDE   | Guideline applicability and expected values (e.g. BI-RADS, TI-RADS, PI-RADS, Bosniak, Fleischner, Lung-RADS). |
| `patientContext`        | object          | —       | Public-safe context (e.g. indication). Must not contain identifiers.                     |
| `metadata`              | object          | —       | Optional public-safe metadata. Must not contain identifiers, raw retrieval text, prompts, or credentials. |
| `schemaVersion`         | string          | —       | Schema-version tag for extended-case fields.                                             |

In the shipped demo files, `goldFindings` entries are objects carrying `finding`, `severity` (`critical`/`major`/`minor`), optional `negated`, and optional `location`/`laterality`. The demo files also include a `referenceReport` string and a `synthetic` flag for illustration. The schema permits these public-safe extended fields; the four fields in the table above are the only ones required for a valid case.

### Provenance and privacy of the demo cases

The demo cases are **synthetic text authored for harness testing**. They describe no real patient, exam, clinician, or institution. The `findings` and `patientContext` fields explicitly state they are demonstrations with no real data (e.g. `"Demonstracao sintetica sem dados reais."`). Because they are synthetic, they carry no PHI and require no de-identification.

### License of the demo cases

The synthetic demo cases are distributed under the repository's **Proprietary Source-Available License** (all rights reserved), which applies to both the code and the case JSON in this repository; reuse beyond authorized review, evaluation, and submission requires written authorization from Laudos.AI. A separate Trademark Policy protects the LAIBench/Laudos.AI name and logos. See [`LICENSE`](./LICENSE), [`LICENSE_POLICY.md`](./LICENSE_POLICY.md), and [`TRADEMARK.md`](./TRADEMARK.md).

The repository license **does not** apply to clinical data, the gated dataset, the hidden test set, answer keys, or private scoring criteria (see [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md)).

---

## Gated dataset (not in this repository)

Official LAIBench evaluation does **not** run on the synthetic demo cases. It runs on a larger, de-identified **clinical corpus** plus a held-out **hidden test set** that are **not present in this repository** and are governed by [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md). Nothing in this section describes data you can download here. The summary below states the maintainer's stated **principles** for that gated data; it is not a claim that any such data ships in this repo.

### Why it is gated

Real-derived clinical text cannot be safely open-downloaded. Per [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md):

- Raw clinical reports are never public.
- The official hidden test set, answer keys, and private scoring criteria remain private and are intended for hosted evaluation or tightly controlled access only.
- Automated PHI/PII scanning alone is **not** sufficient to approve any release of real-derived text: manual privacy review, legal review, and ethics/institutional review where applicable are required first.

### Access

Any access to real-derived or clinically realistic benchmark data requires written approval and a controlled-access agreement or data-use agreement (DUA). Controlled-access terms include: no redistribution; no re-identification attempts; no public reposting of cases, prompts, reports, hidden tasks, answer keys, or scoring criteria; no model training or fine-tuning on gated data unless explicitly authorized in writing; and incident reporting for suspected leakage or privacy exposure. See [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md) and [`GOVERNANCE_AND_PRIVACY.md`](./GOVERNANCE_AND_PRIVACY.md).

### Construction principles (stated, not shipped)

The gated clinical corpus is built to the following **principles**. The exhaustive procedural detail (specific de-identification patterns, NER models, review proportions, institutional source, date ranges) is **not disclosed in this repository**.

**Inclusion (a case is eligible only when):**

- It is fully self-contained: an exam descriptor, a findings string, a locale, and a stable ID.
- It contains no patient identifiers.
- It is reproducible from the suite manifest plus the referenced case content.

**Exclusion (a case is rejected when):**

- It references data that is not redistributable under the controlled-access policy.
- It references patient identifiers, named clinicians, or named institutions in any field.
- It is a duplicate of another case.

**De-identification principles:**

- Cases are constructed to exclude direct patient identifiers (names, document numbers, medical-record numbers, dates of birth, and episode-specific timestamps) and identifying contextual detail.
- De-identification is treated as a multi-step process, not a single automated scan: per [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md), real-derived text is not approved for any release on the basis of automated scanning alone.

These principles describe the gated corpus only. They are **not** a certification, and no compliance claim is attached to them (see *Privacy limitations*).

---

## Known biases

These apply primarily to the gated clinical corpus; the synthetic demo set is too small to characterise statistically and is not intended to be representative.

- **Locale skew.** pt-BR is the primary locale and is expected to be overrepresented relative to en-US.
- **Modality skew.** Cross-sectional modalities (CT, MR) are expected to be more common than US, XR, and mammography in the Portuguese material.
- **Source-corpus bias.** Real-derived cases inherit the terminology, exam mix, and clinical phrasing of their source reporting environment. That environment's institutional and demographic profile is not disclosed publicly and may bias results.
- **Rule-based difficulty.** Difficulty labels are assigned by deterministic rules and approximate, but do not equal, radiologist-perceived difficulty.

## Clinical limitations

- LAIBench evaluates a **text-to-text** mapping: it converts a findings string into a report. It does **not** measure image interpretation, image–text alignment, or whether a radiologist had image access when authoring the source findings.
- It does **not** measure downstream patient outcomes.
- It does **not** measure radiologist productivity, time savings, or financial outcomes.

## Privacy limitations

- The synthetic demo cases in this repository contain no real patient data.
- For the gated corpus, the maintainer follows the de-identification and review principles in [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md). No residual-PHI guarantee is asserted here for any real-derived data, and none of that data is present in this repository to inspect.
- LAIBench is **not** certified or accredited under HIPAA, GDPR, LGPD, or any other framework. No such accreditation is claimed.
- Privacy or security concerns can be reported to **oi@laudos.ai** (see [`SECURITY.md`](./SECURITY.md) and [`GOVERNANCE_AND_PRIVACY.md`](./GOVERNANCE_AND_PRIVACY.md)).

## Evaluation status

- **Inter-rater reliability.** No human inter-rater reliability statistics over LAIBench cases have been published yet. The harness can compute agreement metrics, but no human κ/α figures are committed here.
- **DOI.** No DOI has been minted yet.

Both items are accurate as of this version and should be described as **not yet published**, not as forthcoming guarantees.

## Scoring at a glance

For completeness, the dimensions that consume the fields above are CRIT (30%), QUAL (25%), TERM (20%), GUIDE (15%), and RAG (10%). The **primary public ranking metric is the Strict PASS rate** (a case passes only if every clinically decisive gate holds), reported with a bootstrap 95% confidence interval; per-dimension scores are diagnostic, not the ranking metric. The full method of record is [`docs/laibench-leaderboard-methods.md`](./docs/laibench-leaderboard-methods.md). See also [`RUBRIC.md`](./RUBRIC.md) and [`EVALUATION_PROTOCOL.md`](./EVALUATION_PROTOCOL.md).

## Related documents

- [`BENCHMARK_CARD.md`](./BENCHMARK_CARD.md) — benchmark-level overview.
- [`DATA_ACCESS_POLICY.md`](./DATA_ACCESS_POLICY.md) — public vs. controlled vs. private data.
- [`schemas/case.schema.json`](./schemas/case.schema.json) — case structure.
- [`docs/radiologist-adjudication-protocol.md`](./docs/radiologist-adjudication-protocol.md) — adjudication protocol.
- [`docs/populate-gold.md`](./docs/populate-gold.md) — how gold/critical findings are populated.
- [`GOVERNANCE_AND_PRIVACY.md`](./GOVERNANCE_AND_PRIVACY.md), [`LIMITATIONS.md`](./LIMITATIONS.md), [`LICENSE_POLICY.md`](./LICENSE_POLICY.md), [`TRADEMARK.md`](./TRADEMARK.md).

## Citation

See [`CITATION.cff`](./CITATION.cff).
