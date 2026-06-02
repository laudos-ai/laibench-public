import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAllowedHtml, normalizeGeneratedHtml } from "./sanitize.js";

describe("sanitizeAllowedHtml", () => {
  it("removes <script> blocks entirely", () => {
    const out = sanitizeAllowedHtml('<b>ok</b><script>alert("xss")</script>');
    assert.ok(!/<script/i.test(out), "no raw <script");
    assert.ok(!out.includes("alert("), "script body removed");
    assert.ok(out.includes("<b>ok</b>"));
  });

  it("removes <style>, doctype, and xml prologs", () => {
    const out = sanitizeAllowedHtml('<!doctype html><style>b{}</style><?xml v?><b>x</b>');
    assert.ok(!/<style|<!doctype|<\?xml/i.test(out));
    assert.ok(out.includes("<b>x</b>"));
  });

  it("passes through the allowed subset as real tags", () => {
    assert.ok(sanitizeAllowedHtml("<center><b>T</b></center>").includes("<center><b>T</b></center>"));
    assert.equal(sanitizeAllowedHtml("a<br>b"), "a<br>b");
    assert.equal(sanitizeAllowedHtml("a<br/>b"), "a<br>b");
  });

  it("neutralizes disallowed tags by escaping them", () => {
    const out = sanitizeAllowedHtml('<img src=x onerror="alert(1)">');
    assert.ok(!/<img/i.test(out), "no active <img tag");
    assert.ok(!out.includes('onerror="'), "no live event handler");
    assert.ok(out.includes("&lt;img"), "escaped instead");
  });

  it("does not revive an allowed tag that carries attributes (event handlers)", () => {
    const out = sanitizeAllowedHtml('<b onclick="steal()">x</b>');
    assert.ok(!/<b\s+onclick/i.test(out), "attributed <b> stays escaped");
    assert.ok(!out.includes('onclick="'));
  });

  it("neutralizes javascript: anchors", () => {
    const out = sanitizeAllowedHtml('<a href="javascript:alert(1)">x</a>');
    assert.ok(!/<a\s/i.test(out), "no active anchor");
  });

  it("strips null bytes", () => {
    const NUL = String.fromCharCode(0);
    const out = sanitizeAllowedHtml("a" + NUL + "b");
    assert.equal(out, "ab");
  });
});

describe("normalizeGeneratedHtml", () => {
  it("strips markdown code fences", () => {
    assert.equal(normalizeGeneratedHtml("```html<b>x</b>```"), "<b>x</b>");
  });

  it("converts newlines to <br> and collapses runs", () => {
    assert.equal(normalizeGeneratedHtml("a\n\n\n\nb"), "a<br><br>b");
  });

  it("trims wrapping quotes", () => {
    assert.equal(normalizeGeneratedHtml('"<b>x</b>"'), "<b>x</b>");
  });
});
