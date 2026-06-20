window.LAIBENCH_DATA = {
 "generatedAt": null,
 "locales": {
  "pt-BR": {
   "suite": "lite-public.pt-BR",
   "suiteHash": "b7f412e25a71352072d525c9bee9d7630818eb09996d172e9c2664224d7b2217",
   "cases": 120,
   "track": "agent",
   "scoring": "conservative-min",
   "entries": [
    {
     "system": "Laudos.AI",
     "kind": "product-agent",
     "group": "production",
     "score": 0.9,
     "allPass": 0.492,
     "criterionPass": 0.976,
     "clinicalScore": 0.9,
     "strictPass": 0.733,
     "dims": {
      "CRIT": 0.977,
      "QUAL": 0.881,
      "TERM": 1,
      "GUIDE": 0.9670000000000001,
      "RAG": 0.983
     },
     "latencyMs": 16991.1,
     "track": "agent",
     "suiteHash": "b7f412e25a71352072d525c9bee9d7630818eb09996d172e9c2664224d7b2217"
    }
   ],
   "reliability": null,
   "reliabilityRuns": 0,
   "disclosure": "Disclosure: the ranked production agent (Laudos.AI) is a first-party system built by the same team that maintains LAIBench Pro. Free and open model rows are diagnostic comparisons only and are never ranked against the first-party production agent. Calibration fixtures are harness sanity checks, not product claims. The public demonstration cases are synthetic and input-only; they were not clinically reviewed and must not be used to claim clinical validation. The controlled pt-BR suite is synthetic and was authored and reviewed by senior radiologists in Sao Paulo, SP, Brazil as an internal data-quality process; this is not an independent third-party validation, and the suite is aggregate-only and is not an open-download benchmark. Independent external adjudication (vendor-versus-external inter-rater kappa) is tracked as future work and is not claimed here.",
   "note": "Controlled benchmark preview. Production agents are ranked separately from free/open model comparisons and calibration fixtures. The public board excludes case JSON, answer keys, frozen predictions and corpus provenance. The pt-BR controlled suite is gated and must not be treated as an open-download benchmark. Score is weighted clinical fidelity score. Strict all-pass means zero-failure cases: every criterion in a case passes simultaneously, and any critical failure forces FAIL instead of being averaged into PASS. Runs are reproducible only inside the controlled adjudication environment. <a href=\"#methods\">Methods</a>."
  },
  "en-US": {
   "suite": "lite-public.en-US",
   "suiteHash": "cb991b30f3f765a2deffcb9c755fe8ce8aa409992efc165d298400dbf99a3ff8",
   "cases": 12,
   "track": "agent",
   "scoring": "conservative-min",
   "entries": [
    {
     "system": "gpt-oss-120b · OpenAI",
     "kind": "open-model",
     "group": "free-open",
     "score": 0.626,
     "allPass": 0,
     "criterionPass": 0.804,
     "clinicalScore": 0.626,
     "strictPass": 0,
     "dims": {
      "CRIT": 0.99,
      "QUAL": 0.667,
      "TERM": 0.977,
      "GUIDE": 0.423,
      "RAG": 0.727
     },
     "latencyMs": 10453.8,
     "track": "agent",
     "suiteHash": "cb991b30f3f765a2deffcb9c755fe8ce8aa409992efc165d298400dbf99a3ff8"
    },
    {
     "system": "Gemma 4 31B · Google",
     "kind": "open-model",
     "group": "free-open",
     "score": 0.579,
     "allPass": 0,
     "criterionPass": 0.8190000000000001,
     "clinicalScore": 0.579,
     "strictPass": 0,
     "dims": {
      "CRIT": 1,
      "QUAL": 0.7509999999999999,
      "TERM": 0.977,
      "GUIDE": 0.36,
      "RAG": 0.951
     },
     "latencyMs": 5932.4,
     "track": "agent",
     "suiteHash": "cb991b30f3f765a2deffcb9c755fe8ce8aa409992efc165d298400dbf99a3ff8"
    },
    {
     "system": "gpt-oss-20b · OpenAI",
     "kind": "open-model",
     "group": "free-open",
     "score": 0.542,
     "allPass": 0,
     "criterionPass": 0.8270000000000001,
     "clinicalScore": 0.542,
     "strictPass": 0.083,
     "dims": {
      "CRIT": 0.883,
      "QUAL": 0.79,
      "TERM": 0.8859999999999999,
      "GUIDE": 0.377,
      "RAG": 0.8140000000000001
     },
     "latencyMs": 16799.7,
     "track": "agent",
     "suiteHash": "cb991b30f3f765a2deffcb9c755fe8ce8aa409992efc165d298400dbf99a3ff8"
    },
    {
     "system": "Nemotron 3 Super 120B · NVIDIA",
     "kind": "open-model",
     "group": "free-open",
     "score": 0.429,
     "allPass": 0,
     "criterionPass": 0.785,
     "clinicalScore": 0.429,
     "strictPass": 0,
     "dims": {
      "CRIT": 0.74,
      "QUAL": 0.586,
      "TERM": 0.735,
      "GUIDE": 0.248,
      "RAG": 0.653
     },
     "latencyMs": 87718.7,
     "track": "agent",
     "suiteHash": "cb991b30f3f765a2deffcb9c755fe8ce8aa409992efc165d298400dbf99a3ff8"
    },
    {
     "system": "Nemotron 3 Ultra 550B · NVIDIA",
     "kind": "open-model",
     "group": "free-open",
     "score": 0.37,
     "allPass": 0,
     "criterionPass": 0.778,
     "clinicalScore": 0.37,
     "strictPass": 0.083,
     "dims": {
      "CRIT": 0.667,
      "QUAL": 0.5379999999999999,
      "TERM": 0.644,
      "GUIDE": 0.264,
      "RAG": 0.639
     },
     "latencyMs": 88586,
     "track": "agent",
     "suiteHash": "cb991b30f3f765a2deffcb9c755fe8ce8aa409992efc165d298400dbf99a3ff8"
    }
   ],
   "reliability": null,
   "reliabilityRuns": 0,
   "disclosure": "Disclosure: the ranked production agent (Laudos.AI) is a first-party system built by the same team that maintains LAIBench Pro. Free and open model rows are diagnostic comparisons only and are never ranked against the first-party production agent. Calibration fixtures are harness sanity checks, not product claims. The public demonstration cases are synthetic and input-only; they were not clinically reviewed and must not be used to claim clinical validation. The controlled pt-BR suite is synthetic and was authored and reviewed by senior radiologists in Sao Paulo, SP, Brazil as an internal data-quality process; this is not an independent third-party validation, and the suite is aggregate-only and is not an open-download benchmark. Independent external adjudication (vendor-versus-external inter-rater kappa) is tracked as future work and is not claimed here.",
   "note": "Controlled benchmark preview. Production agents are ranked separately from free/open model comparisons and calibration fixtures. The public board excludes case JSON, answer keys, frozen predictions and corpus provenance. The pt-BR controlled suite is gated and must not be treated as an open-download benchmark. Score is weighted clinical fidelity score. Strict all-pass means zero-failure cases: every criterion in a case passes simultaneously, and any critical failure forces FAIL instead of being averaged into PASS. Runs are reproducible only inside the controlled adjudication environment. <a href=\"#methods\">Methods</a>."
  }
 }
};
