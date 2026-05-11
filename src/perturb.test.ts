import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPerturbation, buildPerturbationMatrix, summarizeRobustness, PERTURBATIONS } from "./perturb.js";
import type { BenchCase } from "./types.js";

const ptCase: BenchCase = {
  id: "T1",
  exam: "tc cranio sc",
  findings: "Hematoma intraparenquimatoso parietal direito medindo 2,8 cm. Sem desvio de linha média.",
  locale: "pt-BR",
  criticalFindings: ["Hematoma intraparenquimatoso parietal direito"],
};

const enCase: BenchCase = {
  id: "T2",
  exam: "ct head w/o contrast",
  findings: "Right parietal intraparenchymal hematoma measuring 2.8 cm. No midline shift.",
  locale: "en-US",
  criticalFindings: ["right parietal intraparenchymal hematoma"],
};

describe("applyPerturbation: laterality_flip", () => {
  it("flips direito → esquerdo (pt-BR)", () => {
    const out = applyPerturbation("laterality_flip", ptCase, ptCase.findings);
    assert.match(out, /esquerdo/i);
    assert.doesNotMatch(out, /direito/i);
  });
  it("flips right → left (en-US)", () => {
    const out = applyPerturbation("laterality_flip", enCase, enCase.findings);
    assert.match(out, /\bleft\b/i);
    assert.doesNotMatch(out, /\bright\b/i);
  });
  it("preserves gender suffix in pt-BR (direita ↔ esquerda)", () => {
    const text = "Lesão direita e contralateral esquerda.";
    const out = applyPerturbation("laterality_flip", ptCase, text);
    assert.match(out, /\besquerda\b/);
    assert.match(out, /\bdireita\b/);
  });
});

describe("applyPerturbation: negation operations", () => {
  it("negation_drop removes 'sem'", () => {
    const out = applyPerturbation("negation_drop", ptCase, ptCase.findings);
    assert.doesNotMatch(out, /\bsem\s+/i);
  });
  it("negation_drop removes multiple negation forms", () => {
    const text = "Não há sangramento. Sem fratura. Ausência de massa.";
    const out = applyPerturbation("negation_drop", ptCase, text);
    assert.doesNotMatch(out, /\bsem\s+/i);
    assert.doesNotMatch(out, /\bnão\s+há\s+/i);
    assert.doesNotMatch(out, /\bausência\s+de\s+/i);
  });
  it("negation_drop removes 'no '", () => {
    const out = applyPerturbation("negation_drop", enCase, enCase.findings);
    assert.doesNotMatch(out, /\bno\s+/i);
  });
  it("negation_insert prefixes a clause", () => {
    const out = applyPerturbation("negation_insert", ptCase, ptCase.findings);
    assert.match(out, /não há/i);
  });
  it("negation_insert falls back to prepending when no period present", () => {
    const text = "Hematoma agudo";
    const out = applyPerturbation("negation_insert", ptCase, text);
    assert.match(out, /não há/i);
  });
});

describe("applyPerturbation: measurement_scramble (deterministic)", () => {
  it("changes numeric values but preserves units", () => {
    const out = applyPerturbation("measurement_scramble", ptCase, ptCase.findings);
    assert.match(out, /\d+,\d+\s*cm/);
    assert.notEqual(out, ptCase.findings);
  });
  it("is deterministic per (caseId, kind) — re-running yields identical text", () => {
    const a = applyPerturbation("measurement_scramble", ptCase, ptCase.findings);
    const b = applyPerturbation("measurement_scramble", ptCase, ptCase.findings);
    assert.equal(a, b);
  });
  it("different case IDs yield different scrambles", () => {
    const otherCase: BenchCase = { ...ptCase, id: "T1-other" };
    const a = applyPerturbation("measurement_scramble", ptCase, ptCase.findings);
    const b = applyPerturbation("measurement_scramble", otherCase, ptCase.findings);
    assert.notEqual(a, b);
  });
});

describe("applyPerturbation: critical_drop / critical_invent", () => {
  it("critical_drop removes a sentence containing the critical keyword", () => {
    const out = applyPerturbation("critical_drop", ptCase, ptCase.findings);
    assert.doesNotMatch(out, /Hematoma intraparenquimatoso/i);
  });
  it("critical_drop removes ALL declared critical findings", () => {
    const multi: BenchCase = {
      ...ptCase,
      criticalFindings: ["hematoma", "hemorragia", "edema"],
    };
    const text = "hematoma agudo. hemorragia subaracnoidea. edema cerebral. estrutura normal.";
    const out = applyPerturbation("critical_drop", multi, text);
    assert.doesNotMatch(out, /hematoma/i);
    assert.doesNotMatch(out, /hemorragia/i);
    assert.doesNotMatch(out, /edema/i);
  });
  it("critical_invent inserts a fabricated finding", () => {
    const out = applyPerturbation("critical_invent", ptCase, ptCase.findings);
    assert.ok(out.length > ptCase.findings.length);
    assert.notEqual(out, ptCase.findings);
  });
  it("critical_invent is deterministic per (caseId, kind)", () => {
    const a = applyPerturbation("critical_invent", ptCase, ptCase.findings);
    const b = applyPerturbation("critical_invent", ptCase, ptCase.findings);
    assert.equal(a, b);
  });
});

describe("applyPerturbation: terminology + structure (expanded)", () => {
  it("terminology_corrupt swaps canonical → colloquial across many rules", () => {
    const text = "Identificado edema cerebral, derrame pleural à direita, hemorragia, infarto do miocárdio, calcificação aórtica, nódulo pulmonar.";
    const out = applyPerturbation("terminology_corrupt", ptCase, text);
    assert.match(out, /inchaço/);
    assert.match(out, /água no pulmão/);
    assert.match(out, /sangramento/);
    assert.match(out, /ataque/);
    assert.match(out, /endurecimento/);
    assert.match(out, /bolinha/);
  });
  it("terminology_corrupt en-US covers ≥10 distinct terms", () => {
    const text = "edema, hemorrhage, contrast, enhancement, nodule, mass, cyst, fibrosis, perfusion, atelectasis";
    const out = applyPerturbation("terminology_corrupt", enCase, text);
    let hits = 0;
    for (const colloquial of ["swelling", "bleeding", "dye", "shine", "spot", "lump", "blister", "scarring", "circulation", "lung collapse"]) {
      if (out.toLowerCase().includes(colloquial)) hits++;
    }
    assert.ok(hits >= 10, `expected ≥10 colloquial substitutions, got ${hits}`);
  });
  it("structure_break strips required tags AND section labels", () => {
    const html = "<center><b>RAIO-X</b></center><br>Técnica: rotina<br>Achados: normais<br>Conclusão: sem alterações.";
    const out = applyPerturbation("structure_break", ptCase, html);
    assert.doesNotMatch(out, /<center>/);
    assert.doesNotMatch(out, /<b>/);
    assert.doesNotMatch(out, /<br/);
    assert.doesNotMatch(out, /Técnica:/i);
    assert.doesNotMatch(out, /Achados:/i);
    assert.doesNotMatch(out, /Conclusão:/i);
  });
});

describe("buildPerturbationMatrix", () => {
  it("produces one sample per perturbation kind", () => {
    const matrix = buildPerturbationMatrix(ptCase, ptCase.findings);
    assert.equal(matrix.length, Object.keys(PERTURBATIONS).length);
    const kinds = matrix.map((m) => m.kind).sort();
    assert.deepEqual(kinds, Object.keys(PERTURBATIONS).sort());
  });
  it("is fully deterministic across calls", () => {
    const a = buildPerturbationMatrix(ptCase, ptCase.findings);
    const b = buildPerturbationMatrix(ptCase, ptCase.findings);
    assert.deepEqual(a.map((s) => s.text), b.map((s) => s.text));
  });
});

describe("summarizeRobustness", () => {
  it("reports 100% catch rate when every perturbation is caught", () => {
    const outcomes = Array.from({ length: 8 }, (_, i) => ({
      kind: Object.keys(PERTURBATIONS)[i % Object.keys(PERTURBATIONS).length] as keyof typeof PERTURBATIONS,
      caught: true,
    }));
    const r = summarizeRobustness(outcomes);
    assert.equal(r.overallCatchRate, 100);
    assert.equal(r.verdict, "robust");
  });

  it("flags broken bench when many perturbations slip through", () => {
    const outcomes = Array.from({ length: 10 }, () => ({ kind: "laterality_flip" as const, caught: false }));
    outcomes.push({ kind: "laterality_flip" as const, caught: true });
    const r = summarizeRobustness(outcomes);
    assert.ok(r.overallCatchRate < 70);
    assert.equal(r.verdict, "broken");
  });

  it("classifies leaky when some catches but not enough", () => {
    const outcomes: Array<{ kind: "laterality_flip"; caught: boolean }> = [];
    for (let i = 0; i < 10; i++) outcomes.push({ kind: "laterality_flip", caught: i < 8 });
    const r = summarizeRobustness(outcomes);
    assert.equal(r.verdict, "leaky");
  });
});
