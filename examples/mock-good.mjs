/**
 * Mock "good" radiology agent — produces well-structured HTML reports with:
 *   - title block, findings section, conclusion section
 *   - basic forbidden-opener avoidance
 *   - laterality preserved
 *   - measurements preserved verbatim
 *
 * Seeded by the `findings` text so output is deterministic per case.
 */
import { stdin, stdout } from "node:process";

function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000000;
}

let input = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { input += c; });
stdin.on("end", () => {
  const payload = JSON.parse(input);
  const exam = (payload.exam || "").toUpperCase();
  const findings = payload.findings || "Sem achados.";
  const seed = fnv1a(findings);
  const sentences = findings.split(/(?<=\.)\s+/).filter(Boolean);
  const findingsBlock = sentences.map((s, i) => `${i + 1}. ${s}`).join("<br>");
  const conclusion = sentences[sentences.length - 1] ?? findings.split(".")[0] ?? findings;
  const html = [
    `<center><b>${exam || "EXAME RADIOLÓGICO"}</b></center>`,
    "<br><br>",
    "<b>Técnica</b><br>",
    "Estudo realizado conforme protocolo padrão.",
    "<br><br>",
    "<b>Achados</b><br>",
    findingsBlock,
    "<br><br>",
    "<b>Conclusão</b><br>",
    conclusion,
    `<br><br><!-- seed:${seed} -->`,
  ].join("");
  stdout.write(JSON.stringify({ html }));
});
