<p align="center">
  <a href="https://laibench.laudos.ai"><img src="assets/banner.png" alt="LAIBench — benchmark for AI-assisted radiology reporting" width="100%"></a>
</p>

<h1 align="center">LAIBench</h1>

<p align="center">
  <strong>A governance-oriented benchmark for AI-assisted radiology report generation.</strong><br>
  Turn an exam descriptor + concise findings into a faithful report — scored where it matters clinically, not on prose.
</p>

<p align="center">
  <a href="https://github.com/Vajbratya/laibench-public/actions/workflows/ci.yml"><img src="https://github.com/Vajbratya/laibench-public/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-111111.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/benchmarkVersion-3.10.0-0e7c7b" alt="benchmark version 3.10.0">
  <img src="https://img.shields.io/badge/tests-444%20passing-2ea44f" alt="444 tests passing">
  <img src="https://img.shields.io/badge/node-20%20%7C%2022-111111" alt="Node 20 | 22">
  <img src="https://img.shields.io/badge/dependencies-zero%20runtime-0e7c7b" alt="zero runtime dependencies">
</p>

<p align="center">
  <a href="https://laibench.laudos.ai">Website</a> ·
  <a href="docs/laibench-leaderboard-methods.md">Methodology</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="https://laudos.ai">By Laudos.AI</a>
</p>

---

> **LAIBench is a technical benchmark framework — not a medical device, not regulatory approval, and not clinical validation.** It must not be used as the sole basis for clinical deployment decisions. Everything below is within that technical scope.

## Why LAIBench

Most "report quality" benchmarks reward fluent prose. A confidently-written report that **misses a pneumothorax** can score well. LAIBench is built so that **cannot happen**:

- **Hard critical-finding veto.** A missed or fabricated critical finding caps the score and forces `FAIL` — no matter how polished the rest of the report is. Form never rescues substance.
- **No prose/aesthetic axis.** There is no standalone style, fluency, or "communication quality" dimension. The only discourse-adjacent signals (hedging, verbosity) are minor, non-gating, and apply only on the no-gold fallback path.
- **Conservative combination.** The combined dimension score is `MIN(deterministic, judge)` — an optional LLM judge can lower a score but never inflate past the deterministic gate.
- **Anti-compensation.** Strong terminology/coverage cannot lift a clinically weak report into a PASS band.
- **Tamper-resistant numbers.** Every loaded run is re-scored through the gated combiner; a run whose stored verdict disagrees with the re-derived one is rejected, so a relabeled critical-miss can never inflate the public leaderboard.
- **Provenance.** A `scoringHash` (over the gate-deciding source files) and a cases-only `suiteHash` pin exactly what produced each number.

Pure TypeScript, **zero runtime dependencies**, deterministic checks, optional frozen judging, bootstrap CIs, McNemar / Cohen's *h*.

## What it evaluates

LAIBench evaluates reporting behavior from provided **text evidence**: whether a system can convert an exam descriptor and concise findings into a faithful radiology report under the public contract. It is **not** primary image interpretation.

It makes failure modes visible: clinically relevant omissions, hallucinated/unsupported findings, factual contradictions, critical-finding preservation, structured-report compliance, terminology and report-language compliance, privacy hygiene, and auditability.

## Scoring

| Dimension | Weight | Purpose |
| --- | ---: | --- |
| **CRIT** | 30% | Critical-finding preservation and unsafe-negation checks |
| **QUAL** | 25% | Clinical quality, finding preservation, hallucination resistance, impression synthesis |
| **TERM** | 20% | Locale, modality, section, terminology, and report-language contract |
| **GUIDE** | 15% | Guideline and anatomical coverage expectations |
| **RAG** | 10% | Evidence fidelity, section order, laterality, levels, and measurements |

Critical-finding omissions, unsafe negations, contradictions, unsupported normalcy, wrong report language, and structural errors trigger **failure gates** — a high average score cannot hide them. See [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md).

## Quickstart

```bash
npm ci
npm run typecheck
npm test
npm run guard:public        # public-release safety gate
npm run smoke:mock          # run the synthetic en-US suite with a bundled mock agent
npm run smoke:leaderboard   # build a leaderboard from the run
```

Run the synthetic public en-US suite with a local command adapter:

```bash
npm run bench -- suite \
  --suite suites/lite-public.en-US.json \
  --provider command \
  --cmd "node examples/mock-agent.mjs" \
  --run-name mock-agent \
  --track agent \
  --out runs/mock-agent.json
```

### Benchmark your own agent

Any agent that reads a JSON job on **stdin** and writes the report HTML to **stdout** works with the `command` provider — no SDK required:

```bash
npm run bench -- suite \
  --suite suites/lite-public.en-US.json \
  --provider command \
  --cmd "node path/to/your-agent.mjs" \
  --run-name my-agent --track agent \
  --entity-name "My Lab" --entity-type org --system-type product-agent \
  --out runs/my-agent.json
```

`examples/mock-agent.mjs` is a minimal reference adapter. OpenRouter and any OpenAI-compatible endpoint are also supported (`--provider openrouter` / `--provider openai-compatible`); `examples/smoke-openai-compatible.mjs` shows the shape.

### Reliability (pass^k)

```bash
npm run bench -- reliability \
  --inputs runs/run-1.json runs/run-2.json runs/run-3.json \
  --out runs/reliability.json --markdown runs/reliability.md
```

### Frozen predictions

```bash
npm run bench -- eval-submission \
  --suite suites/lite-public.en-US.json \
  --predictions predictions/my-agent.jsonl \
  --run-name my-agent --track agent --out runs/my-agent.json
```

Each JSONL line follows the prediction record schema (`instance_id`, `model_output`). See [docs/public-submissions.md](docs/public-submissions.md).

## Calibration controls

The public stratified page is a **reference-vs-null sanity check**: it verifies the harness is not inverted by comparing public reference reports against a fixed unsafe null baseline. That is a sanity check, not a claim that the null baseline measures realistic model degradation. Dose-response controls require answer-key material and are generated only inside the controlled environment; public releases publish aggregate calibration summaries only — never case-level predictions or gold labels.

## Open vs controlled (read this before citing)

Two distinct artifacts exist, and only one is open:

- **LAIBench (public).** The open, downloadable, openly-reproducible set.
- **Controlled pt-BR suite.** A gated, **aggregate-only** suite. Case JSON, answer keys, frozen predictions, and provenance are **not** distributed here and cannot be reconstructed from this repository. Cite its numbers only as controlled, aggregate-only results locked to a specific suite hash and case count.

Do not attach "open benchmark" language to the controlled suite.

## Case provenance

The public demonstration cases under `cases/public/` are **synthetic and input-only** (every case is flagged `synthetic: true`). The controlled pt-BR cases are synthetic and were authored and reviewed by **senior radiologists in São Paulo, SP, Brazil**. Synthetic authorship and internal senior-radiologist review are a **data-quality process, not an independent third-party validation**; external inter-rater adjudication is tracked as future work and is not claimed here. A radiologist-review claim on any public score is gated by `npm run guard:public` and `npm run laibench:validate-adjudication`.

## Data boundary

This repository ships **synthetic, public-safe** material only — code, schemas, docs, the site, and a tiny synthetic demo suite. It contains **no** raw clinical reports, private corpus, hidden test sets, answer keys, private scoring criteria, credentials, or internal tooling. The boundary is enforced by `npm run guard:public` (and `guard:private`) in CI. See [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md).

## Contributing & security

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to propose scoring/methodology changes.
- [SECURITY.md](SECURITY.md) — report vulnerabilities privately.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Citation

```bibtex
@software{laibench,
  title  = {LAIBench: a governance-oriented benchmark for AI-assisted radiology reporting},
  author = {{Laudos.AI}},
  year   = {2026},
  url    = {https://laibench.laudos.ai}
}
```

Companion (conceptual): *Beyond Templates: A Compositional Model and Lower Bound for Radiology Report Variability*.

## License

Released under the [MIT License](LICENSE). It applies to the public code, schemas, documentation, examples, synthetic demo cases, and tooling in this repository. It does **not** apply to the private clinical corpus, gated datasets, hidden test sets, answer keys, private scoring criteria, or protected evaluation artifacts — none of which are included here.
