# Schemas

JSON Schema (draft 2020-12) data contracts for LAIBench. Each schema mirrors a TypeScript
type in [`src/types.ts`](../src/types.ts), which is the source of truth. The schemas are
validated against the data this repository actually ships by
[`scripts/validate-schemas.mjs`](../scripts/validate-schemas.mjs) (run in CI), so they
cannot silently drift.

| Schema | Mirrors (`src/types.ts`) | Describes |
| --- | --- | --- |
| [`case.schema.json`](case.schema.json) | `BenchCase` | A benchmark case: exam + findings + optional gold data. Public cases must set `synthetic: true`. |
| [`prediction-record.schema.json`](prediction-record.schema.json) | `SubmissionPrediction` | One frozen-prediction record (`instance_id` + `model_output`). The canonical external submission unit. |
| [`score.schema.json`](score.schema.json) | `CaseRunResult` (scoring subset) | A scored per-case result in a run file's `results[]`. Scores are 0–100; dimension keys are uppercase. |
| [`leaderboard.schema.json`](leaderboard.schema.json) | `Leaderboard` | A leaderboard document: runs grouped by comparability key. Rates are 0–100. |

## Validate

```bash
npm run validate:schemas
```

This compiles every schema and checks that all public cases validate against
`case.schema.json` and that the submission template validates against
`prediction-record.schema.json`.

## Conventions

- Scores and rates are on a **0–100** scale.
- Dimension keys are **uppercase**: `CRIT`, `QUAL`, `TERM`, `GUIDE`, `RAG`.
- `src/types.ts` is authoritative. If a schema and the type disagree, fix the schema and
  add a case/fixture that would have caught the drift.
