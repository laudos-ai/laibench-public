# LAIBench Methods Paper (arXiv-style draft)

This directory contains the canonical **LAIBench benchmark methods paper**:

> **LAIBench: A Governance-Oriented Benchmark for Critical-Finding Safety and
> Reliability in AI Radiology Report Generation**

## What this paper is

A rigorous, reviewer-defensible description of the LAIBench *benchmark
methodology*: the task definition, the five-dimensional scoring model with the
critical-finding hard veto, the planned `pass^k` reliability headline, the eight
adversarial perturbation classes (metric-validation-by-construction), the
statistical methodology (kappa / Krippendorff alpha, paired-bootstrap
discrimination, judge calibration), the reproducibility hash chain, and the
leaderboard-integrity / anti-gaming layer. It is hedged throughout and states its
scope and limitations up front.

## What this paper is NOT

- It is **not** the *Beyond Templates* theory paper (RSLB / RRVI report-space
  variability). That is a **separate** work under
  [`../arxiv-laibench/`](../arxiv-laibench/) and is unrelated to this benchmark
  methods paper. Do not conflate the two.
- It is **not** a clinical validation, a medical-device claim, or a
  diagnostic-accuracy study.

## Scope (stated up front, not buried)

LAIBench evaluates the **finding-text-to-report** task: given an exam descriptor
and concise findings, produce a faithful report. It **does not evaluate primary
image interpretation from DICOM**. It therefore measures **report faithfulness,
transcription safety, and run-to-run reliability** — it catches *dropped /
inverted / fabricated handed-in findings*, not *missed-on-image findings*. For
that reason the paper avoids "malpractice" / "patient-harm" framing.

## Honesty / hedging commitments reflected in the text

- The critical-finding detector is currently **keyword/substring-based**; a
  validated extractor (e.g. GREEN-based) plus a radiologist-correlation study is
  the validation roadmap, not a completed result.
- `QUAL` **approximates** entity recall via synonym-expanded keyword overlap
  rather than a trained extractor — validation pending.
- LLM-judge reliability **vs. radiologists is not yet measured**; only judge
  self-consistency and det-vs-judge coherence are.
- There are **no real-data results**; all current numbers are on a small
  **synthetic demo suite**.
- The benchmark is **vendor-built**; this is disclosed as a threat to validity.

## Files

| File             | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `main.tex`       | The paper source (`\documentclass[11pt]{article}`).            |
| `references.bib` | Bibliography. Uncertain entries carry `% TODO verify` comments. |
| `README.md`      | This file.                                                     |

## Building

Standard, dependency-light toolchain (no exotic styles):

```bash
pdflatex main
bibtex   main
pdflatex main
pdflatex main
```

Packages used: `inputenc`, `fontenc`, `amsmath`/`amssymb`/`amsfonts`, `booktabs`,
`array`, `geometry`, `hyperref`, `enumitem`, `xcolor`, `microtype`. Bibliography
style `plain`.

## Source-of-truth alignment

Every methodological claim is grounded in the repository source so it can be
audited:

- Scoring model & gate semantics: `src/scoring.ts` (`WEIGHTS`, `combineScores`,
  conservative-min).
- Policy profiles: `src/policies.ts` (`strict` / `research` / `leaderboard`).
- Evaluators: `src/evaluators/{crit,qual,guide,rag,structural}.ts`.
- Adversarial perturbations: `src/perturb.ts`, `src/perturb-eval.ts`.
- Inter-rater stats: `src/kappa.ts` (canonical ordered-pair Krippendorff alpha).
- Judge calibration: `src/calibrate.ts`.
- Discrimination: `src/discriminate.ts` (paired bootstrap, double-gated).
- Provenance hash chain: `src/provenance.ts`.
- Governance docs: `docs/laibench-leaderboard-methods.md`,
  `docs/radiologist-adjudication-protocol.md`.

## Submission status

Draft for human review. Authors, affiliations, corresponding contact, license
choice, and ethics/IRB language must be confirmed before any arXiv submission.
`pass^k` is described as the intended reliability **headline**: it is implemented
in the harness (`src/reliability.ts`) but is not yet the default leaderboard
headline, and **no measured `pass^k` values are reported** because there are no
real-data runs.
