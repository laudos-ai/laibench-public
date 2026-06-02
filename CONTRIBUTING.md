# Contributing

## Adding a locale

Add a file under `src/locales/` exporting a `LocaleSpec`, then register it in `src/locales/index.ts`.

A locale must define:

- section names
- forbidden terms and openers
- contrast lexicon
- modality vocabulary rules
- title tokens
- coverage matrix
- preservation patterns
- system prompt builder
- judge instructions

## Adding cases

Public cases live under `cases/public/` and are referenced by a suite manifest in `suites/`.
They must conform to [`schemas/case.schema.json`](schemas/case.schema.json) — run
`npm run validate:schemas` before opening a PR.

> **Privacy is non-negotiable.** Public cases must be **synthetic or fully de-identified**.
> Never add real clinical reports or any patient-identifying information (PHI/PII): names,
> document numbers (CPF/RG/MRN), dates of birth, episode timestamps, or named
> clinicians/institutions. If you find such data in the repo, report it privately per
> [SECURITY.md](SECURITY.md) — do not open a public issue.

Each case must include:

- `id`
- `exam`
- `findings`
- `locale`
- `synthetic: true` — a required attestation that the case contains no real patient data.

Recommended optional fields:

- `label`
- `tags`
- `criticalFindings`, `goldFindings`, `guidelineExpectations` (gold data for richer scoring)

When you open a PR that adds cases, the pull-request checklist requires you to affirm that
no PHI/PII was added.

## Adding a public suite

Create a new suite manifest in `suites/` and point `casesPath` at a JSON file under `cases/public/`.

## Hidden/private leaderboard split

Do not commit hidden cases.

Instead, ship a template manifest with:

- `visibility: private`
- `evaluationMode: cloud-private`
- `casesPath: null`

Then evaluate that suite in a private runner using the same harness code.
