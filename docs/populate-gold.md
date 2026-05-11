# Gold Data Population

Gold-label population is a private curation workflow for benchmark maintainers. This public note documents the contract without publishing private prompts or reviewer-specific instructions.

## Goal

For each case, produce structured benchmark labels:

- `goldFindings`;
- `criticalFindings`;
- `guidelineExpectations`;
- `patientContext`;
- `difficulty`.

## Requirements

1. Be conservative: never invent findings, measurements, laterality, severity, or guideline labels not supported by the case.
2. Preserve the source language of the clinical finding.
3. Mark critical findings only when the source clearly supports them.
4. Keep negated findings distinct from affirmed findings.
5. Record guideline expectations only when the case clearly triggers a supported system.
6. Return strict JSON that can be validated and reviewed.

## Governance

Gold labels are heuristic or curator-assisted unless a signed radiologist adjudication artifact exists for the exact suite hash. Public claims must distinguish heuristic labels from radiologist-adjudicated labels.

Do not commit private prompts, reviewer notes containing patient identifiers, raw source rows, credentials, hidden judge configuration, or product implementation details.

## Validation

After updating labels, run:

```bash
npm test
npm test
```
