#!/usr/bin/env node
/**
 * Portable test runner.
 *
 * `node --import tsx --test src/**​/*.test.ts` relies on shell globstar
 * expansion. Non-interactive CI bash has globstar OFF by default, so the `**`
 * is passed literally to node, matches no files, and the test step exits 0
 * having run ZERO tests — a silent green that hides every regression.
 *
 * This runner discovers test files via fs (no shell glob), FAILS LOUD if none
 * are found, prints the count, and forwards the child's exit code.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...findTests(join(dir, entry.name)));
    } else if (entry.name.endsWith(".test.ts")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const files = findTests("src").sort();
if (files.length === 0) {
  console.error("run-tests: no *.test.ts files found under src/ — refusing to report success on zero tests.");
  process.exit(1);
}
console.error(`run-tests: discovered ${files.length} test files`);

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
if (result.error) {
  console.error("run-tests: failed to launch node test runner:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
