/**
 * Mock "medium" radiology agent — keeps recognizable structure but loses
 * important evidence. This fixture must sit clearly below the good baseline.
 */
import { stdin, stdout } from "node:process";

function stripMeasurements(text) {
  return text.replace(/\b\d+(?:[.,]\d+)?\s*(?:mm|cm|ml|mL|%)\b/gi, "medida não informada");
}

function softenCriticals(text) {
  return text
    .replace(/\b(hematoma|hemorragia|sangramento|embol(?:ia|ism)|pneumot[oó]rax|fratura|aneurisma|abscesso|dissec[cç][aã]o)\b/gi, "alteração")
    .replace(/\b(hemorrhage|bleeding|embol(?:us|ism)|pneumothorax|fracture|aneurysm|abscess|dissection)\b/gi, "abnormality");
}

let input = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { input += c; });
stdin.on("end", () => {
  const payload = JSON.parse(input);
  const exam = (payload.exam || "").toUpperCase();
  let f = payload.findings || "Sem achados.";
  const sentences = f.split(/(?<=\.)\s+/).filter(Boolean);
  const kept = sentences.filter((_, i) => i % 2 === 1);
  f = kept.length ? kept.join(" ") : sentences.slice(1).join(" ") || f;
  f = softenCriticals(stripMeasurements(f));
  const html = [
    `<center><b>${exam || "EXAME"}</b></center>`,
    "<br>",
    "<b>Achados</b><br>",
    f,
    "<br><b>Conclusão</b><br>",
    "Achados parcialmente descritos; correlacionar com o estudo original.",
  ].join("");
  stdout.write(JSON.stringify({ html }));
});
