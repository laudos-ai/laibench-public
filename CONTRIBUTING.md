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

Each case must include:

- `id`
- `exam`
- `findings`
- `locale`

Recommended optional fields:

- `label`
- `tags`

## Adding a public suite

Create a new suite manifest in `suites/` and point `casesPath` at a JSON file under `cases/public/`.

## Hidden/private leaderboard split

Do not commit hidden cases.

Instead, ship a template manifest with:

- `visibility: private`
- `evaluationMode: cloud-private`
- `casesPath: null`

Then evaluate that suite in a private runner using the same harness code.
