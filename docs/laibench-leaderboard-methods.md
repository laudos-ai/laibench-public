# LAIBench: Leaderboard And Private Daily Evaluation Protocol

## Summary

LAIBench evaluates radiology finding-to-report systems with locked suites, deterministic clinical checks, optional frozen judging, clinical-score reporting, and strict error gates. It is designed to compare executable reporting systems while keeping private implementation details out of public artifacts.

The private daily split contains controlled cases sampled from a local synthetic controlled non-distributed source corpus extrapolated from approximately 400 extractive seeds after modality, extractability, and deterministic privacy-pattern filtering. These are not real patient reports. The source corpus is not committed.

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
8. samples a stratified controlled split across modality-region buckets.

Only the capped private split is committed. The source corpus is not public.

## Current Audit Snapshot

| Metric | Value |
| --- | ---: |
| Source rows | not distributed |
| Eligible rows after modality, length, and privacy filters | 2,433 |
| Private controlled cases | not distributed |
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

**No prose/aesthetic axis.** LAIBench deliberately has no standalone style, readability, fluency, or "communication quality" dimension, and form never rescues substance: a missed or fabricated critical finding is a hard veto regardless of how well-written a report is. The only discourse-adjacent signals (e.g. hedging ratio and verbosity) are `minor`, non-gating heuristics that apply **only on the no-gold structural-fallback path** when no reference report is available; they cannot lift a clinically weak report into PASS and are not exposed as a scored prose axis. The same holds, from v3.11.0, for reporting conventions on that path: the anatomical-coverage checklist (G checks), preferred-term and forbidden-opener lists (T/TO checks), conclusion copy-over (Q10), an umbrella phrase in the conclusion (C02), measurements in the conclusion (C05) and a short analysis of a normal study (Q12) are `minor`. They lower their dimension score but never cap a report into FAIL; a convention is not a clinical error. This is a deliberate departure from style-weighted benchmarks where eloquence can mask clinical error.

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

## Input-Only (No-Gold) Path: Source-Anchored Gates (v3.11.0)

Public synthetic cases ship without answer keys, and so do most cases a lab writes for its own agent. On that path the **input findings are the evidence**, and since v3.11.0 four structural checks anchor the score to them:

| Check | Dim | Severity | Rule |
| --- | --- | --- | --- |
| C09 | CRIT | critical | Every critical finding the input affirms is preserved in the report body: present, affirmed (not denied) and on the same side. Side must be stated for side-defining criticals (pneumothorax, fracture, bleed, torsion, stroke); a contradicted side always fails; sides are ignored for non-lateral criticals (free air, obstruction, dissection, midline shift). |
| C10 | CRIT | critical | The report affirms no critical finding the input does not back — neither a new critical nor a critical moved to the other side. Recommendation and differential sentences are not counted; an entailed broader finding (midline shift ⇒ mass effect, tension pneumothorax ⇒ pneumothorax) is allowed. |
| Q16 | QUAL | major | Each abnormal input finding is reflected in the report body (paraphrase-tolerant: whole clause ≥ 40%, a sub-clause ≥ 60%, or its diagnosis ≥ 50% lexical coverage, and not denied). One failing check per missing finding. Pertinent negatives, normal statements (including postfix forms such as "Gallbladder without stones"), recommendations, indications and resolved findings are not abnormal findings. |
| Q17 | QUAL | critical | Unsupported normalcy: the input is abnormal but the report reflects none of its abnormal findings. |

The report **title and Technique section are excluded** from these checks because they restate the exam, which often names the clinical question ("CT angiography *for pulmonary embolism*"). Negation is clause-scoped and, since v3.11.0, **list-scoped**: "No effusion, consolidation, or pneumothorax" / "Sem derrame, consolidação ou pneumotórax" denies every item, but "No effusion, small right pneumothorax" stays affirmed.

On the gold path the CRIT and QUAL evaluators own those dimensions and these four checks are not in the structural gate allowlist, so they never reach a gold-labelled verdict (tested). The list-scoped negation fix and the extended critical vocabulary do apply to both paths.

**Public discrimination ladder.** `scripts/public-ladder.ts` measures, on the 49 public cases and without answer keys, whether the score falls as a report gets worse: a template reference report is degraded by exactly one error per rung (measurement drift, non-critical omission, laterality swap, critical denied, critical omitted, critical fabricated, null report) and every report is scored against the original case. Results are published in [`public-ladder.md`](public-ladder.md) and on the website; under v3.11.0 every critical rung is vetoed in 100% of applicable cases and the null report never passes.

## Limitations

- Gold findings are heuristically derived from reports, not fully radiologist-adjudicated labels.
- The privacy filter is deterministic pattern filtering, not a formal de-identification certification.
- The controlled private split is designed for daily regression monitoring, not as a final public benchmark.
- Critical findings are identified by keyword heuristics and can miss phrasing variants. v3.11.0 widens the common paraphrases (e.g. "dissection of the descending aorta", "acute left MCA territory infarct") and freezes 20 paraphrased correct reports as a regression test, but the matcher remains lexical.
- On the input-only path, finding preservation (Q16) is lexical coverage, not entity matching; a correct report that paraphrases a purely descriptive finding into an unrelated term can still be flagged (major, never a veto on its own).
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
- "sampled and filtered from a synthetic controlled non-distributed source corpus derived from extractive seeds";
- "deterministic privacy-pattern filtering";
- "heuristically derived gold findings";
- "public leaderboard protocol."

Avoid unless separately proven:

- "fully anonymized" without a formal de-identification audit;
- "radiologist-adjudicated" without recorded review;
- "clinical-grade" without prospective validation;
- public exposure of private prompts, product routes, provider configuration, credentials, or judge implementation.
