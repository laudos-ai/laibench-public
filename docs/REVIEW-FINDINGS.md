# Reference-grade review — open findings backlog

A multi-agent review of this repository produced the items below. Items marked **✅ FIXED**
were resolved in this PR (alongside the schema, license, documentation, integrity-hash, and
CI fixes described in the PR). The remaining items are **deferred** because they change
scoring semantics in ways that warrant a versioned decision, touch clinical heuristics, or
otherwise warrant maintainer judgment before landing. Each has an exact location and fix.

## High — scoring semantics (needs maintainer decision)

### 1. `judgeScoreTo100` inflates the unsafe low end (DEFERRED — needs a scale decision)
- **Where:** `src/scoring.ts:16` (judge prompt scale is **0–100** at `src/judge.ts:106`).
- **Problem:** any judge score `<= 5` is multiplied by 20, assuming a 1–5 scale. But the judge prompt asks for **0–100**, so a 0–100 judge returning `CRIT = 3` for a catastrophic report is rescaled to `60` — inflating exactly the dangerous low end.
- **Why this is genuinely ambiguous (not a clean bug):** the codebase contradicts itself on the canonical scale. The judge **prompt** says 0–100 and `scoring.test.ts` (combine) passes 0–100 through unchanged, but the **verdict-threshold test suite** (`scoring.test.ts` "Boundary: combineScores verdict thresholds") feeds **1–5** judge scores and relies on the `×20` rescale (e.g. `5 → 100 → PASS`), and `calibrate.ts:147` also assumes 1–5. Removing the rescale breaks those threshold tests.
- **Proposed fix (maintainer decision):** make the scale **explicit per judge adapter** (`scoreScale: "0-100" | "1-5"`), default `"0-100"`, rescale only declared-`1-5` adapters; then rewrite the boundary-threshold tests to construct 0–100 overalls directly, and add a regression test that a 0–100 `CRIT=3` is **not** inflated.
- **Why deferred:** it changes published scores AND requires resolving the contradictory scale assumption — a deliberate, versioned decision, not a mechanical edit.

## Medium — clinical-gate correctness

### 2. Negation is sentence-scoped, not clause-scoped
- **Where:** `src/extract.ts:408-421`, `src/extractors/critical-extractor.ts:90`.
- **Problem:** a contrastive sentence such as *"Ausência de derrame, porém consolidação no LID"* negates the whole sentence and can drop a true positive critical finding.
- **Proposed fix:** scope negation to the clause and stop at contrastive conjunctions (`porém`, `mas`, `however`, `but`). Add fixtures covering contrastive sentences.

### 3. Policy/weight profiles are half-wired
- **Where:** `src/benchmark.ts:84,224`, `src/scoring.ts:130`, `src/policies.ts`.
- **Problem:** `benchmarkCase` accepts `policyId` and uses `policy.weights`, but the suite runners and `cli.ts` never forward it; `listPolicies`/`isPolicyProfileId` are unused. The `strict` profile (CRIT re-weighted to .35) is unreachable from the CLI.
- **Proposed fix:** thread `--policy` through `cli.ts` → suite runner → `benchmarkCase`, or remove the dead surface and document a single weighting.

## Low — robustness & coverage

### 4. ✅ FIXED — `Retry-After` parsing
- **Where:** `src/providers/openrouter.ts`, `src/providers/openai-compatible.ts`.
- **Was:** `Number(retryAfter)` yielded `NaN` for the HTTP-date form → `setTimeout(NaN)` = no backoff.
- **Fix applied:** new `parseRetryAfterMs` in `src/normalize.ts` handles both delta-seconds and the HTTP-date form, falls back to the table delay on garbage/past dates, and clamps to 30s. Both providers use it. Covered by `src/normalize.test.ts`.

### 5. Unknown modality defaults silently to CT
- **Where:** `src/classify.ts`.
- **Proposed fix:** default to an explicit `unknown` modality and surface it, rather than masquerading as CT.

### 6. Test-coverage gaps
- No direct tests for `benchmarkCase` orchestration (gold routing, operational-failure zero-dims), `sanitize.ts` (XSS strip + allowed-tag passthrough), or the provider retry paths. Add focused unit tests.

## Site governance (separate from the harness)

### 7. ✅ FIXED — Disclaimer i18n drift in `site/index.html`
- The `en` locale's `imp` (imprint/disclaimer) string contained **Portuguese** text, and the `es` string omitted the regulatory/deployment exclusions. Unified all three locales (`en`/`pt`/`es`) to the same four exclusions: **not a medical device, not clinical validation, not regulatory approval, not authorization to deploy.** Verified the three `imp` entries remain valid JSON strings.

### 8. ✅ FIXED — `DATA_ACCESS_POLICY.md` regulatory framing
- Added a "Regulatory framing" section (LGPD/GDPR/HIPAA — consistent-with, not certified) and a "Contact" section (`oi@laudos.ai` for access requests; private leak reporting via SECURITY.md).
