import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function run(t, entry) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-browser-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "evidence"));
  writeFileSync(
    join(dir, "evidence/browser-results.json"),
    JSON.stringify({ specs: [{ title: "Fixture", tests: [entry] }] }),
  );
  return spawnSync(
    process.execPath,
    [new URL("../scripts/summarize-browser.mjs", import.meta.url).pathname],
    { cwd: dir, encoding: "utf8" },
  );
}
test("browser summary distinguishes an explicitly gated skip from a failed qualification", (t) => {
  const r = run(t, {
    expectedStatus: "skipped",
    status: "skipped",
    results: [{ status: "skipped" }],
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /UNEXPECTED_FAILURE=0; EXPECTED_SKIP=1/);
});
test("browser summary continues rejecting unexpected skips", (t) => {
  const r = run(t, {
    expectedStatus: "passed",
    status: "skipped",
    results: [{ status: "skipped" }],
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNEXPECTED_FAILURE=1/);
});
