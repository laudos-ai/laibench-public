<!-- Thanks for contributing to LAIBench. -->

## What & why

<!-- What does this change and why? Link any issue. -->

## Scoring impact

- [ ] No change to scoring math
- [ ] Changes scoring math — `benchmarkVersion` bumped and `CHANGELOG.md` updated, with the **safety direction** explained (cosmetic quality must never rescue a missed/fabricated critical finding)

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (added/updated tests for the change; no existing test weakened to go green)
- [ ] `npm run guard:public` passes
- [ ] No private clinical data, PII, answer keys, secrets, or hidden scoring criteria added
- [ ] CLI flags and run-artifact JSON remain backward compatible (or the break is documented)
