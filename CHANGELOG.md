# Changelog

## v3.11.0 — LAIBench Pro — source-anchored critical gate, unsupported normalcy, list-scoped negation (affects scores)

The prime directive — *a beautiful report that misses a pneumothorax must fail* —
was not enforced on the **input-only (no-gold) path**, which is the path every
public synthetic case and every lab's own unlabelled cases run on. A polished
report that omitted a stated "large pneumothorax" scored **PASS 100**; omitting
free intraperitoneal air scored PASS 91.9; a right→left pneumothorax swap scored
PASS 98.1; and a "No acute abnormality." report for a complete ACL tear scored
PASS 91.9. A list-negation bug affected **both** paths. CLI contract and run
schema are backward compatible (additive). Scoring changes, so `benchmarkVersion`
moves to `3.11.0` and `scoringHash` updates.

### Added (input-only path — affects scores, safety direction)
- **C09 — input critical findings preserved** (CRIT, critical): every critical the
  input affirms must be present in the report body, affirmed, and on the same
  side. Side is required for side-defining criticals, a contradicted side always
  fails, sides are ignored for non-lateral criticals. `evaluators/source-critical.ts`.
- **C10 — no critical beyond the input** (CRIT, critical): no affirmed critical
  the input does not back, including a critical moved to the contralateral side.
  Recommendation/differential sentences are skipped; entailed broader findings
  (midline shift ⇒ mass effect) are allowed.
- **Q16 — abnormal input findings reflected** (QUAL, major, one check per missing
  finding) and **Q17 — no unsupported normalcy** (QUAL, critical).
  Paraphrase-tolerant (clause / sub-clause / diagnosis coverage) and
  polarity-aware. `evaluators/source-findings.ts`.
- The report **title and Technique section are excluded** from C09/C10/Q16/Q17:
  they restate the exam ("CT angiography *for pulmonary embolism*"), which
  otherwise credited an omitted critical.
- All four are structural checks outside the gate allowlist, so they never reach
  a gold-labelled verdict (regression-tested).

### Fixed (both paths — affects scores)
- **List-scoped negation.** "No effusion, consolidation, or pneumothorax" /
  "Sem derrame, consolidação ou pneumotórax" read later items as AFFIRMED: a
  correct report using the most common negation list could be force-FAILed with
  a fabricated critical, and a report that **denied** a gold critical inside such
  a list was credited with reporting it (unsafe direction). Negation now carries
  across a coordinated list of bare items; "No effusion, small right
  pneumothorax" stays affirmed. Tests prove both gold-path cases fail on v3.10.0.
- **Critical vocabulary.** Extracted as criticals (keyword anchors kept in sync):
  free intraperitoneal air, hemoperitoneum / hemothorax / hemopericardium,
  "acute … infarct" (up to four words between), and common paraphrases of aortic
  dissection, bowel obstruction, cord compression, perforation, midline shift and
  appendicitis — so a correct paraphrase is no longer a false omission.
- **R02 laterality swap** missed English nouns (it listed pt "pneumotorax" but
  not "pneumothorax"); added pneumothorax, atelectasis, infarct, occlusion,
  thrombus, aneurysm, tear, extrusion and joints in both locales.
- **en-US region map**: "CT angiography of the thoracic aorta" mapped to *spine*
  (graded on vertebral coverage) and "CT pulmonary angiography" to *unknown*; both
  are chest now, with matching chest title tokens in both locales.
- **Ultrasound vocabulary gate (TM1)** flagged "posterior/acoustic/beam
  attenuation", correct ultrasound terminology.
- Anatomical abbreviations (ACL, PCL, MCL, MCA, UVJ, UPJ, CBD, AAA, RLQ, RUQ; pt
  LCA, ACM) expand in the clinical matcher.
- Failing checks now print truthful evidence (C04, Q03–Q08 printed "ok" on failure).

### Hardened after an independent adversarial review (before release)
Every item below was reproduced against the first v3.11.0 draft and is now a
regression test (`src/evaluators/review-v311.test.ts`).
- **Gold-path isolation for every gold field.** A case with only
  `guidelineExpectations` or `retrievalGold` let an evaluator fall back to
  structural checks and re-admit C09/C10/Q16/Q17; they are now removed from any
  gold-labelled verdict explicitly.
- **Denial lists in the report.** "No intracranial hemorrhage or subdural
  hematoma" / "No pneumoperitoneum or free intraperitoneal air" credited the
  denied critical through the second term; occurrence-aware negation now FAILS
  those reports and no longer reads the second term of a normal denial list as a
  fabrication.
- **List negation never negates an affirmed critical.** A list only carries its
  negation across bare items; "No hydrocephalus, subarachnoid hemorrhage
  layering in the basal cisterns" and "Sem derrame pleural, pneumotórax volumoso
  à direita" stay affirmed in both locales.
- **Side swaps** are caught even when the sentence names the other side ("left
  pneumothorax with shift to the right"), and two same-category criticals
  (right rib + left clavicle fractures) are matched one to one.
- **Hypothetical and non-current mentions.** "to evaluate for…", "clinical
  question:", "history of", resolved, old/healed and chronic findings neither
  preserve an input critical nor become anchors; recommendation wording no
  longer hides a fabricated critical in the same sentence.
- **Q16/Q17 polarity** is judged on the clause that carries the finding ("No
  pneumothorax, but moderate right pleural effusion"), and postfix negation
  ("Left lobe and isthmus without nodules", "Gallbladder without stones") is a
  normal statement, so a null report on a TI-RADS 5 nodule is unsupported
  normalcy instead of PARTIAL.
- **Vocabulary without false criticals.** Splenic/renal/myocardial infarcts,
  carotid flaps and a perforated nasal septum are not stroke, aortic dissection
  or GI perforation; added plural pneumothoraces, saddle embolus, ruptured AAA,
  pneumomediastinum and the abbreviations PTX, fx and uppercase R/L.
- Report-side denials "Pneumothorax: none", "Pneumotórax: ausente",
  "Pneumotórax não identificado".
- Linear-time analysis: a 36k-character single-sentence report scores in
  milliseconds (was quadratic).

### Provenance
- `src/evaluators/source-critical.ts`, `src/evaluators/source-findings.ts` and
  `src/benchmark.ts` (owner of the gate allowlist) are pinned in the scoringHash,
  together with every module `benchmark.ts` reaches (`submission.ts` decides
  which HTML is scored, `retrieval-metadata.ts` feeds RAG). The staleness test
  now walks the import graph from `benchmark.ts` too.
- Site rows now carry the scoring version that produced them; rows scored before
  v3.11.0 are shown as such and are not v3.11.0 results until re-run.

### Tooling
- `examples/reference-agent.mjs`: deterministic, locale-aware template reference
  agent (the bundled mocks write Portuguese headers into the English suite and
  FAIL every case). On the public en-US suite: 31 PASS / 18 PARTIAL / 0 FAIL.
- `scripts/public-ladder.ts` + `docs/public-ladder.md` + `site/ladder.json`:
  public discrimination ladder. v3.10.0 → v3.11.0 PASS rate on the same reports:
  critical fabricated 48.6% → 0%, critical denied/omitted 21.4% → 0%, null report
  6.8% → 0%; critical veto on every critical rung 100%; the reference report is
  never vetoed (2.0% → 0%).
- Tests: 496 → 634 (source-critical gate, list negation in both locales,
  gold-path isolation, 20 frozen paraphrased correct reports, region map,
  adversarial-review regressions, browser-bundle parity).

### Published numbers
The controlled pt-BR row (v3.10.0) and the public-smoke rows (≤ 3.10.0) were not
re-derived here: case JSON and frozen predictions are not in this repository.
The list-negation fix can move controlled pt-BR results in **either** direction
(fewer false fabricated criticals; no credit for denied criticals). Re-run before
citing any number under v3.11.0.

## v3.10.0 — LAIBench Pro — judge-parse anti-inflation, gate completeness, critical-keyword coverage (affects scores)

Second hardening pass over the medium-severity audit tail (prime-directive-relevant
items). CLI contract and run-artifact JSON schema remain backward compatible.
Scoring math changes, so `benchmarkVersion` moves to `3.10.0` and `scoringHash`
updates.

### Fixed (correctness — affects scores, safety direction)
- **Judge parser re-introduced per-value scale inflation.** `parseJudgeResponse`
  floored scores at 1 and routed any dim ≤ 5 through a per-value Likert path —
  the exact failure mode `scoring.ts` rejected in favor of a single per-result
  `judgeScoresAreLikert` decision. The parser now preserves the judge's raw
  `[0,100]` values (a genuine 0 stays 0) and lets `combineScores` own all scale
  disambiguation.
- **Out-of-range judge values were clamped to the favorable end** (CRIT=500 → 100).
  Clearly out-of-range values are now dropped to `null` (invalid) instead of
  becoming a maximum score.
- **Judge silently dropped on trailing prose.** The JSON extractor was end-anchored
  (`/\{[\s\S]*\}$/`), so any text after the object (even a trailing period) made
  parsing return null. It now scans from the first `{` to its matching `}` by
  brace depth (string-aware), tolerant of leading/trailing prose, and logs a
  warning when a present response is unparseable instead of dropping it silently.
- **Form/coverage alone could reach PASS when both clinical dims were UNSCORED.**
  The anti-compensation cap treated a `null` CRIT/QUAL as "not weak". PASS now
  requires at least one scored clinical dimension; if both are UNSCORED the score
  is capped below PASS with an explicit gate reason.
- **`CRITICAL_KEYWORDS_PT/EN` reconciled with `CRITICAL_CATEGORIES`.** Added
  keyword anchors (both locales) for classic emergencies that were defined as
  categories but not anchored — cauda equina, pneumoperitoneum/free air,
  testicular/ovarian torsion, mesenteric/intestinal ischemia, spinal cord
  compression, intussusception, necrotizing fasciitis, appendicitis, bowel
  obstruction, perforation, ectopic pregnancy, extravasation. Additive,
  safe-direction (more criticals recognized as gated anchors).

### Fixed (hygiene)
- Duplicate check id `R04` in the RAG structural-fallback path renamed to a
  unique id.
- The `--cmd` command provider no longer hands the benchmark's own provider/judge
  credentials (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPAT_API_KEY`,
  `ANTHROPIC_API_KEY`, `LANGFUSE_*`, and the `LAIBENCH_` credential namespace) to
  the evaluated subprocess. Uses a narrow exact-name denylist so the evaluated
  agent's OWN credentials are preserved (backward compatible).

### Docs
- Methods doc now states explicitly that LAIBench has no prose/aesthetic axis and
  that the only discourse-adjacent signals (hedging, verbosity) are minor,
  non-gating, and apply only on the no-gold fallback path.

## v3.9.0 — LAIBench Pro — prime-directive hardening: gate enforced on public numbers, polarity-aware critical detection, provenance & disclosure integrity (affects scores)

Outcome of an exhaustive pre-publish audit (9 review dimensions, every finding
adversarially verified). The core anti-HealthBench design held — conservative
`MIN(det, judge)`, the hard critical veto (`cap 59.9` + forced `FAIL`), the
absence of any prose/aesthetic axis, and the anti-compensation invariant were
all confirmed sound and no path was found where a high judge/QUAL score rescues
a missed or fabricated critical *through the normal `combineScores` gate*. The
fixes below close escapes *around* that gate (the layers that produce public
numbers, and negation/polarity edge cases) plus provenance/disclosure integrity.
CLI contract and run-artifact JSON schema remain backward compatible (additive
fields and stricter integrity validation only). Scoring math changes, so
`benchmarkVersion` moves to `3.9.0` and `scoringHash` updates.

### Fixed (correctness — affects scores, safety direction)
- **The critical gate was not re-enforced where public numbers are produced.**
  `assertSuiteRunIntegrity` recomputed `combinedOverall` but never re-derived the
  per-case `verdict`, and `recomputeSummary` trusted the stored verdict — so a
  run with a critical-miss case (honest `59.9`/`FAIL`) relabeled `PASS` passed
  integrity and inflated `passRate`/`strictPassRate`. The integrity check now
  (a) re-derives the verdict through the gated combiner and rejects any stored
  verdict that disagrees, (b) enforces an **absolute, policy-independent critical
  veto** (a failed `severity:"critical"` check or a judge `critical_failure`
  forces `FAIL` under every policy/scoreMode, even when `detDims` is absent), and
  (c) drives the summary tallies from the re-derived verdict. Absent/partial
  `detDims` on a public-facing artifact is now an integrity failure (no more
  validating against an ungated weighted mean). `report.ts` now routes inputs
  through `assertSuiteRunIntegrity`; `reliability.ts` `isCriticalSafe` now also
  fails on any failed critical check.
- **Bare pertinent negatives ("no X" / "sem X") were invisible in the token-match
  path.** `isFindingNegated`'s fallback delegated to `isNegated`, whose locale
  patterns omit bare prefixes, so a report that *denied* a critical could be
  credited as mentioning it. The fallback now uses the clause-scoped
  `hasNegationCue` (`NEGATION_PREFIX/SUFFIX`).
- **Negation bled across conjunctions.** Clause windows used only `, ; :` as
  boundaries. Added true contrast/accompaniment markers
  (`but|with|mas|com|porém|contudo|entretanto`) so a leading negation no longer
  un-gates an affirmed compound critical. Coordinating conjunctions
  (`and|or|e|ou`) are deliberately **not** boundaries — in radiology they share a
  negation ("no hemorrhage or mass effect"), and closing scope there would
  fabricate a critical.
- **Source-backed critical suppression was polarity-blind (CG05).** A critical
  the *source negated* (pertinent negative) but the *report fabricated as present*
  was suppressed via lexical token coverage and scored 100. `isSourceBackedCriticalMention`
  is now polarity-aware: a mention is source-backed only when the best-matching
  source clause *affirms* the same critical anchor.
- **QUAL polarity inversion on compound gold.** `polarityConcordant` computed
  `goldNegated` with whole-text `hasNegationCue`, so a gold like "acute subdural
  hematoma, no midline shift" was flagged negated, letting a report that negated
  the critical match. `goldNegated` (and the candidate side) are now scoped to the
  gold's primary finding clause.
- **Judge-primary could overwrite the deterministic clinical floor.** In
  `judge-primary` mode the clinical dims (`CRIT`, `QUAL`) are now clamped to
  `MIN(det, judge)` so a high judge score cannot lift a deterministic clinical
  failure in the reported per-dimension columns. Non-clinical dims keep
  judge-primary behavior (backward compatible).
- **GUIDE present-without-value leaked points.** When a guideline acronym is named
  with no actionable category, the correctness gate is now emitted as a critical
  `FAIL` instead of being skipped.

### Fixed (provenance & release integrity)
- **`DEFAULT_SCORING_FILES` omitted gate-deciding files.** Added
  `clinical-match.ts`, `extractors/critical-extractor.ts`, and the locale spec
  files (`locales/index.ts`, `types.ts`, `en-US.ts`, `pt-BR.ts`) so silent
  tampering of the critical-finding gate moves `scoringHash`. Added an import-graph
  coverage test that fails if a runtime module reachable from the scoring path is
  not pinned.
- **Public disclosure overclaim corrected.** The public leaderboard disclosure
  stated the *public demonstration cases* were "clinically reviewed by senior
  radiologists" — contradicting the README/DATA_ACCESS_POLICY and unsupported by
  any adjudication artifact. Reworded to the truthful, consistent scope: the
  public demo cases are synthetic and input-only; senior-radiologist review
  (São Paulo, Brazil) applies to the *controlled pt-BR suite* as an internal
  data-quality process, **not** an independent third-party validation.
- **`guard:public` now enforces the radiologist/adjudication claim gate.** A
  public artifact asserting clinical validation/independent review of scored
  cases fails the guard unless a `validateAdjudicationRecord` artifact matches the
  published `suiteHash`. CI now runs `guard:public` (was `guard:private` only).

## v3.8.0 — LAIBench Pro — clause-scoped negation in the gold-critical gate (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible (the
critical-anchor regexes are now exported, additive only). This closes a
critical-gate escape, so `benchmarkVersion` moves to `3.8.0` and `scoringHash`
updates.

### Fixed (correctness — affects scores, safety direction)
- **A compound affirmed critical gold label was dropped from the gate.**
  `isScoredCriticalLabel` used a whole-label `hasNegationCue`, so a gold label
  that affirmed a critical finding but appended an unrelated pertinent negative
  (`Acute hemorrhage, no midline shift`; `Hematoma subdural agudo, sem desvio da
  linha média`) was treated as negated, removed from the scored critical labels,
  and produced no `CG01`/`CG02` checks: a model that omitted the affirmed
  critical escaped the hard-FAIL veto, the inverse of the central invariant.
  This is the gold-label instance of the clause-vs-sentence negation bug-class
  already fixed for `extractCriticalMentions` (v3.5.0) and the R02 swap loop
  (v3.6.0/v3.7.0). The label is now scored when ANY recognized critical anchor
  is affirmed within its own clause (handles either ordering of the affirmed and
  negated parts); when the label has no recognized critical anchor, it falls
  back to the original whole-label check so a pure pertinent negative
  (`No testicular torsion`, `Sem hemorragia`) is still correctly excluded (no
  opposite-direction over-gating). Locked by `src/evaluators/crit.test.ts`.
  Note: the analogous whole-string check in `qual.ts` (`polarityConcordant` gold
  polarity) is tracked for a consistent shared-helper follow-up.

## v3.7.0 — LAIBench Pro — clause-scoped negation in the R02 swap loop (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible. This
extends R02 swap detection, so `benchmarkVersion` moves to `3.7.0` and
`scoringHash` updates.

### Fixed (correctness — affects scores, safety direction)
- **The R02 swap loop skipped a whole report sentence on any negation cue.** It
  used `hasNegationCue(rs)`, so a laterality swap in a sentence that also carried
  an unrelated pertinent negative (`nódulo à esquerda, sem realce significativo`)
  was skipped entirely and the swap went undetected. It now uses the
  clause-scoped `isFindingNegated(rs, noun)`, so the loop skips only when the
  finding's own clause is negated (the contralateral-normal exemption is
  preserved) while still catching a swap whose sentence happens to contain an
  unrelated negation. Immediate follow-up to the v3.6.0 vowel-aware regex fix.
  Locked by `src/negation.test.ts`.

## v3.6.0 — LAIBench Pro — pt-BR laterality-swap detection (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible. This
restores a dead critical-gate branch on the pt-BR suite, so `benchmarkVersion`
moves to `3.6.0` and `scoringHash` updates.

### Fixed (correctness — affects scores, safety direction)
- **R02 laterality-swap detection was dead on pt-BR.** The swap regexes
  `/\b(?:direit|right)\b/` and `/\b(?:esquerd|left)\b/` place a word boundary
  after a consonant-ending stem, but Portuguese laterality words end in a vowel
  (`direita`/`direito`/`esquerda`/`esquerdo`), so the boundary never matched and
  the swap comparison (both building the input side-map and checking the report)
  was structurally dead in pt-BR. A clean swap was still caught by the
  boundary-free presence check (reported as `missing laterality`), but a swap
  **masked by contralateral-normal documentation** (input "nódulo à direita";
  report "nódulo à esquerda ... lobo direito sem nódulos") passed the critical
  R02 gate silently on the locale the benchmark is primarily run on. The four
  regexes are now vowel-aware and plural-tolerant (`direit[ao]s?`/`esquerd[ao]s?`),
  matching the proven `extractLateralityTokens` convention; en-US behavior and
  the contralateral-normal exemption are unchanged. Locked by
  `src/negation.test.ts` (masked swap now caught; no false swap on a correct side
  with a contralateral normal).

## v3.5.0 — LAIBench Pro — clause-scoped negation in the critical-mention filter (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible. This
changes CRIT gating on affected cases (both locales), so `benchmarkVersion`
moves to `3.5.0` and `scoringHash` updates.

### Fixed (correctness — affects scores, safety direction both ways)
- **`extractCriticalMentions` filtered negations at the sentence level and missed
  bare pt-BR pertinent negatives.** It used `isNegated`, which consults only the
  locale `negationPatterns`; pt-BR lacked bare cues (`sem`, `ausentes`, `livres
  de`), while en-US had `without`/`absent`. So a clinically correct pt-BR
  pertinent negative (`Sem hemorragia`, `Sem fratura`) was not filtered and, on
  the no-gold-critical hallucination path, surfaced as an unexpected critical
  mention that force-FAILed the case. The filter now uses the clause-scoped
  `isFindingNegated` on the matched critical term (the predicate the gold path
  and QUAL channel already use), which (a) closes the pt-BR pertinent-negative
  escape and (b) no longer suppresses an affirmed critical that shares a sentence
  with a negated one (`sem desvio da linha média, mas com hematoma subdural
  agudo` now correctly surfaces the hematoma in both locales, instead of the
  whole sentence being dropped). A negated match falls through to the next
  category so a second affirmed critical in the same sentence is still detected.
  Locked by `src/negation.test.ts` (pt-BR/en-US pertinent negatives filtered;
  mixed sentences still detect the affirmed critical in both locales).

## v3.4.0 — LAIBench Pro — confirmed findings with recommendations are no longer dropped (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible. This
closes a critical-gate escape, changing CRIT/QUAL gating for affected cases, so
`benchmarkVersion` moves to `3.4.0` and `scoringHash` updates.

### Fixed (correctness — affects scores, safety direction)
- **A confirmed critical finding that appended a recommendation was dropped from
  the gate.** `isManagementOrDifferentialGold` matched the whole gold string
  against one management/differential regex, so `massa pulmonar suspeita,
  recomenda-se biopsia` (a confirmed suspicious mass plus a recommendation)
  matched `recomenda-se`/`biopsia` and was classified management. It was then
  removed from `criticalLabels` (crit.ts) and `scoredGoldFindings` (qual.ts), so
  omitting the mass triggered no `CG01`/`CG02`/`QG02` failure: a critical
  omission could reach `CRIT = 100`. The classifier now short-circuits as exempt
  only on genuine uncertainty/differential phrasing (`não se podendo afastar`,
  `não sendo possível afastar`, `consider a hipótese`), and for management verbs
  exempts only when no confirmed finding clause remains after the recommendation
  clauses are stripped. Confirmed findings with appended recommendations are
  scored again; pure recommendations and hedged differentials stay exempt
  (intentional uncertainty-exemption tests still pass). Locked by
  `src/clinical-match.test.ts`.

## v3.3.0 — LAIBench Pro — per-dimension critical cap parity (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible (no field
renamed or removed). This corrects per-dimension scores for cases where a
gold-critical evaluator emits a high numeric score alongside a failed critical
check, so `benchmarkVersion` moves to `3.3.0` and `scoringHash` updates.

### Fixed (correctness — affects scores)
- **Two scorers disagreed on the critical-failure dimension cap.**
  `scoreDimensions` caps a dimension score when it has critical failures
  (`min(score, max(20, 60 - ...))`), but the production path
  `scoreDimensionsWithEvaluators` took the evaluator score verbatim and never
  re-applied that cap. A gold-critical CRIT evaluator emitting, for example, 88
  alongside a failed critical check kept `CRIT = 88`, inflating `averagePerDim`
  (the per-dimension leaderboard column that ranks models on critical-finding
  competence) and the `min(det, judge)` combine input, so two models with
  different critical-miss counts could show indistinguishable dimension scores.
  The evaluator overlay now re-applies the identical critical and major caps.
  Case verdicts are unchanged (a failed critical check still hard-FAILs the case
  via the existing veto); only the per-dimension number is corrected downward.
  Locked by parity tests in `scoreDimensionsWithEvaluators`. Resolves the
  tracked two-scorer divergence.

## v3.2.0 — LAIBench Pro — exact measurement matching (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible (internal
helper change only, no field renamed or removed). This changes scores for cases
with measurement size errors, so `benchmarkVersion` moves to `3.2.0` on the
lite-public suites and the provenance `scoringHash` updates automatically.

### Fixed (correctness — affects scores)
- **Measurement preservation was naive substring containment.** `measurementPresent`
  (in `evaluators/qual.ts` and `evaluators/structural.ts`) tested
  `normalizedReport.includes(normalizedMeasurement)`, so gold `2 cm` scored as
  preserved inside a report stating `12 cm`, `3 mm` inside `13 mm`, and `1,5 cm`
  inside `11,5 cm`. A tenfold size error, one of the most clinically dangerous
  mistakes a report can make, was counted as a correct measurement at `QG04`
  (QUAL), `R04` (RAG, major), and inflated the QUAL partial-match bonus.
  Matching is now exact-boundary: a digit or decimal point immediately to the
  left of the candidate disqualifies it (`(?<![\d.])`), so `2cm` no longer
  matches inside `12cm` or `1.5cm`. True matches are preserved, including
  comma/dot, trailing `.0`, and multi-axis (`18 x 12 x 15 mm`) forms. Locked by
  `src/evaluators/measurement.test.ts` (size errors fail at R04 and QG04 on both
  locales; true matches still pass).

### Reporting fixes (no score change, benchmarkVersion unchanged)
- **Bootstrap p-value could report `0.0000`.** `pairedBootstrap` (`src/kappa.ts`)
  computed the two-sided p-value as `extreme / nResamples`, so when no centered
  resample was as extreme as the observed difference it returned exactly 0, an
  impossible Monte-Carlo certainty surfaced at the headline discrimination claim
  (`discriminate()` and the consolidated report). It now uses the Davison and
  Hinkley (1997) add-one estimator `(extreme + 1) / (nResamples + 1)`, bounded
  below by `1/(N+1)`. `meanDiff`, the CI, and every case score/verdict are
  unchanged, so `benchmarkVersion` does not move.

## v3.1.0 — LAIBench Pro — scoring safety and anti-aesthetic hardening (affects scores)

CLI contract and run-artifact JSON schema remain backward compatible (no field
renamed or removed). This wave changes scores in the safety direction, so it is
a minor version bump and `benchmarkVersion` moves to `3.1.0` on the lite-public
suites. The provenance `scoringHash` changes automatically because the scoring
sources changed.

### Anti-aesthetic guarantees (affects scores)
- **Form never rescues substance (anti-compensation cap).** `TERM` (20%) and
  `GUIDE` (15%) together are 35% of the weighted score, enough to average a
  clinically mediocre report up into the PASS band. A case can no longer reach
  PASS while a clinical dimension (`CRIT` or `QUAL`) is itself below the PASS
  threshold; the overall is capped just under PASS with gate reason
  `anti-compensation: <dim> below PASS`. A clinically strong report whose only
  weakness is a form dimension still PASSES. Locked by tests.
- **Severity-weighted no-gold fallback.** The `QUAL` and `CRIT` structural
  fallback paths scored `passed/total` unweighted, so a minor formatting check
  counted as much as a critical content check. They are now severity-weighted
  (critical 4, major 2, minor 1), consistent with the `GUIDE`/`RAG` fallbacks.
  A lone minor aesthetic miss barely dents the score; a critical miss tanks it.
- **Synthesis detector padding resistance.** The synthesis distance metric now
  counts only clinically grounded added tokens (present in the case gold,
  critical findings, or reference) when enough clinical vocabulary exists to
  judge it, so a model cannot escape the copy penalty by padding with
  non-clinical filler. Falls back to the raw count on thin cases to avoid new
  false positives. `clinicalAddedTokens` is surfaced in the `QG07` evidence.

### Fixed (correctness — affects scores)
- **Judge score-scale inflation (safety direction).** `combineScores` used a
  per-value rule (`value <= 5 ? value * 20`) to auto-detect a 0-5 Likert score
  versus a 0-100 score. The judge contract requests 0-100, so a genuinely
  catastrophic dimension (for example `CRIT = 3` out of 100) fell into the `<= 5`
  branch and was multiplied into a passing `60`, with a hard discontinuity at the
  5/6 boundary. That inflated the worst reports, which is the unsafe failure
  direction for a safety benchmark. Scale is now decided once at the RESULT
  level: a result is read as Likert only when EVERY emitted dimension score is
  `<= 5`. A low score sitting next to normal scores is now read as a genuine
  0-100 low score. The 0-5 Likert convention used by calibration fixtures is
  preserved (a result whose dimensions are all `<= 5` still scales by 20).
  Residual limit, documented inline: a fully catastrophic 0-100 result whose
  every dimension is `<= 5` is still treated as Likert because it cannot be
  distinguished without an explicit scale; conservative-min and the critical
  veto catch that case. Locked by boundary tests at 0/1/5/6/100 and a
  mixed-magnitude test proving `CRIT = 3` no longer inflates.

## Unreleased — positioning and provenance (docs only, no scoring change)

- Added an explicit "Open vs controlled" section to the README and to
  DATA_ACCESS_POLICY.md: the separate public LAIBench (2,670 cases) is the open,
  downloadable artifact; the LAIBench Pro gold suite (120 controlled pt-BR
  cases) is controlled and aggregate-only and cannot be reconstructed or
  downloaded from this repository. Open-benchmark language must not attach to
  the Pro gold suite.
- Documented case provenance: public demonstration cases are synthetic and
  input-only; the controlled pt-BR cases are synthetic and were authored and
  clinically reviewed by senior radiologists in Sao Paulo, SP, Brazil. This is
  an internal data-quality process, stated as distinct from independent
  third-party adjudication (vendor-versus-external kappa), which remains future
  work and is not claimed.
- Added a first-party disclosure to the public leaderboard data and rendering
  (see v3.1.0 leaderboard segregation work).

## Unreleased — 2026-06-15 — Private 120-case audit suite

- Expanded the gated pt-BR controlled suite from 49 to 120 private cases using a
  deterministic reconstructed-audit importer.
- Added modality/anatomy/complexity quotas covering CT, MRI, ultrasound,
  radiography and mammography strata.
- Current private suite composition: 54 critical-safety cases and 23
  negative-control cases. Public score claims still require a production-agent
  rerun on the exact 120-case suite hash.
- Updated the public site copy so API and leaderboard pages do not publish
  generic harness tutorials, private product endpoints, API keys, frozen
  predictions or unrelated model-integration recipes.

## v3.0.0 — 2026-06-10 — LAIBench Pro

Optimized, hardened, and expanded. CLI contract and run-artifact JSON schema
remain backward compatible (suites accept both `benchmarkName: "laibench"` and
`"laibench-pro"`); correctness fixes change scores, so this is a major bump.

### Fixed (correctness — affects scores)
- **Modality classification**: `radiografia`/`radiograph` → XR and
  `ultrassonografia`/`ultrasound` → US across full forms, abbreviations
  (TC/RM/USG/RX/CTA) and word-internal matches. The prior word-boundary regexes
  misclassified most exams as CT, applying the wrong coverage matrix/title checks.
- **Report-language contract (`T-LANG`)**: a report in the wrong language for the
  suite locale is flagged with evidence instead of silently passing TERM while
  CRIT/QUAL emit misleading "finding not found" failures.
- **Clause-scoped negation** (`isFindingNegated`/`hasNegationCue`): negation is
  evaluated per clause; pertinent negatives are no longer counted as hallucinated
  critical findings (false positives in the critical extractor removed).
- **Laterality (`R02`)**: negated contralateral statements ("left lobe without
  nodules") are no longer mis-detected as laterality swaps.
- **Gate integrity**: a curated allowlist of safety/contract-critical structural
  checks (C01 contrast, C03* banned phrases, C04 foreign HTML, C07 preservation,
  C08 boilerplate, T-LANG, Q07 placeholders, Q09 ultrasound-technique) now reach
  the verdict gate even when an evaluator scores their dimension; the dimension
  score still comes from the evaluator (no double-counting).
- **`QG01`**: missing only minor findings is a deduction, not a hard gate.
- **`gateReasons`**: no longer polluted with "adversarial phase unavailable"
  (reported via `phaseStatus: "degraded"`).
- **`Q02`** title abbreviation downgraded from critical gate to minor deduction.
- **en-US `lymphadenopathy`** removed from forbidden terms (it is the standard
  English term; the rule was a pt-BR carry-over).

### Added
- **Impression synthesis (`QG06`)**: the impression must reflect the principal
  finding; copying a normal sentence as the impression is penalized.
- **8 new hard synthetic cases per locale** (12 total): CTA stroke, mammography
  BI-RADS, CTA pulmonary embolism, splenic trauma, Fleischner nodule, knee MRI,
  thyroid TI-RADS, subtle subdural.
- Suite-level concurrency, global throttle, generator-exception isolation,
  shared `fetchWithRetry` with timeouts/jitter, typed provider errors, regex
  caches, memoized suite loading.
- `scripts/run-to-predictions.mjs`, `scripts/build-site-data.mjs`.
- Regression tests: `classify.test.ts`, `negation.test.ts` (249 tests total).

## v2.0.0 — 2026-05-09 — Reference-grade validation (iter2)

Iter2 hardens iter1 against the bugs surfaced in self-review. Score moved from
7.4 → ~9 by closing every issue I raised against my own work.

### Fixed
- **Determinism**: `measurement_scramble` and `critical_invent` now use a seeded
  splitmix32 PRNG keyed on (caseId, kind) instead of `Math.random()`. Reruns
  produce identical perturbations.
- **Dead code in `krippendorffAlphaInterval`**: removed redundant accumulator,
  cleaned the Hayes & Krippendorff (2007) implementation.
- **`DEFAULT_SCORING_FILES` correctness**: removed stale `evaluators/term.ts`
  reference, added `classify.ts`. `buildProvenanceManifest` now FAILS LOUD when
  a listed file is missing instead of silently skipping it.
- **`scanContamination` evasion**: now whitespace-insensitive (lowercase +
  strip whitespace) and also scans `sanitizedHtml`. Trivial canary splits
  (`abc def` for token `abcdef`) no longer evade detection.
- **`critical_drop` partial drop**: now removes EVERY declared critical finding
  from the report, not just the first.
- **`structure_break` weakness**: also strips section labels (Técnica, Achados,
  Conclusão, Technique, Findings, Impression).
- **CLI parser one-value bug**: `--inputs A B C` now consumes all three values
  instead of only `A`. Repeated `--flag X --flag Y` form still works.
- **Sparse terminology rules**: `TERM_CORRUPT_PT` 6 → 32 rules,
  `TERM_CORRUPT_EN` 6 → 32 rules, covering attenuation, density, contrast,
  enhancement, vascular, lymph, opacity, consolidation, atelectasis, etc.
- **Negation patterns**: PT-BR 4 → 6 (added `ausente`, `negativ(o|a) para`),
  en-US 3 → 6 (added `absent`, `negative for`, `without`).
- **Laterality flip gender preservation**: `direita ↔ esquerda` now preserves
  feminine/masculine suffix correctly.

### Added (iter2)
- **`src/report.ts`**: consolidated `buildConsolidatedReport` +
  `reportToMarkdown`. Pulls primary (n + mean + 95% CI + per-dim), contamination
  scan, calibration verdict, paired discrimination vs baseline, perturbation
  catch rate, and provenance hash chain into one publishable artifact.
- **`report` CLI command**: `--run X --baseline Y --calibration A B
  --perturb-report P --provenance V --out json --markdown md`.
- **`perturb-run` CLI command**: one-shot pipeline (build matrix → submit as
  predictions per kind → score → emit per-kind catch rates + verdict).
- **`buildPerturbationDataset(cases, options)`**: programmatic helper to build
  the (cases × kinds) prediction set without the CLI.
- **Multi-baseline mocks**: `examples/mock-good.mjs`, `mock-medium.mjs`,
  `mock-bad.mjs` (deterministic, FNV-seeded). Smoke scripts:
  `smoke:good`, `smoke:medium`, `smoke:bad`, `smoke:baselines`,
  `smoke:discriminate`, `smoke:perturb`, `smoke:full-leaderboard`.
- **Integration tests**: `src/perturb-eval.integration.test.ts` simulates the
  full perturb-run pipeline (per-kind sub-runs → catch summary). 5 new tests.
- **`src/report.test.ts`**: validates `buildConsolidatedReport` and
  `reportToMarkdown` against synthetic runs. 3 new tests.
- **`.github/workflows/ci.yml`**: matrix Node 20 + 22, runs typecheck, full
  test suite, plus 6 smoke commands (mock suite, leaderboard, bootstrap,
  contamination, provenance, perturb-run). Uploads `runs/` as artifact.
- **`docs/MIGRATION.md`**: v1 → v2 migration guide with one-liner upgrade
  diff and opt-in feature snippets.
- **Per-kind catch-rate reference**: a smoke run on `lite-public.pt-BR`
  (40 perturbations across 5 cases) shows 100% catch on laterality_flip,
  measurement_scramble, terminology_corrupt, and structure_break under
  deterministic-only scoring, and 0% on negation/critical kinds (judge
  required). Methodology in `docs/laibench-leaderboard-methods.md`. (The
  bundled preprint is the separate "Beyond Templates" conceptual companion
  paper, which does not describe the benchmark; a dedicated LAIBench methods
  paper is forthcoming.)

### Test count: 214 (was 169 in iter1, 105 in v1).

## v2.0.0-iter1 — 2026-05-09 — Reference-grade validation (validation layers)

Promoted from "good benchmark" to "reference area benchmark" by adding the four
validation layers a reviewer needs to trust a leaderboard.

### Added

- **`src/kappa.ts`** — Cohen's κ (two raters, nominal), Fleiss' κ (N raters,
  nominal), Krippendorff's α (N raters, interval, NaN-tolerant), paired
  bootstrap test for two paired numeric series. Landis–Koch and content-analysis
  interpretation labels.
- **`src/discriminate.ts`** — `discriminate(runA, runB)` returns overall mean
  difference with 95% bootstrap CI and p-value, per-dim breakdown, per-modality
  and per-difficulty stratified deltas (n ≥ 5), stratum-collapse warnings, and
  a verdict ∈ {discriminates, weak, fails}. `summarizeReferenceProbe` for the
  gold-as-output sanity check.
- **`src/calibrate.ts`** — `calibrateJudges(runs)` computes test-retest α (same
  judge, multiple runs), cross-judge κ (verdict) + α (overall), and det↔judge
  Spearman ρ. `scanContamination(run)` flags canary-token leakage and
  judge-flagged contamination signals.
- **`src/perturb.ts`** — Eight adversarial perturbation classes (laterality
  flip, negation drop/insert, measurement scramble, critical drop/invent,
  terminology corrupt, structure break) with declared expected dim + severity.
  `applyPerturbation`, `buildPerturbationMatrix`, `summarizeRobustness`.
- **`src/perturb-eval.ts`** — Catch-rule logic (`isPerturbationCaught`) with
  three-way trigger (det check fail / judge critical / dim score floor) and
  severity-indexed thresholds (60 / 80 / 90 for critical / major / minor).
- **`src/provenance.ts`** — Reproducibility hash chain: `caseHash → suiteHash →
  scoringHash → runHash → leaderboardHash` (SHA-256, order-independent at
  suite/leaderboard layer). `buildProvenanceManifest` emits a top-level
  manifest covering all suites and pinned scoring code at publication time.
- **CLI commands**: `discriminate`, `calibrate`, `contamination`,
  `perturb-matrix`, `bootstrap`, `provenance`.
- **64 new tests** across `src/kappa.test.ts`, `src/discriminate.test.ts`,
  `src/calibrate.test.ts`, `src/perturb.test.ts`, `src/perturb-eval.test.ts`,
  `src/provenance.test.ts`. 169 total, all passing.
- **Validation methodology** documented in
  `docs/laibench-leaderboard-methods.md` (reference-grade validation
  infrastructure, reproducibility, threats to validity, versioning), relying on
  the agreement/CI statistics Cohen, Fleiss, Krippendorff, Hayes & Krippendorff,
  Landis & Koch, Efron & Tibshirani, McNemar, and Bachour. (The bundled
  "Beyond Templates" preprint is a separate conceptual companion and does not
  describe the benchmark; a dedicated LAIBench methods paper is forthcoming.)

### Changed

- `package.json` version bumped to `2.0.0`.
- All suite manifests bumped `benchmarkVersion` to `"2.0.0"`.
- Description: now "Reference benchmark for radiology report generation".
- `README.md` rewritten around the v2 reference-validation story.

### Backwards compatibility

- Every v1 case file remains valid. v1 runs replay against v2 scoring without
  schema changes.
- v1 CLI commands unchanged.

## v1.0.0 — 2026-04 — First public release

- 62 reference cases (49 pt-BR + 13 en-US) + 2,670 corpus cases + 96 complex
  supplement + 4 challenge suites, extracted from controlled non-distributed source material.
- Five-dimension scoring (CRIT, QUAL, TERM, GUIDE, RAG) on 0–100% scale with
  conservative `min(det, adv)` combination.
- Five dedicated evaluators (severity-weighted finding matching, negation-aware
  critical detection, modular guideline engines for 7 classification systems,
  IR metrics, locale-specific terminology).
- Locale-pluggable evaluation for pt-BR and en-US.
- Three configurable policy profiles (strict / research / leaderboard).
- Three provider backends (openrouter, openai-compatible, command) with
  retry/backoff and SIGINT-safe partial saves.
- Submission validation, eligibility gates, per-difficulty stratified
  leaderboards.
- Bootstrap CI, McNemar's test, Cohen's h. 105 tests.
