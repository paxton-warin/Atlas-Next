import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  csvRows,
  compileLiteral,
  category,
} from "../scripts/fingerprint-audit.mjs";
import {
  ruleFor,
  sanitizeSiteModes,
  validStatus,
} from "../runtime/compatibility-policy.ts";
import { DiagnosticLog, requestCategory } from "../runtime/diagnostics.ts";
import { sanitizeSettings } from "../web/src/model.ts";
test("all 345 inventory entries compile as data; engine fixtures remain interpretable", () => {
  const rows = csvRows(
    readFileSync("scripts/audit-data/regex-inventory.csv", "utf8"),
  );
  assert.equal(rows.length, 345);
  assert.equal(new Set(rows.map((r) => r.id)).size, 345);
  for (const row of rows) compileLiteral(row.regex_literal);
  const row = rows.find((r) => r.id === "C250");
  assert.equal(category(row), "engine-signature");
  assert.ok(compileLiteral(row.regex_literal).test("scramjet.wasm"));
  assert.equal(
    compileLiteral(row.regex_literal).test("runtimekit.wasm"),
    false,
  );
});
test("metadata rules are exact-host; preferences are exact-origin and bounded", () => {
  assert.ok(ruleFor("https://poki.com/"));
  assert.equal(ruleFor("https://poki.com.evil.test/"), undefined);
  assert.equal(ruleFor("https://other.poki.com/"), undefined);
  assert.equal(ruleFor("https://user:pass@poki.com/"), undefined);
  assert.equal(
    ruleFor("http://127.0.0.1:4199/compatibility-fixture"),
    undefined,
  );
  assert.ok(ruleFor("http://127.0.0.1:4199/compatibility-fixture", true));
  const modes = sanitizeSiteModes({
    "https://poki.com": true,
    "https://poki.com/path": true,
    "https://poki.com/": true,
    "*": true,
    "https://www.poki.com": false,
  });
  assert.deepEqual(Object.keys(modes), ["https://poki.com"]);
});
test("status reports reject malformed rules and oversized counts", () => {
  const valid = {
    id: "a",
    origin: "https://poki.com",
    rule: "game-metadata-v1",
    applied: 2,
    risk: true,
    throttled: false,
  };
  assert.ok(validStatus(valid));
  assert.equal(validStatus({ ...valid, applied: 200 }), false);
  assert.equal(validStatus({ ...valid, rule: "unknown" }), false);
});
test("diagnostics default off, remain bounded, export no cookie/query/body values", () => {
  const log = new DiagnosticLog();
  log.record("response", { status: 200 });
  assert.equal(log.snapshot().entries.length, 0);
  log.enable(true);
  for (let i = 0; i < 150; i++)
    log.record("response", {
      origin: "https://example.com/path?token=secret#fragment",
      status: 200,
      cookies: 2,
      body: "secret",
      cookie: "session=secret",
    });
  assert.equal(log.snapshot().entries.length, 128);
  const text = JSON.stringify(log.snapshot());
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("/path"), false);
  assert.equal(
    requestCategory("https://example.test/api/auth/callback?code=secret"),
    "authentication",
  );
  log.enable(false);
  assert.equal(log.snapshot().entries.length, 0);
});
test("saved legacy engine preference normalizes without changing other preferences", () => {
  const migrated = sanitizeSettings({
    engine: "scramjet",
    youtubeAdblock: false,
    restore: false,
  });
  assert.equal(migrated.engine, "runtime");
  assert.equal(migrated.youtubeAdblock, false);
  assert.equal(migrated.restore, false);
});
