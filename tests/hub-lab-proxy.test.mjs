import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { createLabProxyHandlers } from "../scripts/hub-lab-proxy-handlers.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("Native proxy fixture timed out")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
async function fixture(t, options = {}) {
  const sockets = new Set();
  const observed = { connections: 0, requests: [], upgrades: [] };
  const backend = createServer(
    options.backend ||
      ((req, res) => {
        observed.requests.push({
          path: req.url,
          peer: req.headers["x-forwarded-for"],
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ ok: true, peer: req.headers["x-forwarded-for"] }),
        );
      }),
  );
  backend.on("connection", () => observed.connections++);
  backend.on("upgrade", (req, socket) => {
    observed.upgrades.push({ peer: req.headers["x-forwarded-for"] });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(data));
    // Native HTTP upgrade sockets are half-open; the fixture peer acknowledges
    // proxy EOF just like a WebSocket server instead of waiting indefinitely.
    socket.once("end", () => socket.end());
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const back = backend.address().port;
  const cloud = {
    handle: async () => false,
    routes: async () => null,
    currentHub: async () => "https://hub.atlas.localhost:4300",
    ...options.cloud,
  };
  const handlers = createLabProxyHandlers({
    front: 4280,
    back,
    ports: { atlas: 4280, runtimeInternal: back },
    cloud,
    ...options.dispatch,
  });
  const proxy = createServer(handlers.http);
  proxy.on("upgrade", handlers.upgrade);
  for (const server of [backend, proxy])
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [proxy, backend].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  });
  const port = proxy.address().port;
  const get = (path = "/health") =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          headers: { "x-forwarded-for": "203.0.113.9" },
        },
        (res) => {
          let body = "";
          res.on("data", (data) => {
            body += data;
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  return { proxy, backend, observed, port, get };
}
async function rawUpgrade(port) {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(
    "GET /relay/fixture/ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  );
  return socket;
}

// These are actual native HTTP/TCP aborts; no synthetic TLS or credential files.
test("HTTP abort during delayed route lookup never dispatches and follow-up health survives", async (t) => {
  const entered = deferred(),
    release = deferred(),
    closed = deferred();
  let calls = 0;
  const f = await fixture(t, {
    cloud: {
      routes: async () => {
        if (calls++ === 0) {
          entered.resolve();
          await release.promise;
        }
        return null;
      },
    },
  });
  f.proxy.once("request", (_, res) => res.once("close", closed.resolve));
  const req = httpRequest({
    host: "127.0.0.1",
    port: f.port,
    path: "/aborted",
  });
  req.on("error", () => {});
  req.end();
  await bounded(entered.promise);
  req.destroy();
  await bounded(closed.promise);
  release.resolve();
  await pause();
  assert.equal(f.observed.connections, 0);
  const healthy = await bounded(f.get());
  assert.equal(healthy.status, 200);
  assert.equal(JSON.parse(healthy.body).peer, "127.0.0.1");
});

test("HTTP async routing and synchronous dispatch failures become503 without killing proxy", async (t) => {
  let routeCalls = 0,
    dispatchCalls = 0;
  const f = await fixture(t, {
    cloud: {
      routes: async () => {
        if (routeCalls++ === 0) throw Error("Route unavailable");
        return null;
      },
    },
    dispatch: {
      httpRequest: (...args) => {
        if (dispatchCalls++ === 0) throw Error("Dispatch unavailable");
        return httpRequest(...args);
      },
    },
  });
  assert.equal((await bounded(f.get())).status, 503);
  assert.equal((await bounded(f.get())).status, 503);
  assert.equal((await bounded(f.get())).status, 200);
});

test("HTTP downstream close cancels active upstream streaming connection", async (t) => {
  const cancelled = deferred();
  const f = await fixture(t, {
    backend(req, res) {
      if (req.url === "/stream") {
        req.socket.once("close", cancelled.resolve);
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first chunk");
      } else res.end("healthy");
    },
  });
  await bounded(
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: f.port, path: "/stream" },
        (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
          res.on("error", () => {});
        },
      );
      req.on("error", reject);
      req.end();
    }),
  );
  await bounded(cancelled.promise);
  assert.equal((await bounded(f.get())).body, "healthy");
});

test("upgrade abort during delayed route lookup opens no upstream and later upgrades work", async (t) => {
  const entered = deferred(),
    release = deferred(),
    closed = deferred();
  let calls = 0;
  const f = await fixture(t, {
    cloud: {
      routes: async () => {
        if (calls++ === 0) {
          entered.resolve();
          await release.promise;
        }
        return null;
      },
    },
  });
  f.proxy.once("upgrade", (_, socket) => socket.once("close", closed.resolve));
  const first = await rawUpgrade(f.port);
  await bounded(entered.promise);
  first.destroy();
  await bounded(closed.promise);
  release.resolve();
  await pause();
  assert.equal(f.observed.connections, 0);
  const upstreamClosed = deferred();
  f.backend.once("upgrade", (_, socket) =>
    socket.once("close", upstreamClosed.resolve),
  );
  const second = await rawUpgrade(f.port);
  const [data] = await bounded(once(second, "data"));
  assert.match(data.toString(), /^HTTP\/1.1 101 /);
  assert.equal(f.observed.upgrades[0].peer, "127.0.0.1");
  second.destroy();
  await bounded(upstreamClosed.promise);
  assert.equal((await bounded(f.get())).status, 200);
});

test("upgrade async route and synchronous connect failures return503 then recover", async (t) => {
  let routes = 0,
    connects = 0;
  const f = await fixture(t, {
    cloud: {
      routes: async () => {
        if (routes++ === 0) throw Error("Route unavailable");
        return null;
      },
    },
    dispatch: {
      connect: (...args) => {
        if (connects++ === 0) throw Error("Connect unavailable");
        return connect(...args);
      },
    },
  });
  for (let n = 0; n < 3; n++) {
    const socket = await rawUpgrade(f.port);
    const [data] = await bounded(once(socket, "data"));
    assert.match(
      data.toString(),
      n < 2 ? /^HTTP\/1.1 503 / : /^HTTP\/1.1 101 /,
    );
    socket.destroy();
  }
  assert.equal((await bounded(f.get())).status, 200);
});
