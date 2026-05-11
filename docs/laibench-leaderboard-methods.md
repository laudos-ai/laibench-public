# LAIBench: Leaderboard And Private Daily Evaluation Protocol

## Summary

LAIBench evaluates radiology finding-to-report systems with locked suites, deterministic clinical checks, optional frozen judging, clinical-score reporting, and strict error gates. It is designed to compare executable reporting systems while keeping private implementation details out of public artifacts.

The private daily split contains 40 cases sampled from a local synthetic 65,812-report source corpus extrapolated from approximately 400 extractive seeds after modality, extractability, and deterministic privacy-pattern filtering. These are not real patient reports. The source corpus is not committed.

## Clinical Task

```text
Input: exam descriptor + main radiology findings
Output: complete radiology report using only <center>, <b>, and <br>
```

## Dataset Construction

The private daily builder:

1. reads local exam, modality, region, and report text fields;
2. keeps supported modalities;
3. maps source regions into benchmark categories;
4. removes obvious privacy patterns;
5. extracts the findings or analysis section;
6. derives candidate gold findings from sentence-level findings;
7. marks critical findings with conservative deterministic heuristics;
8. samples a stratified 40-case split across modality-region buckets.

Only the capped private split is committed. The source corpus is not public.

## Current Audit Snapshot

| Metric | Value |
| --- | ---: |
| Source rows | 65,812 |
| Eligible rows after modality, length, and privacy filters | 2,433 |
| Private daily cases | 40 |
| Dataset readiness score | 76/100 |
| Privacy scan hits in selected cases | 0 |

The readiness score is an engineering score, not a clinical validity score.

## Benchmark Design Principles

1. **Multi-level domain competence.** The suite separates critical findings, clinical quality, terminology, guideline coverage, and evidence fidelity.
2. **Executable verification.** Every run produces machine-readable artifacts, deterministic checks, a canary, and a benchmark card.
3. **Private holdout discipline.** Private cases are not public marketing assets and must not leak into public pages, training data, prompt examples, or partner materials.
4. **Score-first reporting with strict gates.** Clinical score is primary; strict PASS/error rates explain gate failures.
5. **Track separation.** Product agents, custom agents, mini-agent scaffolds, and raw models are not merged into one rank.

## Evaluation Dimensions

| Dimension | Purpose |
| --- | --- |
| CRIT | Preserve and correctly surface critical findings |
| QUAL | Preserve clinical findings and avoid hallucinated report content |
| TERM | Enforce modality and locale-specific terminology |
| GUIDE | Check anatomical and guideline-oriented coverage |
| RAG | Preserve title tokens, evidence, laterality, levels, measurements, and order |

When optional judging is enabled, the run must declare its scoring mode. `judge-primary` uses the pinned LLM judge for the primary 0-100 report-quality score while deterministic critical checks remain gates. `conservative-min` remains available for regression calibration, where the combined dimension score is the lower of deterministic and judge scores.

## Daily Product Run

The private daily run targets the complete product reporting flow and writes frozen artifacts before any score is used in public or admin surfaces. Direct model baselines can be run separately, but they are not product-agent scores.

The scheduled workflow should run from a private worker. Runtime credentials, product targets, hidden judge configuration, and private prompts must remain outside committed files and outside public artifacts.

## Operator Summary And Improvement Loop

The daily workflow writes a complete result JSON, benchmark-card audit, deterministic improvement suggestions, and an admin weekly-best snapshot when publishing is due.

The improvement suggestion script does not fabricate model insight. It maps observed failure clusters to concrete engineering work such as critical-finding extraction, modality terminology linting, measurement preservation, and anatomy coverage checks.

## Public Leaderboard Reporting

Public leaderboard rows should report:

- number of cases and exact suite hash;
- modality and anatomical-region distribution;
- evaluated company, model, or agent name;
- system type: product agent, custom agent, mini-agent, or raw model;
- comparable class and scaffold class;
- deterministic or frozen judged scoring mode;
- clinical score, strict PASS/error rate, per-dimension scores, and non-fail rate;
- bootstrap confidence intervals for paired comparisons when available;
- failure taxonomy for worst-performing dimensions;
- validation counts and sanitized ineligibility reasons, not raw ID lists;
- privacy and exclusion criteria.

Leaderboard generation is not allowed to trust edited summary fields. The CLI recomputes case overalls, suite summaries, verdict counts, per-dimension means, comparable keys, and local suite hashes before publishing. If a run JSON has been manually edited to inflate `averageOverall`, strict PASS, non-fail rate, per-dimension means, or comparable metadata, `leaderboard` and `compare` fail before producing public output.

Do not expose private routes, prompts, provider configuration, credentials, private file paths, raw validation ID lists, private case content, hidden judge implementation, or other implementation details that are not required for benchmark reproducibility. Do not report superiority without paired testing on the same suite hash.

## Limitations

- Gold findings are heuristically derived from reports, not fully radiologist-adjudicated labels.
- The privacy filter is deterministic pattern filtering, not a formal de-identification certification.
- The 40-case private split is designed for daily regression monitoring, not as a final public benchmark.
- Critical findings are identified by keyword heuristics and can miss phrasing variants.
- The benchmark evaluates generated text, not downstream clinical outcomes.

## Future Work Before Stronger Public Claims

1. Add manual radiologist adjudication for a locked subset.
2. Add inter-rater agreement for critical finding and quality labels.
3. Add judge calibration against radiologist review.
4. Add paired comparison reports for product-flow changes.
5. Add a locked external validation split that is never used for system iteration.
6. Document public scaffold class for every submitted result without exposing private prompts.
7. Report benchmark-card actionability with every score.

## Claim Discipline

Acceptable wording:

- "private daily regression-monitoring suite";
- "sampled and filtered from a synthetic 65,812-report source corpus derived from extractive seeds";
- "deterministic privacy-pattern filtering";
- "heuristically derived gold findings";
- "public leaderboard protocol."

Avoid unless separately proven:

- "fully anonymized" without a formal de-identification audit;
- "radiologist-adjudicated" without recorded review;
- "clinical-grade" without prospective validation;
- public exposure of private prompts, product routes, provider configuration, credentials, or judge implementation.
