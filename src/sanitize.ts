import { escapeHtml } from "./normalize.js";

export function normalizeGeneratedHtml(input: string): string {
  // Defense-in-depth: model output crosses an I/O boundary and may not be a string
  // at runtime despite the type. Coerce so a malformed value never throws here.
  if (typeof input !== "string") input = input == null ? "" : String(input);
  return input
    .replace(/```html/gi, "")
    .replace(/```/g, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n/g, "<br>")
    .replace(/(?:<br>\s*){3,}/gi, "<br><br>")
    .replace(/\s+<br>/g, "<br>")
    .replace(/<br>\s+/g, "<br>")
    .trim();
}

export function sanitizeAllowedHtml(input: string): string {
  const stripped = input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/\u0000/g, "");

  const escaped = escapeHtml(stripped);

  return escaped
    .replace(/&lt;(\/?center)\s*&gt;/gi, "<$1>")
    .replace(/&lt;(\/?b)\s*&gt;/gi, "<$1>")
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/(?:<br>\s*){3,}/gi, "<br><br>");
}
