# Paper Pipeline Notes

This document records the public-safe requirements for turning LAIBench into a results paper. It intentionally does not pin private model IDs, hidden judge configuration, provider details, credentials, or product implementation details.

## Requirements

1. Use locked public suites and immutable suite hashes.
2. Generate one frozen run artifact per evaluated system.
3. Validate every predictions artifact before scoring.
4. Keep product agents, custom agents, mini-agent scaffolds, and raw model baselines in separate comparable tracks.
5. Use deterministic scoring for every run.
6. If a judge is used, judge only frozen predictions and publish only the judging mode, not the hidden judge configuration.
7. Generate leaderboard, figures, tables, and failure taxonomy from immutable run JSON files.
8. Report weighted clinical score as the primary public metric.
9. Report strict PASS rate as a gate/error metric, not as accuracy.
10. Do not claim radiologist-adjudicated labels or clinical validation unless the adjudication gate has passed.

## Output Artifacts

Expected paper artifacts:

- `runs/paper/*.json`: immutable scored run files;
- `runs/paper/leaderboard.json`: machine-readable leaderboard;
- `runs/paper/leaderboard.md`: human-readable leaderboard;
- `paper/figures/*`: generated figures;
- `paper/analysis/failure_taxonomy.json`: failure taxonomy;
- `paper/analysis/summary_stats.json`: aggregate statistics;
- `paper/analysis/table_main_results.tex`: paper table;
- `paper/analysis/ablation_det_vs_dual.json`: deterministic-vs-judged comparison when applicable.

## Public Reporting Rules

Public outputs may include:

- evaluated entity name;
- public system class;
- suite ID and suite hash;
- clinical score, strict PASS/error rate, per-dimension scores, non-fail rate;
- confidence intervals and paired comparison statistics;
- failure categories.

Public outputs must not include:

- private prompts;
- provider configuration;
- hidden judge model or profile;
- product routes;
- credentials;
- private case content;
- internal product implementation details.

## Final Verification

Before publishing a paper update, run:

```bash
npm test
npm run typecheck
npm test
git diff --check
```

Then verify the rendered PDF text for stale case counts, private implementation details, and unsupported clinical claims.
