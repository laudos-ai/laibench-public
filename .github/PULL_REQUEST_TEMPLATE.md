<!--
Thanks for contributing to LAIBench. Keep changes reproducible and auditable.
Do NOT add real clinical reports or any patient-identifying text. Public cases must be
synthetic/de-identified per DATASET_CARD.md and the public data boundary in README.md.
-->

## Summary

<!-- What does this PR change and why? Link any related issue. -->

## Type of change

- [ ] Bug fix (no scoring change)
- [ ] Harness / CLI / tooling
- [ ] Evaluator or scoring change (**changes results — see versioning impact below**)
- [ ] Schema change
- [ ] Documentation
- [ ] New public (synthetic) case(s) or suite

## Scoring / comparability impact

<!-- A reference benchmark must keep runs comparable. -->

- [ ] This PR does **not** change any score for existing cases, **or**
- [ ] It changes scores and the version impact is described below (per `BENCHMARK_CARD.md` → Versioning / SemVer).

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run smoke:mock` (and `smoke:leaderboard`) still run end-to-end
- [ ] Any new doc links resolve to files that exist in the public repo
- [ ] No real clinical reports / PHI / PII added (public cases are synthetic/de-identified)
- [ ] `CHANGELOG.md` updated if behavior or scoring changed
