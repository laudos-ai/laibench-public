/**
 * Mock "medium" radiology agent — has structure but drops some criticals.
 * Used as a middle-ground baseline for discrimination tests (good > medium > bad).
 */
import { stdin, stdout } from "node:process";

let input = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { input += c; });
stdin.on("end", () => {
  const payload = JSON.parse(input);
  const exam = (payload.exam || "").toUpperCase();
  let f = payload.findings || "Sem achados.";
  // Drop the FIRST sentence (often the most clinically important)
  const sentences = f.split(/(?<=\.)\s+/);
  if (sentences.length > 1) sentences.shift();
  f = sentences.join(" ");
  const html = [
    `<center><b>${exam || "EXAME"}</b></center>`,
    "<br>",
    "<b>Achados</b><br>",
    f,
    "<br><b>Conclusão</b><br>",
    sentences[sentences.length - 1] ?? f,
  ].join("");
  stdout.write(JSON.stringify({ html }));
});
