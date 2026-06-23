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
   "suiteHash": "013cfb0d91d7ec0aca31ed5e6748c0e851d060cfaa52fb7c1274aeed46ce6d5c",
   "cases": 49,
   "track": "agent",
   "scoring": "conservative-min",
   "entries": [
    {
     "system": "Nemotron 3 Super 120B · NVIDIA",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.609,
     "allPass": 0.02,
     "criterionPass": 0.795,
     "clinicalScore": 0.609,
     "strictPass": 0.02,
     "dims": {
      "CRIT": 0.997,
      "QUAL": 0.7070000000000001,
      "TERM": 0.971,
      "GUIDE": 0.242,
      "RAG": 0.8220000000000001
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "Nemotron 3 Nano Omni 30B · NVIDIA",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.608,
     "allPass": 0,
     "criterionPass": 0.82,
     "clinicalScore": 0.608,
     "strictPass": 0.061,
     "dims": {
      "CRIT": 1,
      "QUAL": 0.8029999999999999,
      "TERM": 0.977,
      "GUIDE": 0.235,
      "RAG": 0.8590000000000001
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "North Mini Code · Cohere",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.6,
     "allPass": 0,
     "criterionPass": 0.813,
     "clinicalScore": 0.6,
     "strictPass": 0.040999999999999995,
     "dims": {
      "CRIT": 0.992,
      "QUAL": 0.7859999999999999,
      "TERM": 0.9690000000000001,
      "GUIDE": 0.247,
      "RAG": 0.899
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "Laguna M.1 · Poolside",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.595,
     "allPass": 0,
     "criterionPass": 0.764,
     "clinicalScore": 0.595,
     "strictPass": 0,
     "dims": {
      "CRIT": 0.976,
      "QUAL": 0.617,
      "TERM": 0.941,
      "GUIDE": 0.257,
      "RAG": 0.693
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "Nemotron 3 Ultra 550B · NVIDIA",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.594,
     "allPass": 0,
     "criterionPass": 0.797,
     "clinicalScore": 0.594,
     "strictPass": 0,
     "dims": {
      "CRIT": 0.995,
      "QUAL": 0.693,
      "TERM": 0.9620000000000001,
      "GUIDE": 0.285,
      "RAG": 0.825
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "gpt-oss-120b · OpenAI",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.594,
     "allPass": 0,
     "criterionPass": 0.7659999999999999,
     "clinicalScore": 0.594,
     "strictPass": 0,
     "dims": {
      "CRIT": 0.981,
      "QUAL": 0.613,
      "TERM": 0.9440000000000001,
      "GUIDE": 0.285,
      "RAG": 0.667
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "Gemma 4 31B · Google",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.591,
     "allPass": 0.02,
     "criterionPass": 0.799,
     "clinicalScore": 0.591,
     "strictPass": 0.02,
     "dims": {
      "CRIT": 0.9890000000000001,
      "QUAL": 0.736,
      "TERM": 0.9690000000000001,
      "GUIDE": 0.249,
      "RAG": 0.882
     },
     "latencyMs": null,
     "track": "model"
    },
    {
     "system": "gpt-oss-20b · OpenAI",
     "kind": "open-model",
     "group": "open-model",
     "score": 0.583,
     "allPass": 0,
     "criterionPass": 0.8140000000000001,
     "clinicalScore": 0.583,
     "strictPass": 0.02,
     "dims": {
      "CRIT": 0.9890000000000001,
      "QUAL": 0.804,
      "TERM": 0.946,
      "GUIDE": 0.262,
      "RAG": 0.8540000000000001
     },
     "latencyMs": null,
     "track": "model"
    }
   ],
   "reliability": null,
   "reliabilityRuns": 0,
   "disclosure": "Disclosure: the ranked production agent (Laudos.AI) is a first-party system built by the same team that maintains LAIBench Pro. Free and open model rows are diagnostic comparisons only and are never ranked against the first-party production agent. Calibration fixtures are harness sanity checks, not product claims. The public demonstration cases are synthetic and input-only; they were not clinically reviewed and must not be used to claim clinical validation. The controlled pt-BR suite is synthetic and was authored and reviewed by senior radiologists in Sao Paulo, SP, Brazil as an internal data-quality process; this is not an independent third-party validation, and the suite is aggregate-only and is not an open-download benchmark. Independent external adjudication (vendor-versus-external inter-rater kappa) is tracked as future work and is not claimed here.",
   "note": "Controlled benchmark preview. Production agents are ranked separately from free/open model comparisons and calibration fixtures. The public board excludes case JSON, answer keys, frozen predictions and corpus provenance. The pt-BR controlled suite is gated and must not be treated as an open-download benchmark. Score is weighted clinical fidelity score. Strict all-pass means zero-failure cases: every criterion in a case passes simultaneously, and any critical failure forces FAIL instead of being averaged into PASS. Runs are reproducible only inside the controlled adjudication environment. <a href=\"#methods\">Methods</a>."
  }
 }
};
