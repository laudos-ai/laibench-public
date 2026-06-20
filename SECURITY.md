# Security Policy

LAIBench is a **technical benchmark framework**, not a medical device and not a
clinical decision system. Nonetheless we take the integrity and safety of the
code and its published numbers seriously.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for
anything exploitable.

- Email: **oi@laudos.ai** (subject: `LAIBench security`)
- Or use GitHub's private **"Report a vulnerability"** advisory flow on this repo.

We aim to acknowledge within 5 business days.

## In scope

- Secret/credential exposure in the repository or its history.
- Ways to **tamper with a run artifact** so it passes `assertSuiteRunIntegrity`
  while misrepresenting the gated verdict (the critical-finding hard veto must
  never be bypassable at the layer that produces public numbers).
- Scoring-engine defects that let cosmetic quality rescue a missed or fabricated
  critical finding (a violation of the benchmark's prime directive).
- Leakage of private clinical data, answer keys, or hidden scoring criteria.

## Out of scope

- The intentionally-open deterministic scoring engine and public synthetic suite.
- Findings that require committing private data the public guard already blocks
  (`npm run guard:public`).

## Data boundary

This repository ships **synthetic, public-safe** material only. It contains no
raw clinical reports, no private corpus, no hidden test sets, and no answer keys.
If you believe any private artifact has leaked, treat it as a security report and
contact us privately.
