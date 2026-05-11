import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { benchmarkCase } from "./benchmark.js";
import type { BenchCase } from "./types.js";

const benchCase: BenchCase = {
  id: "metadata-rag",
  exam: "Computed Tomography Head",
  findings: "Normal non-contrast CT.",
  retrievalGold: [
    { documentId: "phrase-hepatic-nodule", relevance: 3 },
    { documentId: "phrase-renal-cyst", relevance: 2 },
    { documentId: "phrase-knee-xray", relevance: 0 },
  ],
};

describe("retrieval metadata", () => {
  async function runWithMetadata(metadata: Record<string, unknown>) {
    return benchmarkCase({
      case: benchCase,
      locale: "en-US",
      providerLabel: "command",
      modelLabel: "metadata-agent",
      generator: {
        name: "metadata-agent",
        async run() {
          return {
            html: "<center><b>Computed Tomography Head</b></center><br><b>Technique</b><br>Non-contrast CT.<br><b>Findings</b><br>Normal.<br><b>Impression</b><br>Normal.",
            raw: "ok",
            metadata,
          };
        },
      },
    });
  }

  it("uses generator retrieval metadata for retrievalGold cases", async () => {
    const result = await runWithMetadata({
      retrievedDocIds: ["phrase-hepatic-nodule", "phrase-knee-xray", "phrase-renal-cyst"],
    });

    const ragTrace = result.checks.find((check) => check.id === "RG02");
    assert.ok(ragTrace, "expected retrieval metric checks from generator metadata");
    assert.equal(result.combined.RAG, 92);
  });

  it("accepts public-safe evidenceIds metadata for RAG-aware submissions", async () => {
    const result = await benchmarkCase({
      case: benchCase,
      locale: "en-US",
      providerLabel: "command",
      modelLabel: "metadata-agent",
      generator: {
        name: "metadata-agent",
        async run() {
          return {
            html: "<center><b>Computed Tomography Head</b></center><br><b>Technique</b><br>Non-contrast CT.<br><b>Findings</b><br>Normal.<br><b>Impression</b><br>Normal.",
            raw: "ok",
            metadata: {
              evidenceIds: ["phrase-hepatic-nodule", "phrase-knee-xray", "phrase-renal-cyst"],
            },
          };
        },
      },
    });

    const ragTrace = result.checks.find((check) => check.id === "RG02");
    assert.ok(ragTrace, "expected retrieval metric checks from generator metadata");
    assert.equal(result.combined.RAG, 92);
  });

  it("accepts nested evidence IDs metadata", async () => {
    const result = await runWithMetadata({
      evidence: { ids: ["phrase-hepatic-nodule", "phrase-knee-xray", "phrase-renal-cyst"] },
    });

    const ragTrace = result.checks.find((check) => check.id === "RG02");
    assert.ok(ragTrace, "expected retrieval metric checks from nested evidence metadata");
    assert.equal(result.combined.RAG, 92);
  });

  it("uses public-safe evidenceIds from frozen prediction metadata", async () => {
    const result = await benchmarkCase({
      case: benchCase,
      locale: "en-US",
      providerLabel: "predictions",
      modelLabel: "metadata-agent",
      providedHtml: "<center><b>Computed Tomography Head</b></center><br><b>Technique</b><br>Non-contrast CT.<br><b>Findings</b><br>Normal.<br><b>Impression</b><br>Normal.",
      providedMetadata: {
        evidenceIds: ["phrase-hepatic-nodule", "phrase-knee-xray", "phrase-renal-cyst"],
      },
    });

    const ragTrace = result.checks.find((check) => check.id === "RG02");
    assert.ok(ragTrace, "expected retrieval metric checks from frozen prediction metadata");
    assert.equal(result.combined.RAG, 92);
  });
});
