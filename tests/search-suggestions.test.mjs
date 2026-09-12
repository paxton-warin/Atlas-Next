import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSearchSuggestions } from "../server/search-suggestions.mjs";
import { createApp } from "../server/app.mjs";

test("copied Atlas autocomplete provider encodes, deduplicates, trims and caps results", async () => {
  let call;
  const values = await fetchSearchSuggestions(
    " atlas & docs ",
    async (...args) => {
      call = args;
      return new Response(
        JSON.stringify([
          "atlas",
          [
            "atlas",
            " atlas docs ",
            "atlas",
            4,
            "atlas browser",
            "x".repeat(200),
            "five",
            "six",
          ],
        ]),
      );
    },
  );
  assert.deepEqual(values, [
    "atlas",
    "atlas docs",
    "atlas browser",
    "x".repeat(160),
    "five",
  ]);
  assert.equal(
    call[0],
    "https://suggestqueries.google.com/complete/search?client=firefox&q=atlas%20%26%20docs",
  );
  assert.equal(call[1].redirect, "error");
  assert.equal(call[1].headers["user-agent"], "Atlas/1.0");
  assert.ok(call[1].signal instanceof AbortSignal);
  assert.deepEqual(
    await fetchSearchSuggestions(
      "atlas",
      async () => new Response("", { status: 503 }),
    ),
    [],
  );
  assert.deepEqual(
    await fetchSearchSuggestions("atlas", async () => new Response("{}")),
    [],
  );
});

test("same-origin autocomplete route is bounded, private, rate-limited and fails gracefully", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-suggestions-"));
  let calls = 0;
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    suggestionProvider: async (q) => {
      calls++;
      if (q === "failure") throw Error("offline");
      return [q + " docs"];
    },
  });
  const request = (
    q,
    headers = { origin: "http://localhost:4180", host: "localhost:4180" },
  ) =>
    app.inject({
      method: "POST",
      url: "/api/search/suggestions",
      headers,
      payload: { q },
    });
  try {
    const res = await request("atlas");
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.json(), { suggestions: ["atlas docs"] });
    assert.equal(
      (
        await request("atlas", {
          origin: "https://elsewhere.example",
          host: "localhost:4180",
        })
      ).statusCode,
      403,
    );
    for (const q of [
      "a",
      "",
      null,
      {},
      "a".repeat(121),
      "https://example.com/login?token=secret",
      "example.com",
      "me@example.com",
      "foo\nbar",
    ])
      assert.deepEqual((await request(q)).json(), { suggestions: [] });
    assert.equal(calls, 1);
    assert.deepEqual((await request("failure")).json(), { suggestions: [] });
    for (let i = 0; i < 120; i++) await request("atlas");
    assert.equal((await request("atlas")).statusCode, 429);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease expiry metadata matches the signed ticket without client clock assumptions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-expiry-"));
  const app = await createApp({ dataDir: dir, staticDir: "/not-built" });
  try {
    const lease = await app.nodePool.allocate(
      "",
      "http://localhost:4180",
      "http://127.0.0.1:4181",
    );
    const ticket = JSON.parse(
      Buffer.from(lease.ticket.split(".")[0], "base64url"),
    );
    assert.equal(lease.expiresAt, ticket.expires);
    assert.equal(lease.expiresAt - lease.serverTime, 43200000);
    assert.ok(lease.serverTime <= Date.now());
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
