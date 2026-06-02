# Security Policy

LAIBench is a public, governance-oriented benchmark framework for AI-assisted
radiology reporting. We take both software security and the privacy of any
clinical-style text in this project seriously, and we welcome responsible
disclosure from the community.

If you believe you have found a security issue, a privacy/data-leak issue, or a
threat to the integrity of the public leaderboard, please report it privately
using the process below.

**Maintainer disclosure:** LAIBench is maintained by [Laudos.AI](https://laudos.ai),
a commercial radiology-reporting vendor. This is a potential conflict of
interest. Security and privacy reports are handled per this policy regardless of
their commercial implications, and clinical-safety reports are prioritized over
all other work.

## Supported Versions

Security and privacy fixes are provided for the current `2.x` line of LAIBench.

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | ✅ Yes             |
| < 2.0   | ❌ No              |

The current release is `2.0.0` (see [package.json](package.json) and
[CHANGELOG.md](CHANGELOG.md)). If you are running an older export, please update
before reporting, where feasible.

## Reporting a Vulnerability

**Email:** [oi@laudos.ai](mailto:oi@laudos.ai)

Please use the subject line:

```
[LAIBench-Security] <short description>
```

In your report, include as much of the following as you can:

- A clear description of the issue and its potential impact.
- The affected file paths and, where applicable, line numbers.
- A minimal reproducer, proof-of-concept, or screenshot.
- The LAIBench version or commit you tested against.
- How you would like to be credited, if at all.

**Do not open a public GitHub issue for security or privacy reports.** Public
issues can disclose a vulnerability before it is mitigated. Use email first; a
public issue may be opened later, by mutual agreement, once a fix is in place.

## 🔴 Clinical-Safety and Data-Leak Reports (Report Privately)

This repository is intended to ship **only synthetic, non-clinical demo
content**. The only clinical-style cases included here are the synthetic demo
cases in
[`cases/public/synthetic-demo.pt-BR.json`](cases/public/synthetic-demo.pt-BR.json)
and
[`cases/public/synthetic-demo.en-US.json`](cases/public/synthetic-demo.en-US.json).
The full clinical corpus, hidden test set, answer keys, and private scoring
criteria are **not** in this repository; they are governed by
[DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md).

Because of this, any content in the public repository that looks like it could
identify a real person is, by definition, a leak — and we want to know
immediately.

If you discover content anywhere in this repository (cases, examples, docs,
suites, schemas, site assets, commit history, or anything else) that appears to
be **protected health information (PHI) or personally identifiable information
(PII)** — for example a real patient name, date of birth, document/MRN/CPF
number, hospital identifier tied to a specific clinical episode, or any text that
could allow re-identification of an individual — please treat it as urgent:

1. **Do not share, paste, quote, or screenshot the suspected identifier
   publicly.** Do not open a public GitHub issue.
2. **Email [oi@laudos.ai](mailto:oi@laudos.ai)** using the subject line
   `[LAIBench-Security] suspected PHI/PII`. Point to the location with a
   **redacted** description rather than the raw value — for example:
   "`cases/public/<file>.json`, around line 213, contains an 11-digit number
   that looks like a CPF."
3. **Stop using the affected file** until we confirm it has been remediated.

We commit to:

- Treating clinical-safety and data-leak reports with **priority over all other
  security work**.
- Removing confirmed sensitive content and, where necessary, rewriting the
  affected repository history.
- **Not retaliating** against good-faith reporters.
- Publishing a sanitized summary if any individual was affected, without
  revealing the content of the exposure or the reporter's identity beyond what
  the reporter consents to.

## Other In-Scope Issues

In addition to clinical-safety/PHI leaks, we welcome reports about:

- **Software vulnerabilities** in the harness, the CLI/evaluators, the public
  website, or the CI workflows.
- **Credentials, API keys, or private tokens** accidentally committed to the
  repository.
- **Leaderboard-integrity issues**: contamination, gaming, score forgery, or any
  path through the harness that would let a submitter inflate or alter scores
  without producing compliant outputs. See
  [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md) and the methodology of record in
  [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md)
  for the rules a valid submission must follow.
- **Web vulnerabilities** affecting the public site, such as cross-site
  scripting or prompt-injection-via-rendering.

### Leaderboard-Integrity Reports

If you suspect a published result has been gamed, contaminated, or otherwise
violates the submission rules, email [oi@laudos.ai](mailto:oi@laudos.ai) with:

- The run/model identifiers for the result in question.
- The basis for your suspicion.
- Any supporting evidence (a recomputation difference, a contamination hit,
  prompt/case overlap, etc.).

We investigate by recomputing the result from its recorded predictions and
applying our contamination checks, and we document the outcome in the public
record for that result.

## Response and Disclosure Timeline

We aim to meet the following targets, measured from the time we receive your
report:

| Stage                                   | Target                                          |
| --------------------------------------- | ----------------------------------------------- |
| Acknowledgement of receipt              | Within 3 business days                          |
| Initial triage and severity assessment  | Within 7 calendar days                          |
| Mitigation plan (high/critical)         | Within 30 calendar days                         |
| Public disclosure                       | After mitigation, coordinated with the reporter |

For PHI/PII or other clinical-safety reports we move as quickly as possible and
do not wait for these windows.

### Severity Guidance

- **Critical** — Real PHI/PII exposed in any public surface; or any path that
  lets a submitter alter scores or results belonging to other submissions.
- **High** — A harness bug that produces systematically wrong scores; a website
  vulnerability allowing content modification; or accidental exposure of private
  credentials.
- **Medium** — A harness bug producing locally wrong scores for some cases, or
  contamination of canary content without score impact.
- **Low** — Documentation or rendering bugs, or inconsistencies between
  documents.

## Out of Scope

The following are not security reports and should be raised through ordinary
channels:

- **Local-environment issues** (Node version mismatches, missing dependencies,
  OS-specific build problems) — please file an ordinary GitHub issue.
- **Scoring-methodology disputes** — please open an ordinary issue referencing
  [docs/laibench-leaderboard-methods.md](docs/laibench-leaderboard-methods.md);
  these are not security vulnerabilities.
- **License or trademark questions** — these are governed by
  [LICENSE](LICENSE), the LICENSE_POLICY, and the Trademark Policy, and should be
  sent to [oi@laudos.ai](mailto:oi@laudos.ai) rather than reported as security
  issues.
- **Requests for gated or private data** — these are handled under
  [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md), not this policy.

## Safe Harbor

We will not pursue or support legal action against researchers who, in good
faith:

- Report issues promptly and privately through the channels above.
- Avoid privacy violations, data destruction, and service disruption.
- Do not access, download, retain, or exfiltrate more data than necessary to
  demonstrate the issue — and in particular do not attempt to re-identify any
  individual.

If you are unsure whether your testing is authorized, ask first at
[oi@laudos.ai](mailto:oi@laudos.ai).

## Updates to This Policy

This policy is versioned with the repository. Material changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Contact

[oi@laudos.ai](mailto:oi@laudos.ai)
