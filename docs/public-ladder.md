# Public discrimination ladder — LAIBench 3.11.0

Suite `lite-public.en-US` (49 synthetic cases, suiteHash `013cfb0d91d7ec0a…`). Template reference agent, deterministic scorer, no judge. Regenerate with `npx tsx scripts/public-ladder.ts --markdown docs/public-ladder.md`.

| Rung | Error injected | n | Mean score | PASS | FAIL | Critical veto | Score dropped |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| L0 | Reference | 49 | 97.4 | 100% | 0% | 0% | — |
| L1 | Measurement drift | 18 | 84.3 | 5.6% | 0% | 0% | 100% |
| L2 | Non-critical omission | 10 | 78.3 | 40% | 40% | 40% | 90% |
| L3 | Laterality swap | 25 | 66.3 | 16% | 84% | 84% | 84% |
| L4 | Critical denied | 14 | 59.9 | 0% | 100% | 100% | 100% |
| L5 | Critical omitted | 14 | 59.9 | 0% | 100% | 100% | 100% |
| L6 | Critical fabricated | 33 | 59.9 | 0% | 100% | 100% | 100% |
| L7 | Null report | 41 | 59.9 | 0% | 100% | 100% | 100% |

Synthetic public cases, input-only (no answer keys). Each rung injects one error into the reference report; drops are paired against the same case's reference score. Not a clinical validation.
