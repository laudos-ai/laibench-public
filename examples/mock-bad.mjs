/**
 * Mock "bad" radiology agent — produces low-quality reports:
 *   - missing structure (no center, no sections)
 *   - hallucinated content
 *   - drops measurements
 *   - flips laterality
 *
 * Used as a deliberately weak baseline to test discrimination.
 */
import { stdin, stdout } from "node:process";

let input = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { input += c; });
stdin.on("end", () => {
  const payload = JSON.parse(input);
  let f = payload.findings || "Sem achados.";
  // Flip laterality
  f = f.replace(/\bdireit(o|a)\b/gi, (m) => (m.endsWith("a") ? "esquerda" : "esquerdo"));
  f = f.replace(/\besquerd(o|a)\b/gi, (m) => (m.endsWith("a") ? "direita" : "direito"));
  // Drop numeric measurements
  f = f.replace(/\d+(?:[.,]\d+)?\s*(mm|cm|ml|mL)/gi, "");
  // Hallucinate
  const hallucination = " Identificada lesão suspeita não confirmada por outros estudos.";
  const html = `Relatório: ${f}${hallucination}`;
  stdout.write(JSON.stringify({ html }));
});
