# LAIBench

[![CI](https://github.com/laudos-ai/laibench-public/actions/workflows/ci.yml/badge.svg)](https://github.com/laudos-ai/laibench-public/actions/workflows/ci.yml)
[![License: Source-Available](https://img.shields.io/badge/license-Source--Available-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-green.svg)](CHANGELOG.md)
[![Tests](https://img.shields.io/badge/tests-231%20passing-brightgreen.svg)](#)
[![Safety](https://img.shields.io/badge/scope-not%20a%20medical%20device-important.svg)](#)

LAIBench is a governance-oriented benchmark framework for AI-assisted radiology reporting. It measures whether a reporting system **preserves clinically decisive findings** — the patient-safety failure modes that text-similarity metrics (BLEU/ROUGE) miss — and reports a strict, auditable pass/fail gate rather than a single averaged score.

**LAIBench is a technical benchmark framework, not a medical device, not regulatory approval, and not clinical validation. It must not be used as the sole basis for clinical deployment decisions. All clinical use requires qualified human oversight, local validation, institutional governance, and applicable legal/regulatory review.**

Website: [laibench.laudos.ai](https://laibench.laudos.ai)  
Companion paper (conceptual): *Beyond Templates: A Compositional Model and Lower Bound for Radiology Report Variability* — [PDF](site/laibench-preprint.pdf), [arXiv source](submissions/arxiv-laibench/main.tex). This is a **separate** theory paper on radiology report-space variability (RSLB / RRVI); it does **not** describe the LAIBench benchmark. The dedicated LAIBench methods paper (task, evaluators, gate semantics, validation) is forthcoming — until then, the methodology of record is [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).  
By: [Laudos.AI](https://laudos.ai)

## Current Status

This repository is a public-safe technical preview export. It contains code, schemas, documentation, site assets, paper draft materials, and a tiny synthetic demo suite.

It does not include:

- raw clinical reports;
- the full clinical corpus;
- clinical CSV/XLSX/DICOM/NIfTI files;
- hidden test sets;
- answer keys;
- private scoring criteria;
- gated evaluation artifacts.

## Documentation

Start here, then go deep:

| Topic | Document |
| --- | --- |
| What the benchmark is, scope, metrics, versioning | [BENCHMARK_CARD.md](BENCHMARK_CARD.md) |
| How a system is evaluated (input/output contracts, gates) | [EVALUATION_PROTOCOL.md](EVALUATION_PROTOCOL.md) |
| Per-dimension PASS/PARTIAL/FAIL criteria | [RUBRIC.md](RUBRIC.md) |
| How to submit / evaluate your system | [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md) · [docs/public-submissions.md](docs/public-submissions.md) |
| Methodology of record (leaderboard) | [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md) |
| What data ships vs. what is gated | [DATASET_CARD.md](DATASET_CARD.md) · [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md) |
| Conflict-of-interest, anti-gaming, privacy posture | [GOVERNANCE_AND_PRIVACY.md](GOVERNANCE_AND_PRIVACY.md) |
| Known limitations | [LIMITATIONS.md](LIMITATIONS.md) |
| Data contracts (JSON Schema) | [schemas/](schemas/) |
| Contributing, security, conduct | [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Licensing & trademark | [LICENSE](LICENSE) · [LICENSE_POLICY.md](LICENSE_POLICY.md) · [TRADEMARK.md](TRADEMARK.md) |

## Repository map

```
src/            TypeScript harness: CLI, scoring, evaluators/, providers/, locales/, stats
schemas/        JSON Schema data contracts (case, submission, prediction-record, score, leaderboard)
suites/         Public suite manifests (lite-public.*) — synthetic demo only
cases/public/   Synthetic demo cases (the only clinical-style data in this repo)
examples/       Reference adapters (e.g. mock-agent.mjs)
docs/           Methods, protocols, migration, agent track
submissions/    Paper sources (separate "Beyond Templates" theory paper + methods draft)
site/           Public website assets
```

## What It Evaluates

LAIBench evaluates reporting behavior from provided text evidence. The current public harness focuses on whether a system can convert an exam descriptor and concise findings into a faithful radiology-style report while preserving clinically relevant information.

The framework is intended to make failure modes visible:

- clinically relevant omissions;
- hallucinated or unsupported findings;
- factual contradictions;
- critical-finding preservation;
- structured-report compliance;
- privacy hygiene;
- auditability of submissions and leaderboard rows.

The current public demo does not evaluate primary image interpretation from DICOM studies. It is not a diagnostic accuracy study and does not prove clinical safety.

## Public Data Boundary

The only public cases in this repository are synthetic demo cases under [cases/public/synthetic-demo.pt-BR.json](cases/public/synthetic-demo.pt-BR.json). They are for installation checks, smoke tests, and framework review.

The full clinical corpus is private/gated. The hidden test set is private. Official evaluation requires hosted evaluation or controlled access under written terms. See [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md).

## Scoring

LAIBench reports weighted finding-to-report scores and strict gate outcomes. A high average score should not hide critical failures. Critical finding omissions, unsafe negations, contradictions, unsupported normalizing language, and guideline/structure failures remain visible as separate error gates.

| Dimension | Weight | Purpose |
| --- | ---: | --- |
| CRIT | 30% | Critical finding preservation and unsafe-negation checks |
| QUAL | 25% | Clinical quality, finding preservation, hallucination resistance |
| TERM | 20% | Locale, modality, section, and report terminology |
| GUIDE | 15% | Guideline and anatomical coverage expectations |
| RAG | 10% | Evidence fidelity, section order, laterality, levels, and measurements |

## Quickstart

```bash
npm ci
npm test
npm run typecheck
npm run smoke:mock
npm run smoke:leaderboard
```

Run the synthetic demo suite with a local command adapter:

```bash
npm run bench -- suite \
  --suite suites/lite-public.pt-BR.json \
  --provider command \
  --cmd "node examples/mock-agent.mjs" \
  --run-name mock-agent \
  --track mini-agent \
  --out runs/mock-agent.json
```

A parallel English demo suite is available at `suites/lite-public.en-US.json` (cases in `cases/public/synthetic-demo.en-US.json`) — both are synthetic-only.

Build a local leaderboard from run artifacts:

```bash
npm run bench -- leaderboard \
  --inputs runs/mock-agent.json \
  --out runs/leaderboard.json \
  --markdown runs/leaderboard.md
```

### Reliability (pass^k)

A single-shot critical-finding pass-rate saturates and is gameable by verbose "restate everything" reports. The `reliability` command measures **consistency** instead: run the same system on the same suite *k* times, then compute `pass^k` — the fraction of cases that preserved every critical finding on **all** *k* attempts (the headline), alongside `pass@1` and a verdict-level pass^k.

```bash
npm run bench -- reliability \
  --inputs runs/run-1.json runs/run-2.json runs/run-3.json \
  --out runs/reliability.json \
  --markdown runs/reliability.md
```

## Frozen Predictions

Use predictions mode when reports were generated outside the harness. The public submission contract is documented in [docs/public-submissions.md](docs/public-submissions.md); each JSONL line follows [schemas/prediction-record.schema.json](schemas/prediction-record.schema.json).

```bash
npm run bench -- validate-submission \
  --suite suites/lite-public.pt-BR.json \
  --predictions predictions/my-agent.jsonl

npm run bench -- eval-submission \
  --suite suites/lite-public.pt-BR.json \
  --predictions predictions/my-agent.jsonl \
  --run-name my-agent \
  --model-label my-agent \
  --track mini-agent \
  --out runs/my-agent.json
```

## Leaderboard Governance

Leaderboard rows should disclose benchmark version, suite hash, track, scaffold class, judged/frozen status, evaluated entity, validation status, cost, latency, and the scoring mode used. Incompatible runs must not be mixed as equivalent comparisons.

Public artifacts must not include private prompts, product routes, credentials, private file paths, raw validation ID lists, private case content, hidden judge configuration, answer keys, or private scoring criteria.

## arXiv Status

The paper material is draft-ready for human review, not automatic submission. arXiv submission remains blocked until authors, affiliations, corresponding contact, conflicts, ethics/IRB/CEP language, repository URL, release tag, DOI, and license language are confirmed.

## Citation

If you use LAIBench, please cite it. Machine-readable metadata is in [CITATION.cff](CITATION.cff); until a DOI/preprint is published, cite the repository at the most recent tagged release:

```bibtex
@software{laibench_2026,
  title  = {LAIBench: a governance-oriented benchmark for AI-assisted radiology reporting},
  author = {{Laudos.AI}},
  year   = {2026},
  version = {2.0.0},
  url    = {https://github.com/laudos-ai/laibench-public}
}
```

## License

This public framework repository is source-available under the terms in [LICENSE](LICENSE). The clinical corpus, gated datasets, hidden tests, answer keys, private scoring criteria, and protected evaluation artifacts are not licensed for public reuse and are not part of this repository.
