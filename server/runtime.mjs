import { requestOrigin, createUpgradeOrigin } from "./request-origin.mjs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { createDestinationResolver } from "./destination-resolver.mjs";
export { isPublicIp } from "./destination-resolver.mjs";
import { resolve } from "node:path";
import { connectionErrorBody } from "./node-ticket.mjs";
export function guardedSocket({ fixture = false, blockedHosts = [] } = {}) {
  const resolveDestination = createDestinationResolver();
  return class GuardedTcp {
    constructor(hostname, port) {
      this.hostname = hostname;
      this.port = port;
      this.queue = [];
      this.waiters = [];
      this.socket = null;
      this.ended = false;
    }
    async connect() {
      const allowedFixture =
        fixture &&
        ["127.0.0.1", "localhost"].includes(this.hostname) &&
        this.port === 4199;
      if (
        !allowedFixture &&
        (blockedHosts.includes(this.hostname.toLowerCase()) ||
          ![80, 443].includes(this.port))
      )
        throw Error("Destination rejected");
      const addresses = await resolveDestination(this.hostname, {
        allowPrivate: allowedFixture,
      });
      await new Promise((ok, bad) => {
        const socket = (this.socket = new Socket());
        socket.setNoDelay(true);
        socket.setTimeout(30000, () => socket.destroy());
        const abort = setTimeout(
          () => socket.destroy(new Error("Connect timeout")),
          15000,
        );
        socket.once("error", bad);
        socket.once("connect", () => {
          clearTimeout(abort);
          socket.setTimeout(0);
          ok();
        });
        socket.on("data", (data) => {
          const waiter = this.waiters.shift();
          if (waiter) waiter(data);
          else this.queue.push(data);
          if (this.queue.length >= 32) socket.pause();
        });
        socket.on("close", () => {
          clearTimeout(abort);
          this.ended = true;
          for (const fn of this.waiters.splice(0)) fn(null);
        });
        socket.on("error", () => {});
        socket.connect({
          host: this.hostname,
          port: this.port,
          autoSelectFamily: true,
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, addresses)
              : callback(null, addresses[0].address, addresses[0].family),
        });
      });
    }
    async recv() {
      if (this.queue.length) {
        const v = this.queue.shift();
        this.resume();
        return v;
      }
      if (this.ended) return null;
      return new Promise((resolve) => this.waiters.push(resolve));
    }
    async send(data) {
      if (!this.socket || this.ended) throw Error("Stream closed");
      await new Promise((ok, bad) =>
        this.socket.write(data, (e) => (e ? bad(e) : ok())),
      );
    }
    pause() {
      if (this.queue.length >= 32) this.socket?.pause();
    }
    resume() {
      if (this.queue.length < 16) this.socket?.resume();
    }
    async close() {
      this.ended = true;
      this.socket?.destroy();
      for (const fn of this.waiters.splice(0)) fn(null);
    }
  };
}
export async function createRuntime({
  appOrigin,
  runtimeOrigin,
  staticDir = resolve("dist/runtime"),
  fixture = false,
  baseline = false,
  authorize,
  health,
  relayMaintenance = {},
}) {
  const app = Fastify({
    logger: false,
    trustProxy: process.env.TRUST_PROXY
      ? process.env.TRUST_PROXY.split(",")
      : false,
  });
  app.setErrorHandler((error, req, reply) => {
    reply.code(error.statusCode || 500).send(connectionErrorBody(error));
  });
  logging.set_level(logging.NONE);
  Object.assign(wisp.options, {
    allow_udp_streams: false,
    allow_private_ips: fixture,
    allow_loopback_ips: fixture,
    stream_limit_total: 128,
    stream_limit_per_host: -1,
    parse_real_ip: false,
  });
  const Tcp = guardedSocket({
    fixture,
    blockedHosts: [
      new URL(appOrigin).hostname,
      new URL(runtimeOrigin).hostname,
    ],
  });
  const sockets = new Set();
  const sessions = new Map();
  const authorizations = new Map();
  const relays = new Map();
  const websocketServer = new WebSocketServer({ noServer: true });
  const maintenanceNow = relayMaintenance.now || Date.now;
  const retiredIdleMs = relayMaintenance.retiredIdleMs ?? 60000;
  const pongTimeoutMs = relayMaintenance.pongTimeoutMs ?? 65000;
  const maintenanceIntervalMs = relayMaintenance.intervalMs ?? 10000;
  const relayTotals = { rejectedCapacity: 0, reclaimedRetired: 0, deadPeers: 0 };
  const getAuthorization = (req, origin, purpose = "runtime", options) => {
    const raw =
      req.headers.authorization?.replace(/^Bearer /, "") ||
      new URL(req.url, "http://runtime").pathname.match(
        /^\/(?:relay|wisp)\/([A-Za-z0-9_.-]+)\/$/,
      )?.[1];
    return authorize?.(raw, origin || upgradeOrigin(req), purpose, {
      ...options,
      relayOrigin: purpose === "relay" ? upgradeOrigin(req) : undefined,
    });
  };
  const perIp = new Map();
  const upgradeOrigin = createUpgradeOrigin(
    runtimeOrigin,
    process.env.TRUST_PROXY?.split(",") || [],
  );
  app.server.on("upgrade", (req, socket, head) => {
    // A separate purpose-bound upload gateway owns this reserved path. Never
    // consume/reject its upgrade with the Wisp relay ticket verifier first.
    if (
      app.hasDecorator("nativeResourceGateway") &&
      new URL(req.url, "http://runtime").pathname.startsWith(
        "/native-resource/v1/owner/",
      )
    )
      return;
    let assignment;
    try {
      assignment = getAuthorization(req, req.headers.origin, "relay");
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    if (
      !/^\/(relay|wisp)\/(?:[A-Za-z0-9_.-]+\/)?$/.test(
        new URL(req.url, "http://runtime").pathname,
      ) ||
      (authorize ? !req.headers.origin : req.headers.origin !== runtimeOrigin)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const ip = req.socket.remoteAddress,
      n = perIp.get(ip) || 0;
    const sessionKey = assignment?.session;
    const sessionCount = sessionKey ? sessions.get(sessionKey) || 0 : 0;
    if ((!authorize && n >= 24) || sessionCount >= 12 || sockets.size >= 200) {
      relayTotals.rejectedCapacity++;
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 5\r\n\r\n");
      return;
    }
    sockets.add(socket);
    if (authorize)
      authorizations.set(socket, () =>
        getAuthorization(req, req.headers.origin, "relay", {
          established: true,
        }),
      );
    if (sessionKey) sessions.set(sessionKey, sessionCount + 1);
    if (!authorize) perIp.set(ip, n + 1);
    socket.on("close", () => {
      sockets.delete(socket);
      authorizations.delete(socket);
      relays.delete(socket);
      if (sessionKey) {
        const left = (sessions.get(sessionKey) || 1) - 1;
        if (left) sessions.set(sessionKey, left);
        else sessions.delete(sessionKey);
      }
      if (!authorize) {
        const left = (perIp.get(ip) || 1) - 1;
        if (left) perIp.set(ip, left);
        else perIp.delete(ip);
      }
    });
    // The package's routeRequest hides its WebSocket/ServerConnection. Own only
    // the upgrade adapter, retaining the same pinned Wisp protocol and guarded
    // TCP implementation, so lifecycle checks can inspect real live streams.
    try {
      websocketServer.handleUpgrade(req, socket, head, (ws) => {
        ws.binaryType = "arraybuffer";
        ws.on("error", () => {});
        const now = maintenanceNow();
        const connection = new wisp.ServerConnection(ws, req.url, {
          TCPSocket: Tcp,
          wisp_version:
            req.headers["sec-websocket-protocol"] && wisp.options.wisp_version === 2
              ? 2
              : 1,
        });
        const relay = {
          ws,
          connection,
          session: sessionKey,
          generation: assignment?.generation,
          ticketExpiresAt: assignment?.ticketExpiresAt,
          ready: false,
          lastActivity: now,
          lastPong: now,
        };
        relays.set(socket, relay);
        ws.on("message", () => { relay.lastActivity = maintenanceNow(); });
        ws.on("pong", () => { relay.lastPong = maintenanceNow(); });
        void (async () => {
          try {
            await connection.setup();
            relay.ready = true;
            await connection.run();
          } catch {
            await connection.cleanup().catch(() => {});
          } finally {
            clearInterval(connection.ping_task);
            ws.terminate();
          }
        })();
      });
    } catch {
      socket.destroy();
    }
  });
  const maintainConnections = () => {
    const now = maintenanceNow();
    for (const relay of relays.values()) {
      if (relay.ws.readyState !== WebSocket.OPEN) continue;
      // Protocol pongs, not application traffic, establish peer liveness. A
      // quiet but healthy website WebSocket/media stream is never idle-closed.
      if (now - relay.lastPong > pongTimeoutMs) {
        relayTotals.deadPeers++;
        relay.ws.terminate();
        continue;
      }
      if (
        !relay.ready ||
        !relay.session ||
        !Number.isFinite(relay.ticketExpiresAt) ||
        Object.keys(relay.connection.streams).length ||
        now - relay.lastActivity < retiredIdleMs
      ) continue;
      // Old httpengine builds cache a relay by its ticket-bearing URL. Reap
      // only an empty superseded relay after its replacement is established.
      // Unique idle relays and every relay containing a live TCP stream stay.
      const replacement = [...relays.values()].some((next) =>
        next !== relay && next.ready && next.ws.readyState === WebSocket.OPEN &&
        next.session === relay.session && next.generation === relay.generation &&
        next.ticketExpiresAt > relay.ticketExpiresAt &&
        now - next.lastPong <= pongTimeoutMs,
      );
      if (replacement) {
        relayTotals.reclaimedRetired++;
        relay.ws.terminate();
      }
    }
  };
  const maintenanceTimer = setInterval(maintainConnections, maintenanceIntervalMs);
  maintenanceTimer.unref();
  app.decorate("maintainConnections", maintainConnections);
  const activeSessionCount = () => {
    const now = maintenanceNow();
    const active = new Set();
    for (const [socket, relay] of relays) {
      if (
        !relay.ready || relay.ws.readyState !== WebSocket.OPEN ||
        !relay.session || active.has(relay.session) ||
        now - relay.lastPong > pongTimeoutMs
      ) continue;
      try {
        // Count an authenticated browsing assignment, not every ticket/socket.
        // Revalidate without touching the lease: revoked, moved, idle-expired,
        // or control-stale sockets stop counting before their cleanup timer.
        const assignment = authorizations.get(socket)?.();
        if (assignment?.session === relay.session) active.add(relay.session);
      } catch {
        // An open TCP/WebSocket handle is not proof of a current assignment.
      }
    }
    return active.size;
  };
  app.decorate("connectionStats", () => ({
    connections: sockets.size,
    sessions: sessions.size,
    activeSessions: activeSessionCount(),
    maxConnectionsPerSession: Math.max(0, ...sessions.values()),
    emptyConnections: [...relays.values()].filter((relay) =>
      relay.ready && !Object.keys(relay.connection.streams).length,
    ).length,
    activeStreams: [...relays.values()].reduce((total, relay) =>
      total + Object.keys(relay.connection.streams).length, 0,
    ),
    capacity: 200,
    perSessionCapacity: 12,
    ...relayTotals,
  }));
  const recheckConnections = () => {
    for (const [socket, check] of authorizations) {
      try {
        check();
      } catch {
        socket.destroy();
      }
    }
  };
  const authorizationTimer = authorize
    ? setInterval(recheckConnections, 5000)
    : null;
  authorizationTimer?.unref();
  app.decorate("recheckConnections", recheckConnections);
  app.addHook("onClose", () => {
    if (authorizationTimer) clearInterval(authorizationTimer);
    clearInterval(maintenanceTimer);
    for (const s of sockets) s.destroy();
    websocketServer.close();
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    // Runtime is deliberately not cross-origin isolated: frame behavior is qualified against the upstream demo.
    if (req.url === "/" || req.url.startsWith("/index.html"))
      reply.header(
        "Content-Security-Policy",
        authorize
          ? `frame-ancestors https:${process.env.NODE_ENV === "production" ? "" : " http:"}`
          : `frame-ancestors ${appOrigin}${baseline ? " " + runtimeOrigin : ""}`,
      );
  });
  app.addHook("onSend", async (req, reply, payload) => {
    // Static file headers are applied after onRequest, so worker revalidation
    // belongs here (also covering query strings and negotiated compression).
    if (/(?:sw|worker)\.js(?:\.(?:br|gz))?$/.test(req.url.split("?")[0]))
      reply
        .header("Cache-Control", "no-cache")
        .header("Service-Worker-Allowed", "/");
    return payload;
  });
  app.get("/runtime-config", (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const assignment = getAuthorization(req);
    return {
      appOrigin: assignment?.appOrigin || appOrigin,
      runtimeOrigin: authorize
        ? requestOrigin(req, runtimeOrigin)
        : runtimeOrigin,
      fixture,
      node: assignment?.node,
      ...(assignment
        ? {
            session: assignment.session,
            generation: assignment.generation,
            leaseExpiresAt: assignment.leaseExpiresAt,
            ticketExpiresAt: assignment.ticketExpiresAt,
            serverTime: Date.now(),
          }
        : {}),
      ...(assignment?.relayOrigin
        ? {
            relayOrigin: assignment.relayOrigin,
            relayTicket: assignment.relayTicket,
          }
        : {}),
    };
  });
  if (health) app.get("/node/health", health);
  app.decorate("connectionCount", () => sockets.size);
  app.get("/health", () => ({ status: "ok", wisp: "listening" }));
  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: "/browse/runtime/",
    decorateReply: false,
    preCompressed: true,
  });
  await app.register(fastifyStatic, {
    root: staticDir,
    preCompressed: true,
    setHeaders(response) {
      response.setHeader("Vary", "Accept-Encoding");
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (["/~/app/", "/~/sj/"].some((prefix) => req.url.startsWith(prefix)))
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "Proxy worker is not controlling this page. Return home and retry.",
        );
    return reply.code(404).send({ error: "Not found." });
  });
  return app;
}
