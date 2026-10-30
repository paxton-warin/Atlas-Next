import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { installLegacySyncRetirement, isRetiredLegacySyncMutation } from "../server/legacy-sync-retirement.mjs";

test("legacy replication is retired before JSON parsing, identity and upstream/database work", async (t) => {
  const app = Fastify(); t.after(() => app.close());
  installLegacySyncRetirement(app);
  let identity = 0, upstream = 0;
  app.addHook("onRequest", async () => { identity++; });
  app.all("/*", async () => { upstream++; return { ok: true }; });
  for (const [method, suffix] of [
    ["POST", "/commits"], ["POST", "/chunks"], ["POST", "/recoveries"],
    ["POST", "/imports"], ["POST", "/writers"], ["PUT", "/writers"], ["DELETE", "/writers"],
    ["POST", "/writers/takeover"],
    ["POST", "/writers/requests/11111111-1111-4111-8111-111111111111/ack"],
    ["POST", "/imports/11111111-1111-4111-8111-111111111111/commit"],
    ["DELETE", "/imports/11111111-1111-4111-8111-111111111111"],
    ["POST", "/backups/v2/legacy-conversions"],
  ]) {
    for (const payload of ["", "{broken JSON", '{"large":"' + "x".repeat(10000) + '"}']) {
      const response = await app.inject({ method, url: "/api/hub/profile" + suffix + "?old=1", headers: { "content-type": "application/json" }, payload });
      assert.equal(response.statusCode, 410, method + suffix);
      assert.equal(response.json().error.code, "PROFILE_LEGACY_SYNC_RETIRED");
      assert.equal(response.json().error.retryable, false);
    }
  }
  assert.equal(identity, 0); assert.equal(upstream, 0);
});

test("new backups, authentication, support and nonreplication settings are not retired", () => {
  for (const [method, url] of [
    ["POST", "/api/hub/profile/backups/v2/replicas"],
    ["PUT", "/api/hub/profile/backups/v2/staging/x/parts/y"],
    ["POST", "/api/hub/profile/backups/v2/staging/x/publish"],
    ["GET", "/api/hub/state"], ["POST", "/api/hub/signin"], ["POST", "/api/hub/logout"],
    ["GET", "/api/hub/support"], ["GET", "/api/hub/profile/preferences"],
    ["POST", "/api/hub/profile/preferences"], ["GET", "/api/hub/profile/receipts/x"],
  ]) assert.equal(isRetiredLegacySyncMutation({ method, url }), false, method + url);
});
