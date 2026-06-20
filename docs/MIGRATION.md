# Migrating from laibench v1.0.0 → v2.0.0

v2 is fully backwards compatible with v1 case files and run results. The only mandatory change is bumping `benchmarkVersion` in your suite manifests.

## What you must change

```diff
 // suites/<your-suite>.json
 {
-  "benchmarkVersion": "1.0.0",
+  "benchmarkVersion": "2.0.0",
   ...
 }
```

If you were relying on the old `LeaderboardEntry` shape, note that v2 adds an optional `averageOverallCI95: [number, number]` field — undefined entries simply omit the CI column.

## What you can opt into (zero breaking changes)

### 1. Run a discrimination test against a baseline

```bash
npm run bench -- discriminate \
  --a runs/your-model.json \
  --b runs/baseline.json \
  --out runs/discrimination.json
```

A reference benchmark must `discriminate` your model from a known-weaker baseline. If verdict is `fails` or `weak`, the suite is too small or the score gap too narrow for confident ranking.

### 2. Calibrate your judge

```bash
# Run the SAME suite twice with the same judge to measure test-retest α:
npm run bench -- suite --suite ... --judge-model anthropic/claude-opus-4.6 --run-name r1 --out r1.json
npm run bench -- suite --suite ... --judge-model anthropic/claude-opus-4.6 --run-name r2 --out r2.json

# Then:
npm run bench -- calibrate --inputs r1.json r2.json --out calibration.json
```

Add a third run with a different judge model to also get cross-judge κ + α.

### 3. Probe with adversarial perturbations

```bash
# One-shot pipeline: build matrix → submit → score → emit catch-rate report
npm run bench -- perturb-run \
  --suite suites/lite-public.pt-BR.json \
  --limit 120 \
  --out runs/perturb-report.json
```

Eight perturbation classes, deterministic per (caseId, kind), with declared expected-failure dim + severity. Verdict ∈ {robust ≥ 90%, leaky ≥ 70%, broken < 70%}.

### 4. Scan for contamination

```bash
npm run bench -- contamination --run runs/your-model.json
```

Whitespace-insensitive canary search. Defeats trivial evasion.

### 5. Build a hash-chain provenance manifest

```bash
npm run bench -- provenance \
  --suite suites/lite-public.pt-BR.json \
  --suite suites/lite-public.pt-BR.json \
  --out provenance.json
```

Pin the cases + scoring code to a top-level SHA-256 manifest before publishing a leaderboard.

### 6. Get a publishable consolidated report

```bash
npm run bench -- report \
  --run runs/your-model.json \
  --baseline runs/baseline.json \
  --calibration runs/r1.json runs/r2.json \
  --perturb-report runs/perturb-report.json \
  --provenance provenance.json \
  --out runs/consolidated.json \
  --markdown runs/consolidated.md
```

One artifact suitable for attaching to a paper or a PR.

## What changed under the hood

- `src/perturb.ts`: deterministic seeded PRNG (splitmix32 keyed on caseId+kind), expanded terminology rules to 32 PT-BR + 32 en-US, gender-aware laterality flip, drops ALL critical findings.
- `src/kappa.ts`: new module — Cohen κ, Fleiss κ, Krippendorff α (NaN-tolerant interval), paired bootstrap.
- `src/discriminate.ts`: per-dim, per-modality, per-difficulty bootstrap CI + p-value with stratum-collapse warnings.
- `src/calibrate.ts`: test-retest α / cross-judge κ + α / det↔judge Spearman ρ + whitespace-insensitive contamination scan.
- `src/perturb-eval.ts`: severity-indexed catch rule (det / judge / dim floor) + integration helper `buildPerturbationDataset`.
- `src/provenance.ts`: caseHash → suiteHash → scoringHash → runHash → leaderboardHash chain. Fails loud on missing scoring files.
- `src/report.ts`: consolidated reporter (CI + contamination + calibration + discrimination + perturbation + provenance).
- `src/leaderboard.ts`: bootstrap CI shown in markdown output and JSON.
- `package.json`: bumped to 2.0.0. The v2 commands (`discriminate`, `calibrate`, `contamination`, `perturb-matrix`, `perturb-run`, `bootstrap`, `provenance`, `report`) are invokable via `npm run bench -- <command>` (e.g. `npm run bench -- discriminate ...`). The seeded multi-baseline mocks ship in `examples/mock-good.mjs`, `mock-medium.mjs`, and `mock-bad.mjs`.

## Tests

v1: 105 tests. v2: 214 tests (new modules + integration + interval-alpha regression guards). All passing on Node 20 + 22 (CI in `.github/workflows/ci.yml`).
