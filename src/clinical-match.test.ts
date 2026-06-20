import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isManagementOrDifferentialGold } from "./clinical-match.js";

// A confirmed critical/major finding that merely appends a recommendation must
// still be scored as a finding (so omitting it gates). Only uncertainty /
// differential phrasing, or a clause that is PURELY a recommendation, is exempt.

describe("isManagementOrDifferentialGold", () => {
  it("does NOT exempt a confirmed finding that appends a recommendation (the gate escape)", () => {
    assert.equal(isManagementOrDifferentialGold("massa pulmonar suspeita, recomenda-se biopsia"), false);
    assert.equal(isManagementOrDifferentialGold("Nódulo pulmonar de 8 mm, sugere-se controle tomográfico em 6 meses"), false);
    assert.equal(isManagementOrDifferentialGold("Linfonodomegalia cervical, recomenda-se punção"), false);
  });

  it("exempts uncertainty / differential phrasing (cannot gate 'cannot exclude X')", () => {
    assert.equal(isManagementOrDifferentialGold("Na junção com a veia cava superior, não sendo possível afastar pequeno trombo associado"), true);
    assert.equal(isManagementOrDifferentialGold("Deve-se considerar a hipótese de processo granulomatoso faringolaríngeo, não se podendo afastar lesão neoplasica"), true);
    assert.equal(isManagementOrDifferentialGold("nódulo a esclarecer"), true);
  });

  it("exempts a clause that is purely a recommendation", () => {
    assert.equal(isManagementOrDifferentialGold("recomenda-se correlação clínica"), true);
    assert.equal(isManagementOrDifferentialGold("sugere-se complementação com ressonância"), true);
    assert.equal(isManagementOrDifferentialGold("correlacionar com dados clínicos e laboratoriais"), true);
    assert.equal(isManagementOrDifferentialGold("controle evolutivo"), true);
  });

  it("does NOT exempt an ordinary confirmed finding with no management verb", () => {
    assert.equal(isManagementOrDifferentialGold("Hematoma subdural agudo"), false);
    assert.equal(isManagementOrDifferentialGold("Tromboembolismo pulmonar em ramos lobares"), false);
    assert.equal(isManagementOrDifferentialGold("Fratura cominutiva do planalto tibial"), false);
  });
});
