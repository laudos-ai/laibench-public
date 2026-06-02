# Reference-grade review — open findings backlog

A multi-agent review of this repository produced the items below. The schema, license,
documentation, integrity-hash, and CI findings have been **fixed** in this change (see the
PR description). The items here are **deferred** because they change scoring semantics,
touch clinical heuristics, or otherwise warrant maintainer judgment before landing. Each
has an exact location and a proposed fix.

## High — scoring semantics (needs maintainer decision)

### 1. `judgeScoreTo100` silently inflates the unsafe low end
- **Where:** `src/scoring.ts:16-20` (also the hardcoded `j * 20` at `src/calibrate.ts:147`, and the judge prompt scale at `src/judge.ts`).
- **Problem:** any judge score `<= 5` is multiplied by 20, on the assumption that the judge uses a 1–5 scale. But the judge prompt asks for **0–100**. A 0–100 judge that correctly returns `CRIT = 3` for a catastrophic report is rescaled to `60`, and `5` becomes `100` — inflating exactly the dangerous low end the benchmark exists to catch.
- **Proposed fix:** make the scale explicit per judge adapter (`scoreScale: "0-100" | "1-5"`), default `"0-100"`, and rescale **only** declared-`1-5` adapters. Update `scoring.test.ts` (the cases that currently assert `3*20=60`) to the explicit-scale contract and add a regression test that a 0–100 `CRIT=3` is **not** inflated.
- **Why deferred:** this changes published scores, so it should be a deliberate, versioned decision.

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

### 4. `Retry-After` parsing
- **Where:** `src/providers/openrouter.ts:22`, `src/providers/openai-compatible.ts:98`.
- **Problem:** `Number(retryAfter)` yields `NaN` for the HTTP-date form → `setTimeout(NaN)` = no backoff.
- **Proposed fix:** parse delta-seconds **or** `Date.parse`; fall back to a table delay.

### 5. Unknown modality defaults silently to CT
- **Where:** `src/classify.ts`.
- **Proposed fix:** default to an explicit `unknown` modality and surface it, rather than masquerading as CT.

### 6. Test-coverage gaps
- No direct tests for `benchmarkCase` orchestration (gold routing, operational-failure zero-dims), `sanitize.ts` (XSS strip + allowed-tag passthrough), or the provider retry paths. Add focused unit tests.

## Site governance (separate from the harness)

### 7. Disclaimer i18n drift in `site/index.html`
- The "not a medical device" disclaimer is inconsistent across locales (an EN string contains Portuguese text; the ES string asserts a different exclusion set and omits the regulatory clause). Unify the disclaimer text across all locales from a single source string.

### 8. `DATA_ACCESS_POLICY.md` regulatory framing
- The policy requires privacy review and bans re-identification but never names LGPD/GDPR/HIPAA and gives no contact for controlled-access/incident requests. Add a short "Regulatory framing" section and the `oi@laudos.ai` contact.
