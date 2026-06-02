# License Policy

LAIBench is **source-available**, not open source. This document is a plain-language
summary of what the [LICENSE](LICENSE) permits. The LICENSE file is the controlling
legal text; if anything here conflicts with it, the LICENSE governs.

## In one paragraph

The LAIBench repository — code, schemas, case JSON, website, paper materials, prompts,
examples, and generated artifacts — is **copyright © 2026 Laudos.AI, all rights
reserved**, and is made available **only for authorized review, evaluation, and
submission workflows**. It is licensed under a **Proprietary Source-Available License**.
This is **not** an OSI-approved open-source license: you may read and run the code to
evaluate your own system, but you may not redistribute, modify, or commercialize it
without prior written authorization.

## What you MAY do

- **Read and review** the source, schemas, and documentation.
- **Run the harness locally** to evaluate your own radiology-reporting system against the
  public synthetic demo suite.
- **Reference LAIBench by name** when reporting your own benchmark results (subject to
  [TRADEMARK.md](TRADEMARK.md)).
- **Share your own submitted run artifacts** according to the public submission rules in
  [docs/public-submissions.md](docs/public-submissions.md) and [MODEL_SUBMISSION.md](MODEL_SUBMISSION.md).

## What you MAY NOT do (without prior written authorization from Laudos.AI)

- Copy, publish, **redistribute**, or sublicense the repository or its contents.
- **Modify** the code or create derivative works.
- **Sell**, host, or **expose LAIBench as a service**.
- Reverse engineer the scoring implementation.
- Redistribute or commercialize the LAIBench source, private suites, scoring
  implementation, internal data, or any Laudos.AI product workflow.

## Scope

This license applies to **everything in this repository**, including the case JSON. The
public cases are synthetic and de-identified, but they are still covered by the license —
they are provided for evaluation, not for redistribution.

The **gated/clinical** corpus, hidden test set, answer keys, and private scoring criteria
are **not in this repository** and are not licensed for any public use. Access to those is
governed separately by [DATA_ACCESS_POLICY.md](DATA_ACCESS_POLICY.md).

## Trademarks are separate

The license above covers copyright. The **LAIBench** name and Laudos.AI logos are
trademarks governed by [TRADEMARK.md](TRADEMARK.md), independently of this license.

## No warranty

The materials are provided for authorized review and evaluation only, **without warranty
of any kind**. Any unauthorized use, disclosure, or distribution is prohibited.

## Requesting broader rights

To request redistribution, modification, hosting, commercial, or research rights beyond
the above, contact **oi@laudos.ai**.
