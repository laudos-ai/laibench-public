import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs } from "./normalize.js";

describe("parseRetryAfterMs", () => {
  const FALLBACK = 8000;

  it("parses delta-seconds", () => {
    assert.equal(parseRetryAfterMs("120", FALLBACK), 30_000); // clamped to maxMs
    assert.equal(parseRetryAfterMs("2", FALLBACK), 2000);
  });

  it("parses the HTTP-date form (was NaN before)", () => {
    const now = Date.parse("Wed, 21 Oct 2025 07:28:00 GMT");
    const header = "Wed, 21 Oct 2025 07:28:05 GMT"; // 5s in the future
    assert.equal(parseRetryAfterMs(header, FALLBACK, now), 5000);
  });

  it("falls back when the header is absent", () => {
    assert.equal(parseRetryAfterMs(null, FALLBACK), FALLBACK);
    assert.equal(parseRetryAfterMs(undefined, FALLBACK), FALLBACK);
    assert.equal(parseRetryAfterMs("", FALLBACK), FALLBACK);
  });

  it("falls back on unparseable input", () => {
    assert.equal(parseRetryAfterMs("soon", FALLBACK), FALLBACK);
  });

  it("falls back on a past HTTP-date (negative delay)", () => {
    const now = Date.parse("Wed, 21 Oct 2025 07:28:00 GMT");
    const header = "Wed, 21 Oct 2025 07:27:00 GMT"; // 60s in the past
    assert.equal(parseRetryAfterMs(header, FALLBACK, now), FALLBACK);
  });

  it("clamps to maxMs", () => {
    assert.equal(parseRetryAfterMs("99999", FALLBACK), 30_000);
  });
});
