import http from "node:http";

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function extractUserText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((msg) => msg?.role === "user")
    .map((msg) => (typeof msg?.content === "string" ? msg.content : ""))
    .join("\n");
}

function buildHtml(userText) {
  const exam = userText.match(/Exam:\s*(.+)/i)?.[1]?.trim() ?? "exame não informado";
  const findings = userText.match(/Findings:\s*([\s\S]*?)\n\n/i)?.[1]?.trim() ?? "achados não informados";
  return [
    `<center><b>${exam.toUpperCase()}</b></center>`,
    "<br><br>",
    "<b>Análise</b>",
    "<br>",
    findings || "Sem achados informados.",
    "<br><br>",
    "<b>Conclusão</b>",
    "<br>",
    findings || "Sem achados informados.",
  ].join("");
}

function buildJudgeJson() {
  return JSON.stringify({
    verdict: "PARTIAL",
    scores: { CRIT: 4, QUAL: 3, TERM: 3, GUIDE: 3, RAG: 3 },
    overall: 3.2,
    critical_failures: [],
    missing: [],
    hallucinated: [],
    spot_checks: [{ claim: "findings reflected", ok: true, by: "mock endpoint" }],
    fix: "",
  });
}

const port = Number(process.env.MOCK_OPENAI_PORT ?? 8787);

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !(req.url || "").includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }

  try {
    const payload = await parseJson(req);
    const userText = extractUserText(payload.messages);
    const content = userText.includes("adversarial radiology QA judge") ? buildJudgeJson() : buildHtml(userText);
    const response = {
      id: "mock-chatcmpl",
      object: "chat.completion",
      model: payload.model ?? "mock-openai-compatible",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 128, completion_tokens: 64 },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock-openai-server listening on http://127.0.0.1:${port}/v1\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
