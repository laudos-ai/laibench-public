# LAIBench Data Access Policy

This public repository contains only the framework, documentation, schemas, site assets, paper draft materials, and synthetic demonstration cases.

It does not include the clinical corpus, raw clinical reports, hidden test set, answer keys, private scoring criteria, or production evaluation artifacts.

## Public Data

The public cases under `cases/public/` are synthetic demo cases only. They are intended for installation checks, smoke tests, and harness review. They are not a representative clinical dataset and must not be used to claim clinical validation.

## Controlled Data

The full clinical corpus is not an open-download asset. Any access to real-derived or clinically realistic benchmark data requires written approval and a controlled-access agreement or data-use agreement.

Controlled-access terms must include:

- no redistribution;
- no re-identification attempts;
- no public reposting of cases, prompts, reports, hidden tasks, answer keys, or scoring criteria;
- no model training or fine-tuning on gated data unless explicitly authorized in writing;
- incident reporting for suspected leakage or privacy exposure.

## Private Data

Raw clinical reports are never public. The official hidden test set remains private and is intended for hosted evaluation or tightly controlled access only.

Automated PHI/PII scanning is not sufficient to approve public release of real-derived text. Manual privacy review, legal review, and ethics or institutional review when applicable are required before any real-derived clinical text can be released.

The public repository license does not apply to clinical data, gated datasets, private hidden tests, answer keys, or private scoring criteria.

## Regulatory framing

LAIBench is a benchmark framework, not a clinical system, and makes no regulatory claims. Controlled-access data handling is designed to be consistent with applicable data-protection law — including Brazil's **LGPD** (Lei 13.709/2018), the EU **GDPR**, and, where applicable, **HIPAA** — but the project is **not certified** under any of them. Any party granted controlled access remains independently responsible for its own legal basis, data-protection obligations, and institutional/ethics approvals (e.g. CEP/CONEP in Brazil) for its use of the data.

## Contact

- **Controlled-access / data-use requests:** oi@laudos.ai
- **Suspected data leak or privacy exposure:** report privately per [SECURITY.md](SECURITY.md) — do not open a public issue.
