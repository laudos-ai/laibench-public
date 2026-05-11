import { createHash } from "node:crypto";

const ALLOWED_EVENTS = new Set([
  "page_view",
  "artifact_click",
  "artifact_download_intent",
]);

const PUBLIC_ARTIFACT_ID = "LAIBENCH-PUBLIC-2026-05-02-BF78-A309";

function hash(value, salt) {
  if (!value) return null;
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 24);
}

function cleanString(value, max = 160) {
  if (typeof value !== "string") return null;
  return value.replace(/[^\w .:/?#=&%+@-]/g, "").slice(0, max) || null;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
}

function getReferrerHost(req) {
  const referrer = req.headers.referer;
  if (typeof referrer !== "string") return null;
  try {
    return new URL(referrer).hostname.slice(0, 120);
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").slice(0, 4096);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function sendWebhook(event) {
  const url = process.env.TELEMETRY_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "https://laibench.laudos.ai");
  res.setHeader("access-control-allow-methods", "POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.json({ error: "method_not_allowed" });
    return;
  }

  const body = await readBody(req);
  const eventName = cleanString(body.event, 48);
  if (!ALLOWED_EVENTS.has(eventName)) {
    res.statusCode = 400;
    res.json({ error: "invalid_event" });
    return;
  }

  const salt = process.env.TELEMETRY_SALT || "laibench-public-telemetry-v1";
  const userAgent = req.headers["user-agent"];
  const event = {
    ts: new Date().toISOString(),
    event: eventName,
    artifactId: PUBLIC_ARTIFACT_ID,
    path: cleanString(body.path, 180),
    target: cleanString(body.target, 180),
    label: cleanString(body.label, 80),
    referrerHost: getReferrerHost(req),
    ipHash: hash(getClientIp(req), salt),
    uaHash: hash(typeof userAgent === "string" ? userAgent : null, salt),
    country: cleanString(req.headers["x-vercel-ip-country"], 8),
  };

  console.log("laibench_telemetry", JSON.stringify(event));

  try {
    await sendWebhook(event);
  } catch (error) {
    console.warn("laibench_telemetry_webhook_failed", error instanceof Error ? error.message : String(error));
  }

  res.statusCode = 204;
  res.end();
}
