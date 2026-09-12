import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { digest } from "../server/store.mjs";
const origin = "http://main.example";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "atlas-nodes-"));
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    appOrigin: origin,
    runtimeOrigin: "http://runtime.example",
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
