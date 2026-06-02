# Model Submission

This document explains how an external party evaluates a radiology
reporting system against LAIBench and how a result reaches the public
leaderboard. It expands the minimal technical contract in
[docs/public-submissions.md](docs/public-submissions.md) with the
provenance, disclosure, and comparability rules required for inclusion,
and it should be read alongside [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md).

> **Scope.** LAIBench is a technical benchmark framework. It is not a
> medical device, not regulatory approval, and not clinical validation.
> A submission and a leaderboard row say something about reporting
> behavior on a fixed suite — not about clinical safety or fitness for
> deployment. See [LIMITATIONS.md](LIMITATIONS.md).

> **Maintainer disclosure.** LAIBench is maintained by
> [Laudos.AI](https://laudos.ai), a commercial radiology-reporting
> vendor. The maintainer may submit its own systems. To keep this
> conflict of interest in check, scoring is recomputed deterministically
> from frozen predictions (the harness does not trust hand-edited score
> fields), submissions and reviews are public, and the maintainer's own
> rows are labeled like any other. See
> [GOVERNANCE_AND_PRIVACY.md](GOVERNANCE_AND_PRIVACY.md).

## Who can submit

- Vendors of radiology reporting systems.
- Research groups running model baselines.
- Hospital engineering teams.
- Independent contributors.

Submitting a system does not imply endorsement by LAIBench or by the
maintainer.

## Two evaluation paths

LAIBench distinguishes a **public** path that anyone can run from this
repository, and a **gated/official** path that uses a larger
controlled-access dataset.

| Path | Data | Who runs it | What it produces |
| --- | --- | --- | --- |
| **Public (this repo)** | The synthetic demo cases shipped here (`cases/public/synthetic-demo.*`), wired into the public *lite* suites | Anyone, locally | A self-reported run artifact you can submit by PR for a public leaderboard row |
| **Gated / official** | The full clinical corpus, difficulty splits, and the hidden test set — **not in this repository** | Hosted evaluation or controlled access under written terms | The official scores used for headline comparisons |

The official LAIBench evaluation runs against a larger gated dataset that
is **not** part of this repository. The full clinical corpus, difficulty
splits, hidden test set, answer keys, and private scoring criteria are
private and require a controlled-access or data-use agreement. See
[DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md). Everything described below
about running the harness applies to the public path; the gated path uses
the same harness code on data you do not download.

## What is submitted

A *submission* consists of:

1. **Prediction JSONL** — the frozen outputs of your system, one report
   per case, on a locked public suite.
2. **Run artifact** — the JSON produced by the harness after it scores
   those predictions against the locked suite.
3. **A disclosure** — provenance, track, prompt-disclosure level, cost,
   latency, and conflict-of-interest, supplied in the submission PR.

Predictions are the only thing you hand-author. Run artifacts are
produced by the harness; submitters do not write score fields by hand,
and the leaderboard recomputes them from your predictions before
publishing.

## Output format per case

Each case is one exam descriptor plus concise findings; your system
returns one report as HTML using the allowed report subset (`<center>`,
`<b>`, `<br>`). The command contract and an example payload are described
in [docs/agent-track.md](docs/agent-track.md), and a minimal reference
adapter is [examples/mock-agent.mjs](examples/mock-agent.mjs).

A frozen prediction record must validate against
[schemas/prediction-record.schema.json](schemas/prediction-record.schema.json):

```json
{"instance_id":"R001","model_name_or_path":"example-agent","model_output":"<center><b>TC DE CRANIO</b></center><br><b>Achados</b><br>...","metadata":{"evidenceIds":["public-doc-1"]}}
```

When you carry per-case metadata for the leaderboard (version, provider,
track, cost, latency), use the richer per-case record in
[schemas/submission.schema.json](schemas/submission.schema.json), which
adds `model_version`, `provider`, `inference_date`, `prompt_version`,
`prompt_disclosure`, `scaffold_class`, `track`, `latency_ms`,
`cost_estimate_usd`, and an optional `structured_output` companion.

**Do not** include in any public artifact: prompts, private routes,
credentials, raw retrieved text, hidden judge configuration, private case
content, patient identifiers, or implementation details. Optional
metadata is limited to public-safe identifiers (for example
`evidenceIds`), not raw evidence text.

## Tracks

The track must be declared by the submitter and matches one of:

- `agent` — product systems, custom multi-step workflows, RAG-enabled
  agents, service or browser wrappers.
- `mini-agent` — a hosted model accessed via the canonical minimal
  scaffold.
- `model` — a direct raw-model baseline: no tools, no RAG, no custom
  workflow.

Tracks are not merged into one rank. The harness uses the declared track
as part of the leaderboard comparable key. A mis-declared track violates
policy and causes the row to be moved to the correct track or removed.
Background on the agent track is in [docs/agent-track.md](docs/agent-track.md).

## Running the public path

The only suites shipped in this repository are the *lite* public suites,
which run on the synthetic demo cases:

- `suites/lite-public.pt-BR.json`
- `suites/lite-public.en-US.json`

The CLI is exposed through `npm run bench -- <command>`; convenience
aliases (`npm run validate`, `npm run eval`, `npm run leaderboard`,
`npm run compare`) call the same commands.

### 1. Generate predictions

You can either drive your system live through the command adapter:

```bash
npm run bench -- suite \
  --suite suites/lite-public.pt-BR.json \
  --provider command \
  --cmd "node my-agent.mjs" \
  --run-name my-agent \
  --track agent \
  --out runs/my-agent.json
```

…or, if reports were generated outside the harness, freeze them as a
JSONL file (one record per case) for the frozen-prediction flow below.

### 2. Validate the predictions

```bash
npm run bench -- validate-submission \
  --suite suites/lite-public.pt-BR.json \
  --predictions predictions/my-agent.jsonl
```

Validation fails on missing cases, duplicate IDs, extra IDs, empty
outputs, malformed JSONL, or malformed metadata.

### 3. Evaluate the validated predictions

```bash
npm run bench -- eval-submission \
  --suite suites/lite-public.pt-BR.json \
  --predictions predictions/my-agent.jsonl \
  --run-name my-agent \
  --model-label my-agent \
  --track agent \
  --out runs/my-agent.json
```

Use `--track agent` for product workflows and multi-step agents,
`--track mini-agent` for the canonical scaffold, and `--track model` only
for direct raw-model baselines.

### 4. Build a local leaderboard

```bash
npm run bench -- leaderboard \
  --inputs runs/my-agent.json \
  --out runs/leaderboard.json \
  --markdown runs/leaderboard.md
```

### Reliability (optional but recommended)

A single-shot pass rate saturates and can be gamed by verbose
"restate-everything" reports. To measure **consistency**, run the same
system on the same suite *k* times and compute `pass^k` — the fraction of
cases that preserved every critical finding on all *k* attempts:

```bash
npm run bench -- reliability \
  --inputs runs/run-1.json runs/run-2.json runs/run-3.json \
  --out runs/reliability.json \
  --markdown runs/reliability.md
```

## Scoring and the ranking metric

Per-case quality is summarized across five weighted dimensions, which are
**diagnostic** and surface failure modes:

| Dimension | Weight | Purpose |
| --- | ---: | --- |
| CRIT | 30% | Critical-finding preservation and unsafe-negation checks |
| QUAL | 25% | Clinical quality, finding preservation, hallucination resistance |
| TERM | 20% | Locale, modality, section, and report terminology |
| GUIDE | 15% | Guideline and anatomical coverage expectations |
| RAG | 10% | Evidence fidelity, section order, laterality, levels, and measurements |

The **primary public ranking metric is the strict PASS rate**: a case
passes only when every clinically decisive gate holds (critical-finding
preservation, absence of unsafe negations and contradictions, and the
required structure/guideline gates). Rankings should report a bootstrap
95% confidence interval, and per-dimension scores accompany the strict
PASS rate as diagnostics rather than as the rank.

If a system uses retrieval or external tools, runs that omit retrieval
disclosure cannot be scored on `RAG` and are reported with
`RAG: not applicable`. Full gate semantics and dimension definitions are
in [RUBRIC.md](RUBRIC.md) and the methodology of record,
[docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).

> **Note on methodology references.** The methods of record are in
> [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).
> The "Beyond Templates" preprint is a separate theory paper on report
> variability and does **not** describe this benchmark; do not cite it as
> the benchmark methods.

## Provenance and comparability requirements

Two rows are comparable only when they were scored against the same
locked suite hash, in the same track, under the same scoring mode. A
submission must therefore carry enough provenance for a reader to judge
comparability. The harness records and a leaderboard row should disclose:

- benchmark version and the exact suite hash;
- track, scaffold class, and the evaluated entity (model / agent / product);
- judged vs frozen status and the scoring mode used;
- validation status (counts, not raw ID lists);
- cost and latency;
- the maintainer/vendor relationship where one exists (conflict of interest).

Recommended per-submission provenance fields (supplied in the PR
disclosure, drawn from
[schemas/submission.schema.json](schemas/submission.schema.json)):

- `model_name`, `model_version`, `provider`, `inference_date`
- `prompt_version`, `prompt_disclosure` (`public` | `summary-only` | `withheld`)
- `scaffold_class`, `track`
- `cost_estimate_usd` (or `unknown`), `latency_ms`
- conflict-of-interest statement and a contact email

**Prompt disclosure.** `public` rows publish the template (file path or
permanent URL) and display fully. `summary-only` rows provide a
paraphrase and display with a visible disclosure marker. `withheld` rows
display with a visible "prompt withheld" marker. Vendors who treat
prompts as trade secrets may use `summary-only` or `withheld`; the row is
annotated accordingly rather than hidden.

**Cost and latency.** Cost is reported in USD or `unknown`; the
maintainer does not adjust scores by cost — it is a separate column so a
reader can build their own score/cost trade-off. Latency is per-case wall
time from input handoff to final HTML output, including any internal
retry; retrieval, judge invocation, and post-processing are part of the
system under test and count toward latency.

**Tool and RAG disclosure.** If the system uses retrieval or external
tools, disclose the retrieval index identity (label only), the number of
retrieved items per case, whether retrieval was deterministic or
model-driven, and which tools were called (label only) — never raw
retrieved content.

## Comparability discipline

- Suite hashes change only when the suite content changes. When that
  happens, all prior runs against that suite become incomparable, and a
  row must be re-evaluated to appear under the new suite hash. The
  harness does not retroactively re-score old artifacts.
- Do not report superiority without a paired comparison on the same suite
  hash (use `npm run bench -- compare`).
- Treat dry-run or mock output as smoke-only, never as product quality.

## Avoiding test-set leakage

A submitter must not:

- train, fine-tune, or in-context-prompt the system using LAIBench cases;
- use scoring rubrics, gold findings, or guideline expectations as
  in-context examples;
- use LAIBench judge prompts as a training signal.

The harness includes contamination and canary checks; a submission
suspected of leakage is moved to a "flagged" section pending discussion
rather than silently ranked. The same prohibition applies, in stronger
form, to any gated data accessed under a controlled-access agreement (see
[DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md)).

## How to open the submission PR

1. Generate, validate, and evaluate predictions against a public *lite*
   suite as shown above, producing `runs/<run-name>.json`.
2. Keep the frozen predictions alongside the run artifact (for example
   `runs/<run-name>.predictions.jsonl`) so the score can be recomputed.
3. Write a short disclosure with the provenance fields above, including
   the conflict-of-interest statement and contact email.
4. Open a PR titled `submission: <system> on <suite>`, including the run
   artifact, the frozen predictions, the disclosure, a brief description
   in the PR body, and a confirmation that you have read
   [GOVERNANCE_AND_PRIVACY.md](GOVERNANCE_AND_PRIVACY.md).

## Review

A submission PR is reviewed for:

- a validation pass (`validate-submission`);
- score-recomputation match — `leaderboard` / `compare` recompute case
  overalls, the suite summary, verdict counts, per-dimension means, the
  comparable key, and the local suite hash from your predictions, and the
  recomputed values must match the submitted run JSON;
- disclosure completeness;
- a conflict-of-interest declaration.

A submission is merged when the harness recomputation matches the
submitted run and the disclosure is complete.

## Rejection

A submission is rejected when predictions fail validation, recomputation
differs from the submitted scores, required disclosure fields are
missing, the submission appears to leak benchmark content, or a run
artifact appears manually edited to inflate scores. Rejections are
documented in the PR thread and are not exposed on the public
leaderboard.

## Withdrawal and re-evaluation

A submitter may withdraw a row via a PR that removes the run files and
notes the withdrawal date and reason. Withdrawn rows do not reappear
under the same `(model_version, prompt_version)` pair. When a suite's
content changes, prior runs become incomparable and re-evaluation against
the new suite hash is required for a row to appear.

## Reproducibility status

LAIBench is an evolving framework. As of this version:

- There is **no published human inter-rater reliability** for the gates
  and quality labels yet; gold findings in the public methods are
  heuristically derived, not radiologist-adjudicated. See
  [docs/radiologist-adjudication-protocol.md](docs/radiologist-adjudication-protocol.md)
  for the adjudication direction.
- There is **no minted DOI** for the benchmark yet.

State these as not yet published when comparing systems.

## Contact

Questions, controlled-access requests, and disclosure concerns:
**oi@laudos.ai**. See also [SECURITY.md](SECURITY.md) for vulnerability
reporting and [CITATION.cff](CITATION.cff) for how to cite this work.
