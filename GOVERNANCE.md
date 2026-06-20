# LAIBench governance

This document makes the public/controlled/hidden separation, claim discipline,
and anti-gaming posture explicit. It is the contract the docs, site, paper, and
CI guards are held to. See per-suite [benchmark cards](docs/benchmark-cards.md).

## 1. Suite tiers (never mix them)

| Tier | Visibility | Use | Can support a claim? |
| --- | --- | --- | --- |
| **public-smoke** | Public, synthetic, contaminable | CI, demo, harness inspection, open-model *diagnostic baselines* | No ranking / no clinical claim |
| **controlled-eval** | Gated, ships no case text, aggregate-only | First-party real scores, with disclosure | First-party only, with disclosure |
| **hidden-holdout** | Never published, never tuned on | Final claims | The only tier that can support a strong external claim — once externally adjudicated |
| **calibration-set** | Internal | Calibrate scorer/judge | Never for ranking |

Today the repo ships `public-smoke.en-US` (`lite-public.en-US`, 12 synthetic) and
`controlled-eval.pt-BR` (`lite-public.pt-BR`, 120 gated, `casesPath: null`).
`hidden-holdout` and `calibration-set` are governance commitments, not yet built.

**Golden rule:** if a suite was ever used for debugging or scorer tuning, it is
dead as a holdout. Only a final untouched hidden-holdout sustains a strong claim.

## 2. Claim taxonomy

Every public sentence must reduce to one of: *smoke test · synthetic public demo
· controlled aggregate-only · first-party result · external validation pending ·
not clinical validation · not image interpretation.*

Forbidden: *clinical-grade · validated (without external adjudication) · open
benchmark (for a gated suite) · state-of-the-art (without paired comparison) ·
clinically validated.*

## 3. First-party disclosure

Laudos.AI is both maintainer and competitor. First-party scores are published in
a **separate, labelled** board (`controlled-eval`, "first-party") and are never
ranked against the public-smoke open-model baselines.

## 4. No example may come from a hidden/gated suite

Paper, site, README, screenshots, prompts, demos: only `public-smoke` or
fabricated-outside-the-holdout examples. The public board is aggregate-only and
must never publish controlled case IDs or raw findings (enforced by
`src/docs-consistency.test.ts`).

## 5. CI guards (enforced now)

`src/docs-consistency.test.ts` fails if:
- a public doc shows a local CLI command against a cloud-private suite;
- the README `benchmarkVersion` badge ≠ `package.json` version;
- a public doc calls the controlled (cloud-private) suite an open/open-download benchmark;
- the public board (`site/data.js`) carries case-level identifiers or raw findings.

`src/release-guard.ts` (`guard:public`) blocks raw-data extensions, private
paths, public answer keys, secrets, corpus fingerprints, calendar-date traces,
and unsubstantiated radiologist/clinical-validation claims.

## 6. Roadmap — what "external-validation-grade" still requires

These are honest gaps. Until they ship, the correct claim stays **"technical
benchmark framework"**, not "clinically validated benchmark".

- **External adjudication.** 2–3 radiologists, locked subset, disagreement
  protocol, inter-rater κ/α, scorer-vs-radiologist correlation, and at least one
  reviewer not affiliated with Laudos.AI. Validator + record schema already exist
  (`src/adjudication.ts`, `docs/radiologist-adjudication-protocol.md`); the study
  itself is pending. Shown on the site as research "em andamento".
- **Hidden-holdout split.** Build `hidden-holdout` and `calibration-set` pools;
  never tune on the holdout; only it sustains strong claims.
- **Per-run contamination report.** For each real run, record declared data
  cutoff, public prompt used, suite hash, canary-token scan, repo-exposure flag,
  and a "contamination scan: pass / fail / unknown" summary published with the run.
- **Frozen submissions.** Leaderboard accepts only runs from the official runner
  or validated frozen predictions: submission JSONL is hashed + timestamped +
  pinned to a scorer version, with no unlimited resubmission on the same holdout.
- **Paper ↔ harness.** *Beyond Templates* (report-state theory, RSLB/RRVI) names
  LAIBench as the evaluation harness for the compositional thesis; empirical
  render/consistency results on valid/invalid synthetic states are future work.
