# Benchmark cards

LAIBench separates suites into four governance tiers so the public, the gated,
and the never-seen can never be confused:

| Tier | Meaning | May support claims? |
| --- | --- | --- |
| **public-smoke** | Public, synthetic, contaminable. CI / demo / harness-inspection only. | No ranking or clinical claims. |
| **controlled-eval** | Gated, ships no case text, aggregate-only real scores. First-party results, with disclosure. | First-party, with disclosure. Not external validation. |
| **hidden-holdout** | Never published, never used for tuning. | The only tier that can support a strong external claim — *once external adjudication exists*. |
| **calibration-set** | Used to calibrate the scorer/judge, never for ranking. | No ranking claims. |

> Golden rule: **if a suite was ever used for debugging or scorer tuning, it is dead as a holdout.** Only a final, untouched hidden-holdout can support a strong claim.

Allowed public phrasings: *smoke test · synthetic public demo · controlled aggregate-only · first-party result · external validation pending · not clinical validation · not image interpretation.*
Disallowed: *clinical-grade · validated (without external adjudication) · open benchmark (for a gated suite) · state-of-the-art (without paired comparison).*

---

## Card — `public-smoke.en-US`  (suite id: `lite-public.en-US`)

| Field | Value |
| --- | --- |
| Tier | **public-smoke** |
| Visibility | Public (ships case JSON) |
| Case count | 49 |
| Case source | Synthetic, authored for the harness |
| Synthetic vs real-derived | **Synthetic** (every case flagged `synthetic: true`) |
| Answer-key status | No private answer keys; deterministic checks are public |
| Leakage / contamination risk | **High** — public + on GitHub; assume models may have seen it |
| Allowed use | Install checks, CI smoke, harness inspection, open-model *diagnostic baselines* |
| Disallowed claims | Ranking, clinical validation, "open benchmark" as evidence of capability |
| Suite hash | `013cfb0d91d7ec0aca31ed5e6748c0e851d060cfaa52fb7c1274aeed46ce6d5c` |
| Scoring hash | `07388382f55f6fecd64b914b9c1febfdf13f523f8eae060f04f083ba6c6a585f` |
| Adjudication status | None (synthetic) |

## Card — `controlled-eval.pt-BR`  (suite id: `lite-public.pt-BR`)

| Field | Value |
| --- | --- |
| Tier | **controlled-eval** |
| Visibility | Gated — `evaluationMode: cloud-private`, `casesPath: null` (ships **no** case text) |
| Case count | 120 |
| Case source | Synthetic, authored and internally reviewed by senior radiologists (São Paulo, BR) |
| Synthetic vs real-derived | **Synthetic**, internally reviewed |
| Answer-key status | Gated — answer keys, frozen predictions, provenance are **not** distributed |
| Leakage / contamination risk | Low (case text not public); public board is aggregate-only |
| Allowed use | First-party aggregate results locked to this suite hash + case count, with disclosure |
| Disallowed claims | "Open benchmark", "clinically validated", external-validation language |
| Suite hash | `b7f412e25a71352072d525c9bee9d7630818eb09996d172e9c2664224d7b2217` |
| Scoring hash | `07388382f55f6fecd64b914b9c1febfdf13f523f8eae060f04f083ba6c6a585f` |
| Adjudication status | **Internal review only.** External inter-rater adjudication (2–3 radiologists, locked subset, κ/α, external reviewer) is *pending* — tracked as research "em andamento". |

---

## Honest current claim

LAIBench is a **technical benchmark framework**, not a clinically validated benchmark. The Laudos.AI score is a **first-party, controlled, aggregate-only** result on `controlled-eval.pt-BR`. Free/open-model numbers are **public-smoke diagnostic baselines**, not a ranking. External adjudication and a hidden-holdout split are the remaining work before any stronger claim.
