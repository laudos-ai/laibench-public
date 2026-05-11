# Public Submissions

LAIBench accepts executable systems and frozen prediction files. A submitter can be a product team, research group, hospital engineering team, local agent, hosted service, or raw model baseline.

The public contract is intentionally small:

1. choose a locked suite;
2. generate one report per case;
3. write one JSON object per line;
4. validate the JSONL file;
5. evaluate the validated file.

No private implementation details are required for scoring.

## Prediction JSONL

Each line must match `schemas/prediction-record.schema.json`.

```json
{"instance_id":"R001","model_name_or_path":"example-agent","model_output":"<center><b>...</b></center><br>..."}
```

Optional metadata is limited to public-safe identifiers:

```json
{"instance_id":"R001","model_output":"<center><b>...</b></center><br>...","metadata":{"evidenceIds":["public-doc-1"]}}
```

Do not include prompts, private routes, credentials, raw retrieved text, hidden judge configuration, private case content, patient identifiers, or implementation details. Public artifacts expose validation counts and sanitized labels, not raw case lists or internal system wiring.

Do not submit manually edited score summaries. `leaderboard` and `compare` recompute the case overalls, suite summary, verdict counts, per-dimension averages, comparable key, and local suite hash before accepting a run artifact. If the JSON score fields were inflated or the case set does not match the locked suite, publication fails.

## Validate

```bash
npm run bench -- validate-submission \
  --suite suites/lite-public.pt-BR.json \
  --predictions predictions/my-system.jsonl
```

Validation fails on missing cases, duplicate IDs, extra IDs, empty outputs, malformed JSONL, or malformed metadata.

## Evaluate

```bash
npm run bench -- eval-submission \
  --suite suites/lite-public.pt-BR.json \
  --predictions predictions/my-system.jsonl \
  --run-name my-system-reference \
  --model-label my-system \
  --track agent \
  --out runs/my-system-reference.json
```

Use `--track agent` for product workflows and multi-step agents. Use `--track model` only for direct raw-model baselines.
