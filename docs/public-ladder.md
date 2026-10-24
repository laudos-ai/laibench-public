# Public discrimination ladder — LAIBench 3.11.0

Suite `lite-public.en-US` (49 synthetic cases, suiteHash `013cfb0d91d7ec0a…`). Template reference agent, deterministic scorer, no judge. Regenerate with `npx tsx scripts/public-ladder.ts --markdown docs/public-ladder.md`.

| Rung | Error injected | n | Mean score | PASS | FAIL | Critical veto | Score dropped |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| L0 | Reference | 49 | 90.8 | 63.3% | 0% | 0% | — |
| L1 | Measurement drift | 18 | 82.1 | 11.1% | 0% | 0% | 83.3% |
| L2 | Non-critical omission | 11 | 72.3 | 27.3% | 54.5% | 45.5% | 81.8% |
| L3 | Laterality swap | 27 | 67.3 | 18.5% | 81.5% | 81.5% | 81.5% |
| L4 | Critical denied | 14 | 59.9 | 0% | 100% | 100% | 100% |
| L5 | Critical omitted | 14 | 59.9 | 0% | 100% | 100% | 100% |
| L6 | Critical fabricated | 35 | 59.9 | 0% | 100% | 100% | 100% |
| L7 | Null report | 44 | 59.9 | 0% | 100% | 100% | 100% |

Synthetic public cases, input-only (no answer keys). Each rung injects one error into the reference report; drops are paired against the same case's reference score. Not a clinical validation.
