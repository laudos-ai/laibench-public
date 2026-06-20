# Radiologist-Adjudicated Validation Protocol

This protocol defines the locked validation subset required before LAIBench can make stronger stronger public claims.

## Status

No current public LAIBench score should be described as radiologist-adjudicated unless an adjudication file passes `npm run laibench:validate-adjudication`.

## Required File

The adjudication record is a private JSON artifact, not a public site artifact. It must include:

- `schemaVersion`: currently `1.0`;
- `suiteId` and `suiteHash`: exact locked suite under review;
- `lockedAt`: ISO timestamp before model/system generation;
- `caseIds`: ordered IDs included in the subset;
- `adjudicators`: at least two pseudonymous board-certified radiologist reviewers;
- `cases`: one adjudication record per case ID.

Each case record must include:

- `caseId`;
- `goldFindingsReviewed`: `true`;
- `criticalFindingsReviewed`: `true`;
- `guidelineExpectationsReviewed`: `true`;
- `polarityReviewed`: `true`;
- `lateralityReviewed`: `true`;
- `measurementsReviewed`: `true`;
- `criticalResultPolicyReviewed`: `true`;
- `reviewerLabels`: at least two signed reviewer labels.

Each reviewer label must include:

- `reviewerId`;
- `clinicallyAcceptable`: boolean;
- `dimensionVerdicts`: `CRIT`, `QUAL`, `TERM`, `GUIDE`, and `RAG`, each as `PASS`, `PARTIAL`, or `FAIL`;
- `notes`: concise non-identifying rationale;
- `signedAt`: ISO timestamp.

## Agreement Gate

The validation gate reports:

- reviewer count;
- case count;
- clinical acceptability agreement;
- per-dimension exact verdict agreement;
- missing labels or signatures;
- privacy red flags in reviewer notes.

The subset is valid only when:

- at least two adjudicators are present;
- every case ID has labels from at least two known adjudicators;
- all review/signature timestamps are present;
- no reviewer note contains obvious patient identifiers;
- every case has item-level review of finding polarity, laterality, measurements, and whether each `criticalFindings` item is truly an urgent critical result rather than a non-urgent guideline or biopsy recommendation;
- clinical acceptability agreement is at least 80%;
- per-dimension exact agreement is at least 70%.

## Contamination Rules

The adjudication file must never include prompts, provider details, product routes, credentials, raw private corpus rows, patient identifiers, or generated reports outside the adjudicated outputs being reviewed. Reviewer notes should identify clinical reasons, not internal implementation details.

## Claim Rule

If this gate has not passed for the exact suite hash, public wording must remain limited to engineering benchmark readiness and must not claim prospective clinical safety or radiologist-adjudicated validation.
