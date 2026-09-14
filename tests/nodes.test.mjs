import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { createNodePool } from "../server/node-pool.mjs";
import { digest } from "../server/store.mjs";
const origin = "http://main.example";
async function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-nodes-"));
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    appOrigin: origin,
    runtimeOrigin: "http://runtime.example",
    ...options,
  });
  const nodes = [];
  async function node(name, code) {
    let credentials;
    const service = await createNodeService({
      pairing: {
        verify: (v) => v === code,
        save: (v) => {
          credentials = v;
        },
      },
    });
    await service.listen({ port: 0, host: "127.0.0.1" });
    nodes.push(service);
    const endpoint = "http://127.0.0.1:" + service.server.address().port;
    const attached = await app.nodePool.attach(
      { name, endpoint, code },
      origin,
    );
    return {
      service,
      endpoint,
      id: attached.id,
      get credentials() {
        return credentials;
      },
    };
  }
  return {
    app,
    dir,
    node,
    done: async () => {
      await Promise.all(nodes.map((n) => n.close()));
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("100 frontend aliases keep same-origin API and CSRF checks without hostname allowlists", async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 100; i++) {
      const host = `d${i}.cloudfront.net`,
        current = `http://${host}`;
      const r = await f.app.inject({
        method: "POST",
        url: "/api/browse/session",
        remoteAddress: "192.0.2." + i,
        headers: { host, origin: current },
        payload: {},
      });
      assert.equal(r.statusCode, 200);
      const v = r.json();
      assert.equal(
        f.app.nodePool.resolve(v.ticket, "http://runtime.example").appOrigin,
        current,
      );
    }
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/browse/session",
          headers: {
            host: "d1.cloudfront.net",
            origin: "http://d2.cloudfront.net",
          },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.app.inject("/api/admin/nodes")).statusCode, 401);
  } finally {
    await f.done();
  }
});
test("point-and-attach pairs once; direct nodes get weighted, sticky sessions; draining never moves them", async () => {
  const f = await fixture();
  try {
    const a = await f.node("VPS 2", "AABBCC"),
      b = await f.node("VPS 3", "DDEEFF");
    assert.equal(
      (
        await a.service.inject({
          method: "POST",
          url: "/node/pair",
          payload: {
            code: "AABBCC",
            id: b.id,
            token: b.credentials.secret,
            controlUrl: origin,
          },
        })
      ).statusCode,
      409,
    );
    assert.equal((await a.service.inject("/node/health")).statusCode, 401);
    assert.equal((await a.service.inject("/api/admin/nodes")).statusCode, 404);
    f.app.nodePool.update("local", { state: "disabled", weight: 1 });
    f.app.nodePool.update(a.id, { state: "active", weight: 1 });
    f.app.nodePool.update(b.id, { state: "active", weight: 3 });
    const leases = [];
    for (let i = 0; i < 8; i++)
      leases.push(
        await f.app.nodePool.allocate("", origin, "http://runtime.example"),
      );
    assert.equal(leases.filter((x) => x.node.id === a.id).length, 2);
    assert.equal(leases.filter((x) => x.node.id === b.id).length, 6);
    const lease = leases.find((x) => x.node.id === a.id);
    assert.equal(lease.runtimeOrigin, a.endpoint);
    const config = await fetch(a.endpoint + "/runtime-config", {
      headers: { authorization: "Bearer " + lease.ticket },
    });
    assert.equal(config.status, 200);
    assert.equal((await config.json()).appOrigin, origin);
    assert.equal(
      (
        await fetch(a.endpoint + "/runtime-config", {
          headers: { authorization: "Bearer " + lease.ticket + "bad" },
        })
      ).status,
      401,
    );
    f.app.nodePool.update(a.id, { state: "draining", weight: 1 });
    assert.equal(
      (
        await f.app.nodePool.allocate(
          lease.session,
          origin,
          "http://runtime.example",
        )
      ).node.id,
      a.id,
    );
    assert.equal(
      (await f.app.nodePool.allocate("", origin, "http://runtime.example")).node
        .id,
      b.id,
    );
    assert.throws(() => f.app.nodePool.remove(a.id), /Drain/);
    f.app.nodePool.update(a.id, { state: "disabled", weight: 1 });
    a.service.applyControl(f.app.nodePool.nodeState(a.id));
    assert.equal(
      (
        await fetch(a.endpoint + "/runtime-config", {
          headers: { authorization: "Bearer " + lease.ticket },
        })
      ).status,
      503,
    );
    // Retrying the same session does not silently select the healthy node.
    assert.equal(
      (
        await f.app.nodePool.allocate(
          lease.session,
          origin,
          "http://runtime.example",
        )
      ).node.id,
      a.id,
    );
    f.app.nodePool.release(lease.session, origin);
    await assert.rejects(
      f.app.nodePool.allocate(lease.session, origin, "http://runtime.example"),
      /expired/,
    );
    assert.equal(
      (await f.app.nodePool.allocate("", origin, "http://runtime.example")).node
        .id,
      b.id,
    );
    f.app.store.db.prepare("UPDATE nodes SET seen=0 WHERE id=?").run(b.id);
    await assert.rejects(
      f.app.nodePool.allocate("", origin, "http://runtime.example"),
      /No browsing nodes/,
    );
  } finally {
    await f.done();
  }
});
test("owner attach requires administrator session and CSRF, with no visitor credential disclosure", async () => {
  const f = await fixture();
  try {
    const raw = "owner-test-only",
      csrf = "csrf-test-only",
      now = Date.now();
    f.app.store.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
      .run(digest(raw), csrf, now, now);
    const r = await f.app.inject({
      method: "POST",
      url: "/api/admin/nodes",
      headers: { host: "main.example", origin, cookie: "atlas-admin=" + raw },
      payload: {},
    });
    assert.equal(r.statusCode, 403);
    const list = await f.app.inject({
      url: "/api/admin/nodes",
      headers: { cookie: "atlas-admin=" + raw },
    });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.body.includes("credential"));
  } finally {
    await f.done();
  }
});

test("equal-load reconnects rotate through main and both remote nodes without changing sticky sessions", async () => {
  const f = await fixture();
  try {
    const a = await f.node("VPS 2", "AABBCC"),
      b = await f.node("VPS 3", "DDEEFF");
    const counts = new Map([
      ["local", 0],
      [a.id, 0],
      [b.id, 0],
    ]);
    for (let i = 0; i < 9; i++) {
      // Recreate the pool between assignments to verify persisted tie-breaks.
      const pool = createNodePool(f.app.store, {
        runtimeOrigin: "http://runtime.example",
      });
      const lease = await pool.allocate("", origin, "http://runtime.example");
      counts.set(lease.node.id, counts.get(lease.node.id) + 1);
      const resumed = await pool.allocate(
        lease.session,
        origin,
        "http://runtime.example",
      );
      assert.equal(resumed.node.id, lease.node.id);
      pool.release(lease.session, origin);
    }
    assert.deepEqual([...counts.values()], [3, 3, 3]);
  } finally {
    await f.done();
  }
});

test("main participates at its configured weight and disabled main is never allocated", async () => {
  const f = await fixture();
  try {
    const a = await f.node("VPS 2", "AABBCC"),
      b = await f.node("VPS 3", "DDEEFF");
    f.app.nodePool.update("local", { state: "active", weight: 2 });
    const leases = [];
    for (let i = 0; i < 8; i++)
      leases.push(
        await f.app.nodePool.allocate("", origin, "http://runtime.example"),
      );
    assert.equal(leases.filter((x) => x.node.id === "local").length, 4);
    assert.equal(leases.filter((x) => x.node.id === a.id).length, 2);
    assert.equal(leases.filter((x) => x.node.id === b.id).length, 2);
    for (const lease of leases) f.app.nodePool.release(lease.session, origin);
    f.app.nodePool.update("local", { state: "disabled", weight: 2 });
    for (let i = 0; i < 6; i++) {
      const lease = await f.app.nodePool.allocate(
        "",
        origin,
        "http://runtime.example",
      );
      assert.notEqual(lease.node.id, "local");
      f.app.nodePool.release(lease.session, origin);
    }
  } finally {
    await f.done();
  }
});

test("main with the coordinator-only runtime placeholder explains setup instead of allocating dead sessions", async () => {
  const f = await fixture({ runtimeOrigin: "https://runtime.invalid" });
  try {
    const main = f.app.nodePool.list().find((n) => n.id === "local");
    assert.equal(main.setupRequired, true);
    assert.equal(main.online, false);
    assert.throws(
      () => f.app.nodePool.update("local", { state: "active", weight: 1 }),
      /RUNTIME_ORIGIN/,
    );
    await assert.rejects(
      f.app.nodePool.allocate("", origin, "https://runtime.invalid"),
      /No browsing nodes/,
    );
  } finally {
    await f.done();
  }
});

test("CloudFront viewer headers preserve alias and IP through the trusted origin proxy", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const handler = runInNewContext(
    readFileSync("scripts/cloudfront-viewer.js", "utf8") + ";handler;",
  );
  const event = {
    viewer: { ip: "198.51.100.8" },
    request: {
      headers: {
        host: { value: "d101.cloudfront.net" },
        "x-atlas-viewer-host": { value: "forged.invalid" },
      },
    },
  };
  const request = handler(event);
  assert.equal(request.headers.host.value, "d101.cloudfront.net");
  assert.equal(
    request.headers["x-atlas-viewer-host"].value,
    "d101.cloudfront.net",
  );
  assert.equal(request.headers["x-atlas-viewer-ip"].value, "198.51.100.8");
  assert.ok(!request.headers["x-forwarded-proto"]);
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "127.0.0.1";
  const f = await fixture();
  try {
    const r = await f.app.inject({
      method: "POST",
      url: "/api/browse/session",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "vps-main.internals.example",
        origin: "https://d101.cloudfront.net",
        "x-forwarded-host": "d101.cloudfront.net",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "198.51.100.8",
      },
      payload: {},
    });
    assert.equal(r.statusCode, 200);
    assert.equal(
      f.app.nodePool.resolve(r.json().ticket, "http://runtime.example")
        .appOrigin,
      "https://d101.cloudfront.net",
    );
    const spoof = await f.app.inject({
      method: "POST",
      url: "/api/browse/session",
      remoteAddress: "198.51.100.9",
      headers: {
        host: "vps-main.internals.example",
        origin: "https://d101.cloudfront.net",
        "x-forwarded-host": "d101.cloudfront.net",
        "x-forwarded-proto": "https",
      },
      payload: {},
    });
    assert.equal(spoof.statusCode, 403);
  } finally {
    await f.done();
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test("frontend relay mode pins Main's egress to each visitor URL with an isolated paired host", async () => {
  const f = await fixture({
    localRelayMode: "frontend",
    runtimeOrigin: "https://runtime.invalid",
  });
  try {
    assert.equal(
      f.app.nodePool.list().find((n) => n.id === "local").setupRequired,
      true,
    );
    const a = await f.node("Node 2", "HOSTCODE"),
      b = await f.node("Node 3", "HOSTCODE3");
    assert.equal(
      f.app.nodePool.list().find((n) => n.id === "local").setupRequired,
      false,
    );
    const counts = { local: 0, [a.id]: 0, [b.id]: 0 };
    for (let i = 0; i < 30; i++) {
      const visitor = `https://d${i}.cloudfront.net`;
      const lease = await f.app.nodePool.allocate(
        "",
        visitor,
        "https://runtime.invalid",
      );
      counts[lease.node.id]++;
      if (lease.node.id === "local") {
        assert.equal(lease.relayOrigin, visitor);
        assert.notEqual(lease.runtimeOrigin, visitor);
        const config = await fetch(lease.runtimeOrigin + "/runtime-config", {
          headers: { authorization: "Bearer " + lease.ticket },
        });
        assert.equal(config.status, 200);
        const runtime = await config.json();
        assert.equal(runtime.node.id, "local");
        assert.equal(runtime.relayOrigin, visitor);
        assert.equal(
          f.app.nodePool.resolve(
            runtime.relayTicket,
            lease.runtimeOrigin,
            "relay",
          ).node.id,
          "local",
        );
        assert.throws(() =>
          f.app.nodePool.resolve(lease.ticket, lease.runtimeOrigin, "relay"),
        );
        assert.throws(() =>
          f.app.nodePool.resolve(
            runtime.relayTicket,
            "https://wrong.example",
            "relay",
          ),
        );
        assert.throws(() =>
          f.app.nodePool.resolve(
            runtime.relayTicket,
            lease.runtimeOrigin,
            "runtime",
          ),
        );
        const again = await f.app.nodePool.allocate(
          lease.session,
          visitor,
          "https://runtime.invalid",
        );
        assert.equal(again.node.id, "local");
        assert.equal(again.runtimeOrigin, lease.runtimeOrigin);
        assert.throws(
          () => f.app.nodePool.remove(lease.runtimeHost.id),
          /Drain/,
        );
        f.app.nodePool.release(lease.session, visitor);
        assert.throws(() =>
          f.app.nodePool.resolve(
            runtime.relayTicket,
            lease.runtimeOrigin,
            "relay",
          ),
        );
      } else f.app.nodePool.release(lease.session, visitor);
    }
    assert.deepEqual(Object.values(counts), [10, 10, 10]);
  } finally {
    await f.done();
  }
});

test("a pinned Main runtime host drains without moving IP/storage and disables explicitly", async () => {
  const f = await fixture({
    localRelayMode: "frontend",
    runtimeOrigin: "https://runtime.invalid",
  });
  try {
    const a = await f.node("Node 2", "HOST"),
      b = await f.node("Node 3", "HOST3");
    let lease;
    for (let i = 0; i < 3; i++) {
      const l = await f.app.nodePool.allocate(
        "",
        origin,
        "https://runtime.invalid",
      );
      if (l.node.id === "local") {
        lease = l;
        break;
      }
      f.app.nodePool.release(l.session, origin);
    }
    assert.ok(lease);
    const host = lease.runtimeHost.id;
    f.app.nodePool.update(a.id, { state: "draining", weight: 1 });
    f.app.nodePool.update(b.id, { state: "draining", weight: 1 });
    const again = await f.app.nodePool.allocate(
      lease.session,
      origin,
      "https://runtime.invalid",
    );
    assert.equal(again.runtimeOrigin, lease.runtimeOrigin);
    assert.equal(again.node.online, true);
    f.app.nodePool.update(host, { state: "disabled", weight: 1 });
    await assert.rejects(
      f.app.nodePool.allocate(lease.session, origin, "https://runtime.invalid"),
      /unavailable/,
    );
    assert.equal(
      f.app.store.db
        .prepare("SELECT node FROM browse_leases WHERE runtime_node=?")
        .get(host).node,
      "local",
    );
  } finally {
    await f.done();
  }
});
