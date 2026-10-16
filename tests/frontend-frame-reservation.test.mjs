import test from "node:test";
import assert from "node:assert/strict";
import { createFrontendFrameReservations } from "../runtime/frontend-frame-reservation.ts";
const frontend = "https://front.example",
  resourceOrigin = "https://selected.example",
  documentId = "doc_" + "a".repeat(32);
const make = () => ({
  protocol: 2,
  session: "s".repeat(43),
  sessionHash: "a".repeat(64),
  generation: 1,
  node: { id: "selected" },
  frontendOrigin: frontend,
  relayOrigin: resourceOrigin,
});
function fixture(respond) {
  let assignment = make();
  const calls = [];
  const owner = {
    location: { origin: frontend },
    setTimeout,
    clearTimeout,
    async fetch(path, init) {
      calls.push({ path, init });
      return respond
        ? respond(path, init)
        : new Response(
            JSON.stringify({
              documentId,
              frameURL: frontend + "/browse/frame/" + documentId,
              resourceOrigin,
              expiresAt: Date.now() + 60000,
            }),
          );
    },
  };
  const provider = createFrontendFrameReservations({
    window: owner,
    assignment: () => assignment,
    timeoutMs: 1000,
  });
  return {
    provider,
    calls,
    change() {
      assignment = { ...assignment, generation: 2 };
    },
  };
}
test("trusted frontend reservation returns only fixed document/resource URLs and disposes only its document", async () => {
  const f = fixture(),
    grant = await f.provider.reserve({
      documentId,
      website: "https://site.example/",
      signal: new AbortController().signal,
    });
  assert.equal(grant.frameURL, frontend + "/browse/frame/" + documentId);
  assert.equal(grant.resourceOrigin, resourceOrigin);
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    session: "s".repeat(43),
    generation: 1,
    documentId,
  });
  grant.dispose();
  grant.dispose();
  f.provider.dispose();
  assert.equal(f.calls.filter((c) => c.init.method === "DELETE").length, 1);
  assert.equal(f.calls[1].path, "/api/browse/controller/document");
});
test("a response selecting another node or frontend is denied and cleaned up", async () => {
  for (const patch of [
    { resourceOrigin: "https://other.example" },
    { frameURL: "https://other.example/browse/frame/" + documentId },
    { expiresAt: 0 },
  ]) {
    const f = fixture(
      () =>
        new Response(
          JSON.stringify({
            documentId,
            frameURL: frontend + "/browse/frame/" + documentId,
            resourceOrigin,
            expiresAt: Date.now() + 60000,
            ...patch,
          }),
        ),
    );
    await assert.rejects(
      f.provider.reserve({
        documentId,
        website: "https://site.example/",
        signal: new AbortController().signal,
      }),
      /identity changed/,
    );
    assert.equal(f.calls.at(-1).init.method, "DELETE");
    f.provider.dispose();
  }
});
test("late assignment changes and disposal cannot adopt a stale physical frame policy", async () => {
  let resolve;
  const waiting = new Promise((r) => (resolve = r)),
    f = fixture(async (_path, init) => {
      if (init.method === "DELETE") return new Response("{}");
      await waiting;
      return new Response(
        JSON.stringify({
          documentId,
          frameURL: frontend + "/browse/frame/" + documentId,
          resourceOrigin,
          expiresAt: Date.now() + 60000,
        }),
      );
    });
  const pending = f.provider.reserve({
    documentId,
    website: "https://site.example/",
    signal: new AbortController().signal,
  });
  f.change();
  resolve();
  await assert.rejects(pending, /identity changed/);
  f.provider.dispose();
  await assert.rejects(
    f.provider.reserve({
      documentId,
      website: "https://site.example/",
      signal: new AbortController().signal,
    }),
    /Invalid frame reservation/,
  );
});
