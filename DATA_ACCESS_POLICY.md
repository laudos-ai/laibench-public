# LAIBench Data Access Policy

This repository is public-safe by default. It contains the framework, documentation, schemas, site assets, paper draft materials, and synthetic demonstration inputs.

It does not include the controlled pt-BR cases, full clinical corpus, raw clinical report exports, hidden test set, private answer keys, private scoring criteria, or private production evaluation artifacts.

## Public Data

The only cases that may be published without a separate release review are synthetic demonstration cases under `cases/public/`. They are intended for installation checks, smoke tests, harness review, and open benchmark reproduction.

Public cases are not a representative clinical dataset and must not be used to claim clinical validation. Real-derived, private controlled, or answer-key-bearing fixtures are not public data.

The public demonstration cases are synthetic and input-only. The controlled pt-BR suite is synthetic and was authored and clinically reviewed by senior radiologists in Sao Paulo, SP, Brazil. This is an internal data-quality process. It is not an independent third-party validation, and it does not make the controlled suite an open-download benchmark. This repository ships one runnable public suite — the synthetic `lite-public.en-US` demo set under `cases/public/` — for local reproduction; the controlled `lite-public.pt-BR` suite is gated and aggregate-only (`evaluationMode: cloud-private`, `casesPath: null`), so its case JSON, answer keys, and frozen predictions are not distributed here.

## Controlled Data

The full clinical corpus is not an open-download asset. Any access to real-derived or clinically realistic benchmark data requires written approval and a controlled-access agreement or data-use agreement.

Controlled-access terms must include:

- no redistribution;
- no re-identification attempts;
- no public reposting of cases, prompts, reports, hidden tasks, answer keys, or scoring criteria;
- no model training or fine-tuning on gated data unless explicitly authorized in writing;
- incident reporting for suspected leakage or privacy exposure.

## Private Data

Raw clinical report exports are never public. The official hidden test set remains private and is intended for hosted evaluation or tightly controlled access only.

Automated PHI/PII scanning is not sufficient to approve public release of real-derived text. Manual privacy review, legal review, and ethics or institutional review when applicable are required before expanding or replacing public real-derived fixtures.

The public repository license does not apply to clinical data, gated datasets, private hidden tests, answer keys, or private scoring criteria.

## Release Gates

Before any public repository, public site, paper supplement, or partner package is prepared, run:

```bash
npm run guard:public
```

That gate is intentionally stricter than normal development. It blocks raw tabular exports, private case directories, private-derived fixture markers, calendar-date traces, answer-key material in public case files, and public claims that depend on hidden/private artifacts.
