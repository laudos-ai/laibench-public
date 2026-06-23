/**
 * Regression tests for the multi-agent review hardening pass. Each test pins a
 * concrete defect that was found and fixed so it cannot silently regress.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getDefaultCriticalExtractor } from "./extractors/critical-extractor.js";
import { isFindingNegated, extractClassifications, normalizeClassificationValue, extractCriticalMentions } from "./extract.js";
import { evaluateRetrieval } from "./evaluators/rag.js";
import { evaluateGuidelines } from "./evaluators/guide.js";
import { evaluateQuality } from "./evaluators/qual.js";
import { combineScores, DIMS, WEIGHTS } from "./scoring.js";
import { deriveExamMeta } from "./classify.js";
import { validatePredictions } from "./submission.js";
import { benchmarkSuiteFromPredictions, benchmarkSuiteFromGenerator } from "./benchmark.js";
import { buildJudgePrompt } from "./judge.js";
import type { BenchCase, Dim, DimSummary, SuiteManifest } from "./types.js";

const ext = getDefaultCriticalExtractor();
const meta = (exam: string, findings: string, loc: "en-US" | "pt-BR" = "en-US") => deriveExamMeta(exam, findings, loc);

describe("CRIT matcher: synonym/abbreviation canonicalization (was double-penalty FN+FP)", () => {
  it("'PE' matches gold 'pulmonary embolism' (en-US)", () => {
    const r = ext.detect(["pulmonary embolism"], "<p>Acute PE in the right main pulmonary artery.</p>", "en-US");
    assert.equal(r.recall, 1);
    assert.equal(r.falsePositives.length, 0);
  });
  it("'SAH' matches gold 'subarachnoid hemorrhage'", () => {
    const r = ext.detect(["subarachnoid hemorrhage"], "<p>SAH in the basal cisterns.</p>", "en-US");
    assert.equal(r.recall, 1);
  });
  it("'cerebrovascular accident' matches gold 'acute stroke'", () => {
    const r = ext.detect(["acute stroke"], "<p>Acute cerebrovascular accident, left MCA territory.</p>", "en-US");
    assert.equal(r.recall, 1);
  });
});

describe("CRIT extractor: word-boundary fixes (no fabricated criticals)", () => {
  it("'COPE'/'scope' does NOT extract a pulmonary-embolism critical", () => {
    const mentions = extractCriticalMentions("<p>Patient unable to cope. Endoscope advanced.</p>", "en-US");
    assert.ok(!mentions.some((m) => m.category === "pulmonary-embolism"), JSON.stringify(mentions));
  });
  it("'heatstroke' does NOT extract a stroke critical", () => {
    const mentions = extractCriticalMentions("<p>History of heatstroke.</p>", "en-US");
    assert.ok(!mentions.some((m) => m.category === "stroke"), JSON.stringify(mentions));
  });
});

describe("isFindingNegated: hedge detection is order-independent", () => {
  it("'cannot exclude pneumothorax' (prefix) is non-affirmed", () => {
    assert.equal(isFindingNegated("Cannot exclude pneumothorax", "pneumothorax", "en-US"), true);
  });
  it("'pneumothorax cannot be excluded' (suffix) is non-affirmed", () => {
    assert.equal(isFindingNegated("Pneumothorax cannot be excluded", "pneumothorax", "en-US"), true);
  });
  it("an affirmed finding is still affirmed", () => {
    assert.equal(isFindingNegated("Large left pneumothorax present", "pneumothorax", "en-US"), false);
  });
});

describe("RAG: dedup + non-critical gate", () => {
  const benchCase: BenchCase = {
    id: "r", exam: "ct", findings: "x",
    retrievalGold: [{ documentId: "d1", relevance: 3 }, { documentId: "d2", relevance: 2 }],
  };
  const m = meta("ct", "x");
  it("duplicate retrieved ids cannot push recall/nDCG above 1.0", () => {
    const r = evaluateRetrieval("", benchCase, "en-US", m, [], ["d1", "d1", "d1"]);
    for (const k of Object.keys(r.details)) {
      if (/^(recall|ndcg|precision)@/.test(k) || k === "ndcg" || k === "mrr") {
        assert.ok((r.details[k] as number) <= 1.0001, `${k}=${r.details[k]} exceeds 1.0`);
      }
    }
  });
  it("RAG retrieval-recall check is NOT critical (cannot force-FAIL a clinical report)", () => {
    const r = evaluateRetrieval("", benchCase, "en-US", m, [], ["d2"]); // low recall
    assert.ok(!r.checks.some((c) => c.severity === "critical"), "no RAG check may be critical");
  });
});

describe("GUIDE extraction: canonical notations parse (was false critical-fail)", () => {
  it("TI-RADS TR5 and bare 5 normalize identically", () => {
    assert.deepEqual(extractClassifications("ACR TI-RADS: TR5").map((c) => `${c.system}=${c.normalizedValue}`), ["tirads=5"]);
    assert.equal(normalizeClassificationValue("TI-RADS TR5"), normalizeClassificationValue("TI-RADS 5"));
  });
  it("Lung-RADS 4X and S parse", () => {
    assert.equal(extractClassifications("Lung-RADS 4X")[0]?.normalizedValue, "4X");
    assert.equal(extractClassifications("Lung-RADS S")[0]?.normalizedValue, "S");
  });
  it("LI-RADS TNC parses", () => {
    assert.equal(extractClassifications("LI-RADS TNC")[0]?.normalizedValue, "TNC");
  });
});

describe("GUIDE: Fleischner and Lung-RADS are mutually exclusive on screening", () => {
  it("a screening lung-nodule case does NOT also expect Fleischner", () => {
    const benchCase: BenchCase = {
      id: "g", exam: "Low-dose CT chest lung cancer screening",
      findings: "Pulmonary nodule, screening low-dose CT.",
      guidelineExpectations: [{ guidelineId: "lungrads", expectedClassification: "4A" }],
    };
    const m = meta(benchCase.exam, benchCase.findings);
    const html = "<b>Findings</b><br>Solid pulmonary nodule.<br><b>Impression</b><br>Lung-RADS 4A.";
    const r = evaluateGuidelines(html, benchCase, "en-US", m, []);
    assert.ok(!r.checks.some((c) => c.id.includes("fleischner") && !c.passed), JSON.stringify(r.checks));
  });
});

describe("scoring: rounding must not promote a sub-threshold report across PASS", () => {
  it("a raw overall in [83.95, 84) is NOT graded PASS at threshold 84", () => {
    const dims = {} as Record<Dim, DimSummary>;
    const scores: Record<Dim, number> = { CRIT: 84, QUAL: 84, TERM: 83.75, GUIDE: 84, RAG: 84 };
    for (const d of DIMS) dims[d] = { score: scores[d], pass: 1, total: 1, critFails: 0, verdict: "PASS", appliedWeight: WEIGHTS[d] };
    const r = combineScores(dims, null, []);
    // raw weighted ≈ 83.95; must not be PASS even though it rounds to 84.0
    assert.notEqual(r.verdict, "PASS", `verdict=${r.verdict} overall=${r.overall}`);
  });
});

describe("classify: contrast derivation is locale-symmetric and negation-aware", () => {
  it("en-US enhancement/phase language sets contrast=true", () => {
    assert.equal(meta("CT abdomen", "Arterial phase enhancement with washout on portal phase.", "en-US").contrast, true);
  });
  it("negated 'ausência de realce' does NOT set contrast=true", () => {
    assert.equal(meta("TC cranio sem contraste", "Ausencia de realce anomalo.", "pt-BR").contrast, false);
  });
});

describe("QUAL: hallucination cannot be laundered; verbatim echo is penalized", () => {
  it("a fabrication beside a normality word is still flagged", () => {
    const bc: BenchCase = { id: "h", exam: "ct abdomen", findings: "Right lower lobe consolidation.",
      goldFindings: [{ finding: "right lower lobe consolidation", severity: "major" }] };
    const html = "<b>Findings</b><br>Right lower lobe consolidation. Large hepatic metastasis, liver enzymes normal.<br><b>Impression</b><br>Right lower lobe consolidation.";
    const r = evaluateQuality(html, bc, "en-US", meta("ct abdomen", bc.findings), []);
    const halls = (r.details.hallucinations as Array<{ text: string }>) ?? [];
    assert.ok(halls.some((h) => /metastasis/i.test(h.text)), JSON.stringify(halls));
  });
  it("a verbatim findings→impression echo fails the synthesis check", () => {
    const bc: BenchCase = { id: "e", exam: "ct head", findings: "Small acute subdural hematoma on the left.",
      goldFindings: [{ finding: "acute subdural hematoma", severity: "critical" }], criticalFindings: ["acute subdural hematoma"] };
    const html = "<center><b>CT HEAD</b></center><br><br><b>Findings</b><br>Small acute subdural hematoma on the left.<br><br><b>Impression</b><br>Small acute subdural hematoma on the left.";
    const r = evaluateQuality(html, bc, "en-US", meta("ct head", bc.findings), []);
    const qg07 = r.checks.find((c) => c.id === "QG07");
    assert.equal(qg07?.passed, false, qg07?.evidence);
  });
});

describe("submission validation: schema additionalProperties enforced", () => {
  const cases: BenchCase[] = [{ id: "c1", exam: "ct", findings: "x" }];
  it("rejects an unknown top-level key (e.g. smuggled retrievedDocIds)", () => {
    const v = validatePredictions(cases, [{ instance_id: "c1", model_output: "<p>ok</p>", retrievedDocIds: ["gold"] } as never]);
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /unknown keys/.test(e)), v.errors.join("; "));
  });
  it("accepts the canonical record shape", () => {
    const v = validatePredictions(cases, [{ instance_id: "c1", model_output: "<p>ok</p>", model_name_or_path: "m", metadata: {} }]);
    assert.equal(v.valid, true, v.errors.join("; "));
  });
});

describe("judge prompt: report is fenced with the per-run canary boundary", () => {
  it("wraps REPORT in an unguessable boundary referencing the canary token", () => {
    const prompt = buildJudgePrompt("en-US", "ct head", "finding", "<p>report</p>", "canary-123");
    assert.ok(prompt.includes("REPORT-BOUNDARY-canary-123"), "missing canary-fenced boundary");
    assert.ok(/UNTRUSTED report/.test(prompt), "missing untrusted-content instruction");
  });
});

describe("predictions mode: submitter metadata is not trusted as a scoring input", () => {
  const suite = { id: "s", benchmarkVersion: "0", locale: "en-US" } as unknown as SuiteManifest;
  const cases: BenchCase[] = [{
    id: "c1", exam: "ct", findings: "x",
    retrievalGold: [{ documentId: "gold-1", relevance: 3 }],
  }];
  it("self-reported evidenceIds do NOT score the RAG dimension; latency is not spoofable", async () => {
    const predictions = [{ instance_id: "c1", model_output: "<p>Normal.</p>", metadata: { evidenceIds: ["gold-1"], latencyMs: 1 } }];
    const validation = validatePredictions(cases, predictions);
    const run = await benchmarkSuiteFromPredictions({
      suite, cases, locale: "en-US", predictions, validation,
      runName: "t", provider: "frozen", modelLabel: "t",
    });
    // RAG must NOT earn a perfect IR score from the claimed gold ids — the retrieval
    // metadata is ignored, so it can only fall back to structural scoring (or null).
    assert.notEqual(run.results[0].combined.RAG, 100, "fake citations must not yield a perfect RAG score");
    // latency must be the measured value, never the self-reported 1ms.
    assert.notEqual(run.results[0].latencyMs, 1);
  });
});

describe("orchestration: a throwing generator degrades one case, never the suite", () => {
  const suite = { id: "s", benchmarkVersion: "0", locale: "en-US" } as unknown as SuiteManifest;
  const cases: BenchCase[] = [
    { id: "ok", exam: "ct", findings: "Normal study." },
    { id: "boom", exam: "ct", findings: "Normal study." },
  ];
  it("the suite completes with all cases; the failing case is FAIL", async () => {
    const generator = {
      name: "flaky", scaffoldId: "mini-laibench-agent-v1",
      async run(input: { findings: string }) {
        if (input.findings.includes("Normal")) {
          // throw for the second case only via a counter
        }
        return { html: "<p>ok</p>" } as never;
      },
    };
    let n = 0;
    const flaky = { ...generator, async run() { n += 1; if (n === 2) throw new Error("boom"); return { html: "<center><b>CT</b></center><br>Normal." } as never; } };
    const run = await benchmarkSuiteFromGenerator({
      suite, cases, locale: "en-US", generator: flaky, runName: "t", provider: "p", modelLabel: "m",
    });
    assert.equal(run.results.length, 2, "all cases must be present");
    assert.ok(run.results.some((r) => r.verdict === "FAIL"), "the throwing case must FAIL");
  });
});

// ---- Round-2 re-review fixes ----

describe("CRIT FP suppression is clause-scoped (round 2)", () => {
  it("an affirmed critical sharing a sentence with a negation is still an FP", () => {
    const r = ext.detect([], "No acute findings but acute hemorrhage in the spleen.", "en-US");
    assert.ok(r.falsePositives.some((f) => f.category === "acute-bleed"), JSON.stringify(r.falsePositives));
  });
});

describe("CRIT extractor: bare lowercase 'pe' does not fabricate PE (round 2)", () => {
  it("lowercase 'pe' token is not a pulmonary-embolism critical", () => {
    const r = ext.detect([], "the pe was within normal range.", "en-US");
    assert.ok(!r.falsePositives.some((f) => f.category === "pulmonary-embolism"), JSON.stringify(r.falsePositives));
  });
  it("uppercase 'PE' still detects pulmonary embolism", () => {
    assert.ok(extractCriticalMentions("Acute PE in the right main artery.", "en-US").some((m) => m.category === "pulmonary-embolism"));
  });
});

describe("GUIDE: standalone LR-N / LR-TNC notation parses (round 2)", () => {
  it("'LR-5' and 'LR-TNC' without the LI-RADS prefix extract", () => {
    assert.equal(extractClassifications("Observation classified as LR-5.")[0]?.normalizedValue, "5");
    assert.equal(extractClassifications("LR-TNC")[0]?.normalizedValue, "TNC");
  });
});

describe("QUAL: a fabrication sharing an organ token with a NORMAL gold is still flagged (round 2)", () => {
  it("fabricated 'Liver metastasis' is not laundered by a normal 'Liver' gold", () => {
    const bc: BenchCase = { id: "g", exam: "ct abdomen", findings: "Liver is normal in size. No focal hepatic lesion.",
      goldFindings: [{ finding: "Liver normal, no focal lesion", severity: "incidental" }] };
    const html = "<b>Findings</b><br>Liver demonstrates a 5cm metastatic deposit in the right lobe.<br><b>Impression</b><br>Hepatic metastasis.";
    const r = evaluateQuality(html, bc, "en-US", meta("ct abdomen", bc.findings), []);
    const halls = (r.details.hallucinations as Array<{ text: string }>) ?? [];
    assert.ok(halls.some((h) => /metast/i.test(h.text)), JSON.stringify(halls));
  });
});

describe("orchestration: a generator returning non-string html degrades one case, not the suite (round 2)", () => {
  const suite = { id: "s", benchmarkVersion: "0", locale: "en-US" } as unknown as SuiteManifest;
  const cases: BenchCase[] = [{ id: "a", exam: "ct", findings: "Normal." }, { id: "b", exam: "ct", findings: "Normal." }];
  it("null/number html is coerced; the suite completes with all cases", async () => {
    let n = 0;
    const gen = { name: "bad", scaffoldId: "mini-laibench-agent-v1", async run() { n += 1; return { html: n === 1 ? null : 12345 } as never; } };
    const run = await benchmarkSuiteFromGenerator({ suite, cases, locale: "en-US", generator: gen, runName: "t", provider: "p", modelLabel: "m" });
    assert.equal(run.results.length, 2, "suite must not be aborted by malformed generator output");
  });
});

// ---- Round-3 re-review fixes ----

describe("CRIT extractor: abbreviations are case-sensitive (round 3)", () => {
  it("lowercase 'cva' (costovertebral angle) does not fabricate a stroke", () => {
    assert.ok(!extractCriticalMentions("The left cva is unremarkable.", "en-US").some((m) => m.category === "stroke"));
  });
  it("lowercase 'tep'/'sbo' do not fabricate criticals", () => {
    assert.ok(!extractCriticalMentions("the tep value was normal and sbo workflow ran.", "en-US").some((m) => ["pulmonary-embolism", "bowel-obstruction"].includes(m.category)));
  });
  it("uppercase CVA / TEP / SBO still detect", () => {
    assert.ok(extractCriticalMentions("Acute CVA, left MCA.", "en-US").some((m) => m.category === "stroke"));
    assert.ok(extractCriticalMentions("TEP em arteria pulmonar direita.", "pt-BR").some((m) => m.category === "pulmonary-embolism"));
    assert.ok(extractCriticalMentions("Findings consistent with SBO.", "en-US").some((m) => m.category === "bowel-obstruction"));
  });
});

describe("CRIT FP suppression requires substantive overlap (round 3)", () => {
  it("a fabricated critical sharing only a modifier ('acute') with an unrelated gold is still an FP", () => {
    const r = ext.detect(["acute appendicitis"], "Acute hemorrhage in the spleen.", "en-US");
    assert.ok(r.falsePositives.some((f) => f.category === "acute-bleed"), JSON.stringify(r.falsePositives));
  });
});

describe("QUAL: fabricated malignancy absent from source is flagged (round 3)", () => {
  it("'renal cell carcinoma' fabricated beside a benign 'renal cyst' gold is flagged", () => {
    const bc: BenchCase = { id: "m", exam: "ct abdomen", findings: "Simple cyst in the right kidney.",
      goldFindings: [{ finding: "simple renal cyst", severity: "minor" }] };
    const html = "<b>Findings</b><br>Simple cyst right kidney. Renal cell carcinoma involving the left kidney.<br><b>Impression</b><br>Left renal cell carcinoma.";
    const r = evaluateQuality(html, bc, "en-US", meta("ct abdomen", bc.findings), []);
    const halls = (r.details.hallucinations as Array<{ text: string }>) ?? [];
    assert.ok(halls.some((h) => /carcinoma/i.test(h.text)), JSON.stringify(halls));
  });
  it("a legit malignancy present in the source is NOT flagged", () => {
    const bc: BenchCase = { id: "m2", exam: "ct abdomen", findings: "Hepatic metastasis from known colon carcinoma.",
      goldFindings: [{ finding: "hepatic metastasis", severity: "critical" }] };
    const html = "<b>Findings</b><br>Hepatic metastasis.<br><b>Impression</b><br>Metastatic disease.";
    const r = evaluateQuality(html, bc, "en-US", meta("ct abdomen", bc.findings), []);
    const halls = (r.details.hallucinations as Array<{ text: string }>) ?? [];
    assert.ok(!halls.some((h) => /metasta/i.test(h.text)), JSON.stringify(halls));
  });
});

describe("provenance: runHash binds scoreMode, ignores canaryToken (round 3)", () => {
  const base: Record<string, unknown> = { benchmarkVersion: "1", suiteId: "s", locale: "en-US", track: "model", provider: "p", modelLabel: "m", scaffoldId: "x", judgeProvider: null, judgeModel: null, submissionMode: "predictions", canaryToken: "abc" };
  const mk = (runHash: (a: never) => string, extra: Record<string, unknown>) =>
    runHash({ suiteHash: "h", scoringHash: "sc", manifest: { ...base, ...extra } } as never);
  it("runHash changes with scoreMode and is invariant to canaryToken", async () => {
    const { runHash } = await import("./provenance.js");
    const cm = mk(runHash, { scoreMode: "conservative-min" });
    const jp = mk(runHash, { scoreMode: "judge-primary" });
    const diffCanary = mk(runHash, { scoreMode: "conservative-min", canaryToken: "zzz" });
    assert.notEqual(cm, jp, "scoreMode must change runHash");
    assert.equal(cm, diffCanary, "canaryToken must not change runHash");
  });
});

// ---- Round-4 re-review fixes ----

describe("CRIT: bare 'stroke' excludes non-clinical collocations (round 4)", () => {
  it("'golf stroke' does not fabricate a stroke critical; clinical 'acute/prior stroke' still match", () => {
    assert.ok(!extractCriticalMentions("Improved golf stroke noted.", "en-US").some((m) => m.category === "stroke"));
    assert.ok(extractCriticalMentions("Findings of acute stroke.", "en-US").some((m) => m.category === "stroke"));
    assert.ok(extractCriticalMentions("History of prior stroke.", "en-US").some((m) => m.category === "stroke"));
  });
});

describe("CRIT FP suppression: shared ANATOMY does not bridge unrelated criticals (round 4)", () => {
  it("'aortic atheroma' gold does not suppress a fabricated 'aortic dissection'", () => {
    const r = ext.detect(["aortic atheroma"], "Aortic dissection of the arch.", "en-US");
    assert.ok(r.falsePositives.some((f) => f.category === "aortic-dissection"), JSON.stringify(r.falsePositives));
  });
});

describe("CRIT matcher: confusable prefixes do not cross-match (round 4)", () => {
  it("gold 'fracture' is a miss against 'fractional flow reserve' but matches 'fractures'", () => {
    assert.equal(ext.detect(["fracture"], "Fractional flow reserve normal.", "en-US").recall, 0);
    assert.equal(ext.detect(["fracture"], "Multiple rib fractures.", "en-US").recall, 1);
  });
});

describe("QUAL: a NEGATED malignancy is not flagged by the malignancy guard (round 4)", () => {
  it("'Hepatic hemangioma, no malignancy' is not a hallucination", () => {
    const bc: BenchCase = { id: "n", exam: "ct abdomen", findings: "Hepatic hemangioma.",
      goldFindings: [{ finding: "hepatic hemangioma", severity: "minor" }] };
    const html = "<b>Findings</b><br>Hepatic hemangioma, no malignancy.<br><b>Impression</b><br>Hepatic hemangioma.";
    const r = evaluateQuality(html, bc, "en-US", meta("ct abdomen", bc.findings), []);
    const halls = (r.details.hallucinations as Array<{ text: string }>) ?? [];
    assert.ok(!halls.some((h) => /malignancy|hemangioma/i.test(h.text)), JSON.stringify(halls));
  });
});

describe("provenance: runHash binds judge sampling params (round 4)", () => {
  it("runHash changes when judgeTemperature differs", async () => {
    const { runHash } = await import("./provenance.js");
    const base: Record<string, unknown> = { benchmarkVersion: "1", suiteId: "s", locale: "en-US", track: "model", provider: "p", modelLabel: "m", scaffoldId: "x", judgeProvider: "openrouter", judgeModel: "j", submissionMode: "predictions", scoreMode: "conservative-min", canaryToken: "abc" };
    const h0 = runHash({ suiteHash: "h", scoringHash: "sc", manifest: { ...base, judgeTemperature: 0 } } as never);
    const h1 = runHash({ suiteHash: "h", scoringHash: "sc", manifest: { ...base, judgeTemperature: 1 } } as never);
    assert.notEqual(h0, h1, "judgeTemperature must change runHash");
  });
});

// ---- Round-5 re-review fixes ----

describe("CRIT: bare 'herniation' requires an intracranial qualifier (round 5)", () => {
  it("benign disc/hiatal herniation does not fabricate a mass-effect critical", () => {
    assert.ok(!extractCriticalMentions("Broad disc herniation at L4-L5.", "en-US").some((m) => m.category === "mass-effect"));
    assert.ok(!extractCriticalMentions("Small hiatal herniation of the stomach.", "en-US").some((m) => m.category === "mass-effect"));
  });
  it("intracranial herniation / mass effect still detect", () => {
    assert.ok(extractCriticalMentions("Uncal herniation with brainstem compression.", "en-US").some((m) => m.category === "mass-effect"));
    assert.ok(extractCriticalMentions("Significant mass effect on the lateral ventricle.", "en-US").some((m) => m.category === "mass-effect"));
  });
});

describe("governance: clinical-claim gate is bilingual on BOTH claim and negation (round 5)", () => {
  it("honest PT negated claims pass; PT/EN affirmative claims flag", async () => {
    const { auditReleaseFiles } = await import("./release-guard.js");
    const flagged = (content: string) =>
      auditReleaseFiles([{ path: "site/data.js", content }], "public").some((i) => i.rule === "unsubstantiated-clinical-validation-claim");
    // honest negated (must PASS)
    assert.equal(flagged("Isto nao e uma validacao clinica independente nem validacao de terceiros."), false);
    assert.equal(flagged("These cases are not clinically validated."), false);
    // affirmative / evasion (must FLAG)
    assert.equal(flagged("Cada caso pontuado foi clinicamente validado por radiologistas."), true);
    assert.equal(flagged("Nada e exagerado, e cada caso pontuado foi clinicamente validado por radiologistas."), true);
    assert.equal(flagged("We do not overclaim, and every scored case was clinically validated by radiologists."), true);
  });
});
