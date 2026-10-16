import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createApp } from "../server/app.mjs";

const origin = "https://frontend.example";
async function fixture(t, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-frontend-controller-"));
  const app = await createApp({
    dataDir: directory,
    staticDir: "/not-built",
    appOrigin: origin,
    dynamicOrigins: false,
    runtimeOrigin: "https://runtime.invalid",
    localRelayMode: "frontend",
    opaqueRuntimeEnabled: enabled,
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, body = {}, headers = {}, method = "POST") =>
    app.inject({
      method,
      url: path,
      headers: { origin, ...headers },
      payload: body,
    });
  return {
    app,
    request,
    async session() {
      const bootstrap = await request("/api/browse/controller/bootstrap");
      assert.equal(bootstrap.statusCode, 200);
      const cookie = bootstrap.headers["set-cookie"].split(";")[0];
      const res = await request(
        "/api/browse/controller/session",
        {
          intent: "new",
          requestId: bootstrap.json().requestId,
        },
        { cookie },
      );
      assert.equal(res.statusCode, 200);
      return { ...res.json(), cookie };
    },
  };
}
test("controller and owner routes stay absent until explicit combined-runtime qualification", async (t) => {
  const f = await fixture(t, false);
  for (const path of [
    "/api/browse/controller/session",
    "/api/browse/controller/bootstrap",
    "/api/browse/controller/initial-retire",
    "/api/browse/controller/commit",
    "/api/browse/controller/document",
    "/api/browse/controller/resource-owner",
    "/api/browse/storage/owners",
    "/api/browse/cookies/owners",
  ])
    assert.equal((await f.request(path)).statusCode, 404);
  assert.equal(
    (await f.app.inject("/api/config")).json().runtimeProtocols.opaque
      .activated,
    false,
  );
});
test("new/renew controller grants retain frontend origin/pin and a separate host-only browser-session cookie", async (t) => {
  const f = await fixture(t),
    first = await f.session();
  assert.equal(first.protocol, 2);
  assert.equal(first.node.id, "local");
  assert.equal(first.runtimeOrigin, origin);
  assert.equal(first.frontendOrigin, origin);
  assert.equal(first.relayOrigin, origin);
  assert.match(first.browserSessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!first.cookie.includes(first.session));
  const renewed = await f.request(
    "/api/browse/controller/session",
    { intent: "renew", session: first.session, generation: first.generation },
    { cookie: first.cookie },
  );
  assert.equal(renewed.statusCode, 200);
  assert.equal(renewed.json().session, first.session);
  assert.equal(renewed.json().browserSessionId, first.browserSessionId);
  assert.equal(renewed.headers["set-cookie"], undefined);
  const res = await f.request("/api/browse/controller/bootstrap", {});
  const set = res.headers["set-cookie"];
  assert.match(set, /^__Host-atlas-browser-session-v2=/);
  assert.match(set, /; HttpOnly; SameSite=Strict; Secure$/);
  assert.doesNotMatch(set, /Max-Age|Expires|Domain|atlas-admin/i);
  assert.notEqual(
    res.json().browserSessionId,
    first.browserSessionId,
    "a fresh browser session starts fresh session cookies, not persistent saves",
  );
});
test("controller endpoints reject opaque/foreign origins, malformed fields and administrator selection without admin verification", async (t) => {
  const f = await fixture(t),
    first = await f.session();
  for (const bad of ["null", "https://peer.example", ""])
    assert.equal(
      (await f.request("/api/browse/controller/session", {}, { origin: bad }))
        .statusCode,
      403,
    );
  for (const body of [
    [],
    { intent: "new", website: "https://peer.example" },
    { intent: "renew" },
    { intent: "restore", session: first.session, generation: 0 },
  ])
    assert.equal(
      (await f.request("/api/browse/controller/session", body)).statusCode,
      400,
    );
  assert.equal(
    (
      await f.request("/api/admin/nodes/controller-select", {
        session: first.session,
        node: "local",
      })
    ).statusCode,
    401,
  );
});
test("owner registration validates exact frontend lease/generation and revoked leases reject new or retained owners", async (t) => {
  const f = await fixture(t),
    first = await f.session(),
    headers = {
      "x-atlas-browse-session": first.session,
      "x-atlas-browse-generation": String(first.generation),
    };
  for (const family of ["storage", "cookies"]) {
    const path = `/api/browse/${family}/owners`;
    for (const bad of [
      {},
      { ...headers, "x-atlas-browse-generation": "01" },
      { ...headers, "x-atlas-browse-generation": "2" },
      { ...headers, "x-atlas-browse-session": "x" },
    ])
      assert.equal((await f.request(path, {}, bad)).statusCode, 401);
    assert.equal(
      (await f.request(path, {}, { ...headers, origin: "null" })).statusCode,
      403,
    );
    const registered = await f.request(path, {}, headers);
    assert.equal(registered.statusCode, 200);
    const grant = registered.json();
    assert.match(grant.capability, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(grant.capability, first.session);
    const doc = await f.request(
      `/api/browse/${family}/documents`,
      { documentId: "controller_document_00001" },
      { authorization: "Bearer " + grant.capability },
    );
    assert.equal(doc.statusCode, 200);
  }
  const registered = (
    await f.request("/api/browse/storage/owners", {}, headers)
  ).json();
  f.app.nodePool.release(first.session, origin);
  assert.equal(
    (await f.request("/api/browse/storage/owners", {}, headers)).statusCode,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/browse/storage/documents",
        { documentId: "controller_document_00002" },
        { authorization: "Bearer " + registered.capability },
      )
    ).statusCode,
    401,
  );
  const failed = await f.request("/api/browse/controller/session", {
    intent: "restore",
    session: first.session,
  });
  assert.equal(failed.json().code, "SESSION_REVOKED");
  assert.equal(failed.json().retryable, false);
});
test(
  "real storage and cookie owner sockets coexist on frontend app and revocation denies reconnect",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      first = await f.session();
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const base = "ws://127.0.0.1:" + f.app.server.address().port;
    const sockets = new Set(),
      trace = [];
    const bounded = (promise, stage) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              Error(
                "owner websocket stage timeout: " +
                  stage +
                  "; " +
                  JSON.stringify(trace),
              ),
            ),
          5000,
        );
        promise.then(
          (value) => {
            clearTimeout(timer);
            trace.push(stage);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    const tracked = (url, headers) => {
      const ws = new WebSocket(url, { headers });
      sockets.add(ws);
      ws.on("error", (error) => trace.push("error:" + error.code));
      ws.on("close", (code) => {
        trace.push("close:" + code);
        sockets.delete(ws);
      });
      ws.on("message", (data) => {
        try {
          trace.push("message:" + JSON.parse(data).type);
        } catch {
          trace.push("invalid-json");
        }
      });
      return ws;
    };
    const jsonMessage = (ws, type) =>
      new Promise((resolve, reject) => {
        const received = (data) => {
          const value = JSON.parse(data);
          if (value.type === type) {
            remove();
            resolve(value);
          }
        };
        const closed = () => {
          remove();
          reject(Error("closed before " + type));
        };
        const remove = () => {
          ws.off("message", received);
          ws.off("close", closed);
        };
        ws.on("message", received);
        ws.once("close", closed);
      });
    try {
      for (const family of ["storage", "cookies"]) {
        trace.push("family:" + family);
        const response = await f.request(
          `/api/browse/${family}/owners`,
          {},
          {
            "x-atlas-browse-session": first.session,
            "x-atlas-browse-generation": "1",
          },
        );
        assert.equal(response.statusCode, 200);
        const registered = response.json(),
          ws = tracked(base + registered.websocket, { origin });
        // Capture the actual owner-ready message before awaiting open. Sending
        // ping immediately after open otherwise lets the first-message assertion
        // consume ready instead of pong; failed assertions must still tear down.
        const ready = jsonMessage(ws, "ready");
        await bounded(once(ws, "open"), family + ":open");
        await bounded(ready, family + ":ready");
        const pong = jsonMessage(ws, "pong");
        ws.send(JSON.stringify({ type: "ping" }));
        assert.deepEqual(await bounded(pong, family + ":pong"), {
          type: "pong",
        });
        const closed = once(ws, "close");
        ws.terminate();
        await bounded(closed, family + ":closed");
        const denied = tracked(base + registered.websocket, { origin: "null" }),
          deniedClosed = new Promise((resolve) =>
            denied.once("close", resolve),
          );
        const code = await bounded(
          new Promise((resolve, reject) => {
            denied.once("unexpected-response", (_req, res) => {
              res.resume();
              denied.terminate();
              resolve(res.statusCode);
            });
            denied.once("open", () =>
              reject(Error("opaque owner unexpectedly authorized")),
            );
          }),
          family + ":denied",
        );
        assert.equal(code, 403);
        await bounded(deniedClosed, family + ":denied-close");
      }
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  },
);

test("Main native resources use a separate same-selected-origin purpose ticket, never a relay ticket", async (t) => {
  const f = await fixture(t),
    lease = await f.session();
  const response = await f.request("/api/browse/controller/resource-owner", {
    session: lease.session,
    generation: lease.generation,
  });
  assert.equal(response.statusCode, 200);
  const grant = response.json();
  assert.equal(grant.nodeId, "local");
  assert.equal(grant.resourceOrigin, origin);
  assert.equal(grant.frontendOrigin, origin);
  assert.equal(grant.leaseHash, lease.sessionHash);
  assert.notEqual(grant.ownerTicket, lease.ticket);
  assert.throws(
    () =>
      f.app.nodePool.resolve(grant.ownerTicket, origin, "relay", {
        relayOrigin: origin,
      }),
    { code: "INVALID_TICKET" },
  );
  const registered = await f.request(
    "/native-resource/v1/owners",
    {},
    { authorization: "Bearer " + grant.ownerTicket },
  );
  assert.equal(registered.statusCode, 200);
  assert.equal(
    (
      await f.request(
        "/native-resource/v1/owners",
        {},
        { authorization: "Bearer " + lease.ticket },
      )
    ).statusCode,
    401,
  );
  f.app.nodePool.release(lease.session, origin);
  assert.equal(
    (
      await f.request(
        "/native-resource/v1/owners",
        {},
        { authorization: "Bearer " + grant.ownerTicket },
      )
    ).statusCode,
    401,
  );
});

test("bootstrap allocates nothing and signed initial requests require exact cookie binding and same-frontend CSRF", async (t) => {
  const f = await fixture(t),
    count = () =>
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n;
  const prepared = await f.request("/api/browse/controller/bootstrap");
  const data = prepared.json(),
    cookie = prepared.headers["set-cookie"].split(";")[0];
  assert.equal(prepared.statusCode, 200);
  assert.equal(count(), 0);
  assert.match(
    data.requestId,
    /^v1\.[0-9]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(data.requestExpiresAt - data.serverTime, 30 * 60_000);
  const repeated = await f.request(
    "/api/browse/controller/bootstrap",
    {},
    { cookie },
  );
  assert.equal(repeated.json().browserSessionId, data.browserSessionId);
  assert.equal(count(), 0);
  assert.equal(
    (
      await f.request("/api/browse/controller/session", { intent: "new" })
    ).json().code,
    "INITIAL_REQUEST_REQUIRED",
  );
  for (const badOrigin of ["null", "https://peer.example", ""])
    assert.equal(
      (
        await f.request(
          "/api/browse/controller/bootstrap",
          {},
          { origin: badOrigin },
        )
      ).statusCode,
      403,
    );
  const body = { intent: "new", requestId: data.requestId };
  const foreign = await f.request("/api/browse/controller/session", body);
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().code, "INITIAL_REQUEST_BINDING_MISMATCH");
  assert.equal(count(), 0);
  const [a, b] = await Promise.all([
    f.request("/api/browse/controller/session", body, { cookie }),
    f.request("/api/browse/controller/session", body, { cookie }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(a.json().session, b.json().session);
  assert.equal(count(), 1);
  const again = await f.request("/api/browse/controller/session", body, {
    cookie,
  });
  assert.equal(again.json().session, a.json().session);
  assert.equal(again.json().node.id, a.json().node.id);
  assert.equal(count(), 1);
  assert.equal(
    (
      await f.request("/api/browse/controller/session", body, {
        cookie,
        origin: "null",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/browse/controller/session",
        { intent: "new", session: a.json().session, requestId: data.requestId },
        { cookie },
      )
    ).statusCode,
    400,
  );
});

test("revoked and expired initial assignments remain terminal; signed request expiry never recycles allocation", async (t) => {
  const f = await fixture(t),
    boot = await f.request("/api/browse/controller/bootstrap"),
    data = boot.json(),
    cookie = boot.headers["set-cookie"].split(";")[0],
    body = { intent: "new", requestId: data.requestId };
  const first = (
    await f.request("/api/browse/controller/session", body, { cookie })
  ).json();
  f.app.nodePool.release(first.session, origin);
  const revoked = await f.request("/api/browse/controller/session", body, {
    cookie,
  });
  assert.equal(revoked.json().code, "SESSION_REVOKED");
  assert.equal(revoked.json().retryable, false);
  const count = () =>
    f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n;
  assert.equal(count(), 0);
  const nativeNow = Date.now;
  try {
    Date.now = () => data.requestExpiresAt + 1;
    const expired = await f.request("/api/browse/controller/session", body, {
      cookie,
    });
    assert.equal(expired.json().code, "INITIAL_REQUEST_EXPIRED");
    assert.equal(expired.json().retryable, false);
    assert.equal(count(), 0);
  } finally {
    Date.now = nativeNow;
  }
});

test("expired signed initial retirement is exact, cookie-bound, idempotent and allocation-free", async (t) => {
  const f = await fixture(t),
    other = await f.session(),
    boot = await f.request("/api/browse/controller/bootstrap"),
    prepared = boot.json(),
    cookie = boot.headers["set-cookie"].split(";")[0],
    body = { requestId: prepared.requestId };
  const initial = (
    await f.request(
      "/api/browse/controller/session",
      { intent: "new", ...body },
      { cookie },
    )
  ).json();
  assert.equal(
    (
      await f.request("/api/browse/controller/initial-retire", body, { cookie })
    ).json().code,
    "INITIAL_REQUEST_ACTIVE",
  );
  const now = Date.now;
  try {
    Date.now = () => prepared.requestExpiresAt + 1;
    assert.equal(
      (await f.request("/api/browse/controller/initial-retire", body)).json()
        .code,
      "INITIAL_REQUEST_BINDING_MISMATCH",
    );
    assert.equal(
      (
        await f.request("/api/browse/controller/initial-retire", body, {
          cookie,
          origin: "null",
        })
      ).statusCode,
      403,
    );
    for (let i = 0; i < 2; i++) {
      const retired = await f.request(
        "/api/browse/controller/initial-retire",
        body,
        { cookie },
      );
      assert.equal(retired.statusCode, 200);
      assert.equal(retired.json().retiredRequestId, body.requestId);
    }
    const db = f.app.store.db;
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      1,
    );
    assert.ok(
      db
        .prepare("SELECT hash FROM browse_leases WHERE hash=?")
        .get(other.sessionHash),
    );
    assert.equal(
      db
        .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
        .get(initial.sessionHash).reason,
      "revoked",
    );
    assert.equal(
      db
        .prepare(
          "SELECT reservation_nonce FROM frontend_assignments WHERE hash=?",
        )
        .get(initial.sessionHash).reservation_nonce,
      "initial-retired-v1",
    );
  } finally {
    Date.now = now;
  }
});

test("expired initial retirement does not erase an independent revocation", async (t) => {
  const f = await fixture(t),
    boot = await f.request("/api/browse/controller/bootstrap"),
    prepared = boot.json(),
    cookie = boot.headers["set-cookie"].split(";")[0],
    body = { requestId: prepared.requestId };
  const initial = (
    await f.request(
      "/api/browse/controller/session",
      { intent: "new", ...body },
      { cookie },
    )
  ).json();
  f.app.nodePool.release(initial.session, origin);
  const now = Date.now;
  try {
    Date.now = () => prepared.requestExpiresAt + 1;
    const retired = await f.request(
      "/api/browse/controller/initial-retire",
      body,
      { cookie },
    );
    assert.equal(retired.json().code, "SESSION_REVOKED");
    assert.equal(retired.json().retryable, false);
    assert.equal(
      f.app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
      0,
    );
  } finally {
    Date.now = now;
  }
});
