import { stdin, stdout } from "node:process";

let input = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  input += chunk;
});
stdin.on("end", () => {
  const payload = JSON.parse(input);
  const html = [
    "<center><b>MOCK RADIOLOGY REPORT</b></center>",
    "<br><br>",
    "<b>Findings</b>",
    "<br>",
    payload.findings || "No findings provided.",
    "<br><br>",
    "<b>Impression</b>",
    "<br>",
    payload.findings || "No findings provided."
  ].join("");
  stdout.write(JSON.stringify({ html }));
});
