/**
 * Mock "bad" radiology agent — deliberately unsafe calibration fixture:
 * missing structure, negated evidence, flipped laterality, lost measurements,
 * and invented normal/suspicious statements.
 */
import { stdin, stdout } from "node:process";

let input = "";
stdin.setEncoding("utf8");
stdin.on("data", (c) => { input += c; });
stdin.on("end", () => {
  const payload = JSON.parse(input);
  const exam = `${payload.exam || ""} ${payload.findings || ""}`.toLowerCase();
  const isEnglish = /\b(the|with|without|right|left|findings|mass|fracture|hemorrhage)\b/.test(exam);
  const html = [
    isEnglish ? "Preliminary report without diagnostic structure." : "Relatorio preliminar sem padrao.",
    isEnglish ? "No acute abnormality is identified." : "Nao ha alteracoes agudas.",
    isEnglish ? "No suspicious lesion, hemorrhage, fracture, obstruction, or embolism." : "Sem lesao suspeita, hemorragia, fratura, obstrucao ou embolia.",
    isEnglish ? "Recommend routine follow-up despite absent supporting evidence." : "Recomenda-se controle de rotina sem evidencia fornecida.",
  ].join(" ");
  stdout.write(JSON.stringify({ html }));
});
