import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  browserDocumentAnnouncement,
  createDocumentAnnouncementClient,
  isBrowserEntry,
} from "../web/src/entry-launch-link.ts";
const valid = {
  url: "https://example.org/document",
  browserEnabled: true,
  hubEnabled: false,
  acknowledged: false,
  announcementId: "document-v1",
};
function fixture(config = valid, options = {}) {
  const requests = [];
  const client = createDocumentAnnouncementClient(async (...args) => {
    requests.push(args);
    if (options.failure) throw new Error("Offline");
    const body =
      args[1]?.method === "POST"
        ? (options.ack ?? {
            acknowledged: true,
            announcementId: valid.announcementId,
          })
        : config;
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
    });
  });
  return { client, requests };
}
test("ordinary top-level root is the only announcement route", () => {
  assert.equal(isBrowserEntry("/", true), true);
  for (const path of [
    "/popout",
    "/support",
    "/_control/admin",
    "/setup",
    "/frames/view",
    "/auth/hub/callback",
  ])
    assert.equal(isBrowserEntry(path, true), false);
  assert.equal(isBrowserEntry("/", false), false);
});
test("disabled, Hub-only, acknowledged and incomplete configurations stay silent", () => {
  for (const config of [
    {},
    null,
    { ...valid, browserEnabled: false },
    { ...valid, browserEnabled: false, hubEnabled: true },
    { ...valid, acknowledged: true },
    { ...valid, acknowledged: undefined },
    { ...valid, announcementId: "" },
  ])
    assert.equal(browserDocumentAnnouncement(config), null);
});
test("valid destination normalizes; invalid schemes, credentials and oversized URLs are rejected", () => {
  assert.deepEqual(
    browserDocumentAnnouncement({
      ...valid,
      url: " https://EXAMPLE.org/document ",
    }),
    {
      url: valid.url,
      host: "example.org",
      announcementId: valid.announcementId,
    },
  );
  for (const url of [
    "",
    "example.org",
    "/local",
    "javascript:alert(1)",
    "data:text/html,example",
    "file:///tmp/example",
    "https://u:p@example.org/",
    "https://",
    "https://example.org/" + "x".repeat(2049),
  ])
    assert.equal(browserDocumentAnnouncement({ ...valid, url }), null);
});
test("an unresolved or signed-out identity makes no request", async () => {
  const f = fixture();
  assert.equal(await f.client.load(""), null);
  assert.deepEqual(f.requests, []);
});
test("StrictMode duplicate effects share one request per authenticated identity", async () => {
  const f = fixture();
  const a = f.client.load("user-a:profile-a"),
    b = f.client.load("user-a:profile-a");
  assert.equal(a, b);
  await Promise.all([a, b]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][0], "/api/hub/document-announcement");
  assert.equal(f.requests[0][1].cache, "no-store");
  assert.equal(f.requests[0][1].credentials, "same-origin");
  await f.client.load("user-b:profile-b");
  assert.equal(f.requests.length, 2);
});
test("Not now dismisses only this identity/document and never writes server preferences", async () => {
  const f = fixture();
  await f.client.load("user-a");
  f.client.dismiss("user-a");
  assert.equal(await f.client.load("user-a"), null);
  assert.equal(f.requests.length, 1);
  assert.ok(await f.client.load("user-b"));
  assert.equal(f.requests.length, 2);
});
test("explicit acknowledgement sends only announcement ID with same-origin CSRF", async () => {
  const f = fixture();
  const announcement = await f.client.load("user-a");
  await f.client.acknowledge(announcement, "fixture-csrf");
  const [path, options] = f.requests[1];
  assert.equal(path, "/api/hub/document-announcement/ack");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.headers["x-atlas-hub-csrf"], "fixture-csrf");
  assert.deepEqual(JSON.parse(options.body), {
    announcementId: valid.announcementId,
  });
});
test("only an acknowledged response for this exact announcement counts as success", async () => {
  for (const options of [
    { status: 503 },
    { ack: { acknowledged: false, announcementId: valid.announcementId } },
    { ack: { acknowledged: true, announcementId: "different" } },
  ]) {
    const f = fixture(valid, options);
    await assert.rejects(
      f.client.acknowledge(
        {
          url: valid.url,
          host: "example.org",
          announcementId: valid.announcementId,
        },
        "csrf",
      ),
    );
  }
});
test("GET errors fail closed without retry loops", async () => {
  for (const options of [{ status: 503 }, { failure: true }]) {
    const f = fixture(valid, options);
    assert.equal(await f.client.load("user"), null);
    assert.equal(await f.client.load("user"), null);
    assert.equal(f.requests.length, 1);
  }
});
test("entry is behind the ready HubGate and contains no automatic popup path", () => {
  const main = readFileSync(
    new URL("../web/src/main.tsx", import.meta.url),
    "utf8",
  );
  assert.match(main, /<HubGate>\s*<EntryLaunchLinkNotice \/>/);
  for (const path of [
    "../web/src/EntryLaunchLink.tsx",
    "../web/src/entry-launch-link.ts",
  ])
    assert.doesNotMatch(
      readFileSync(new URL(path, import.meta.url), "utf8"),
      /window\.open|localStorage|sessionStorage/,
    );
});
