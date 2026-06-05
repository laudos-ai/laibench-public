# LAIBench

LAIBench is a governance-oriented benchmark framework for AI-assisted radiology reporting.

**LAIBench is a technical benchmark framework, not a medical device, not regulatory approval, and not clinical validation. It must not be used as the sole basis for clinical deployment decisions. All references below are to that technical scope.**

Website: [laibench.laudos.ai](https://laibench.vercel.app)  
Companion paper (conceptual): *Beyond Templates: A Compositional Model and Lower Bound for Radiology Report Variability* — [PDF](site/laibench-preprint.pdf), [arXiv source](submissions/arxiv-laibench/)  
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

## What It Evaluates

LAIBench evaluates reporting behavior from provided text evidence. The current public harness focuses on whether a system can convert an exam descriptor and concise findings into a faithful radiology report under the public contract. It is **not** primary image interpretation.

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

The only public cases in this repository are synthetic demo cases under [cases/public/synthetic-demo.pt-BR.json](cases/public/synthetic-demo.pt-BR.json). They are for installation checks, smoke tests, and harness verification.

The full clinical corpus is private/gated. The hidden test set is private. Official evaluation requires hosted evaluation or controlled access under written terms. See [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md).

## Scoring

LAIBench reports weighted finding-to-report scores and strict gate outcomes. A high average score should not hide critical failures. Critical finding omissions, unsafe negations, contradictions, unsupported normalcy, and structural errors trigger failure gates.

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

A single-shot critical-finding pass-rate saturates and is gameable by verbose "restate everything" reports. The `reliability` command measures **consistency** instead: run the same system on the same suite three times and report how often it produces identical verdicts per case.

```bash
npm run bench -- reliability \
  --inputs runs/run-1.json runs/run-2.json runs/run-3.json \
  --out runs/reliability.json \
  --markdown runs/reliability.md
```

## Frozen Predictions

Use predictions mode when reports were generated outside the harness. The public submission contract is documented in [docs/public-submissions.md](docs/public-submissions.md); each JSONL line follows the `PredictionInput` schema.

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

Leaderboard rows should disclose benchmark version, suite hash, track, scaffold class, judged/frozen status, evaluated entity, validation status, cost, latency, and the scoring mode used. Incompatible runs are separated by track, scaffold, locale, and suite hash.

Public artifacts must not include private prompts, product routes, credentials, private file paths, raw validation ID lists, private case content, hidden judge configuration, answer keys, or proprietary schemas beyond the public contract.

## arXiv Status

The paper material is draft-ready for human review, not automatic submission. arXiv submission remains blocked until authors, affiliations, corresponding contact, conflicts, ethics/IRB/CEP language, and license choice are finalized.

## License

This public framework repository is licensed under the terms in [LICENSE](LICENSE). The clinical corpus, gated datasets, hidden tests, answer keys, private scoring criteria, and protected materials are proprietary to Laudos.AI.
