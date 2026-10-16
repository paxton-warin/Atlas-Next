import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPageCommand,
  cleanPageTelemetry,
} from "../runtime/page-controls-protocol.ts";
test("document controls accept only boolean presentation/diagnostic commands, never a URL, source, namespace or script", () => {
  const valid = {
    type: "compatibility-config",
    metadata: true,
    diagnostics: false,
  };
  assert.deepEqual(cleanPageCommand(valid), valid);
  assert.deepEqual(cleanPageCommand({ type: "compatibility-export" }), {
    type: "compatibility-export",
  });
  for (const value of [
    null,
    [],
    { ...valid, metadata: "true" },
    { ...valid, sites: { "https://peer.test": true } },
    { ...valid, documentId: "peer" },
    { type: "execute", source: "alert(1)" },
    { type: "renderer", url: "https://front.test/api/admin" },
    { type: "compatibility-export", url: "https://peer.test" },
  ])
    assert.equal(cleanPageCommand(value), undefined);
});
test("metadata telemetry remains fixed to its logical origin and bounded counts/title; untrusted diagnostic bodies are rejected", () => {
  const origin = "https://site.test",
    status = {
      type: "compatibility-status",
      origin,
      rule: "runtime-only-v1",
      applied: 0,
      risk: false,
      throttled: false,
    };
  assert.deepEqual(cleanPageTelemetry(status, origin), status);
  for (const changed of [
    { ...status, origin: "https://peer.test" },
    { ...status, applied: 129 },
    { ...status, selector: "div" },
    { ...status, rule: "document-surface-v1" },
  ])
    assert.equal(cleanPageTelemetry(changed, origin), undefined);
  assert.deepEqual(
    cleanPageTelemetry({ type: "title", title: "Hello\nWorld" }, origin),
    { type: "title", title: "HelloWorld" },
  );
  assert.equal(
    cleanPageTelemetry({ type: "title", title: "a".repeat(161) }, origin),
    undefined,
  );
  assert.equal(
    cleanPageTelemetry(
      {
        type: "compatibility-diagnostics",
        report: { version: 1, active: true, entries: [{ text: "secret" }] },
      },
      origin,
    ),
    undefined,
  );
});
