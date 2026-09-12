import { requestOrigin } from "./request-origin.mjs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { Socket } from "node:net";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { resolve } from "node:path";
export function isPublicIp(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function guardedSocket({ fixture = false, blockedHosts = [] } = {}) {
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
        fixture && this.hostname === "127.0.0.1" && this.port === 4199;
      if (
        !allowedFixture &&
        (blockedHosts.includes(this.hostname.toLowerCase()) ||
          ![80, 443].includes(this.port))
      )
        throw Error("Destination rejected");
      const addresses = await lookup(this.hostname, { all: true });
      if (
        !addresses.length ||
        (!allowedFixture && addresses.some((x) => !isPublicIp(x.address)))
      )
        throw Error("Destination rejected");
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
}) {
  const app = Fastify({
    logger: false,
    trustProxy: process.env.TRUST_PROXY
      ? process.env.TRUST_PROXY.split(",")
      : false,
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
  const getAuthorization = (req, origin) => {
    const raw =
      req.headers.authorization?.replace(/^Bearer /, "") ||
      new URL(req.url, "http://runtime").pathname.match(
        /^\/(?:relay|wisp)\/([A-Za-z0-9_.-]+)\/$/,
      )?.[1];
    return authorize?.(raw, origin || requestOrigin(req, runtimeOrigin));
  };
  const perIp = new Map();
  app.server.on("upgrade", (req, socket, head) => {
    let assignment;
    try {
      assignment = getAuthorization(req, req.headers.origin);
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
      socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }
    sockets.add(socket);
    if (authorize)
      authorizations.set(socket, () =>
        getAuthorization(req, req.headers.origin),
      );
    if (sessionKey) sessions.set(sessionKey, sessionCount + 1);
    if (!authorize) perIp.set(ip, n + 1);
    socket.on("close", () => {
      sockets.delete(socket);
      authorizations.delete(socket);
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
    wisp.routeRequest(req, socket, head, { TCPSocket: Tcp });
  });
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
    for (const s of sockets) s.destroy();
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
    if (req.url.endsWith("sw.js") || req.url.endsWith("worker.js"))
      reply
        .header("Cache-Control", "no-cache")
        .header("Service-Worker-Allowed", "/");
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
    };
  });
  if (health) app.get("/node/health", health);
  app.decorate("connectionCount", () => sockets.size);
  app.get("/health", () => ({ status: "ok", wisp: "listening" }));
  await app.register(fastifyStatic, { root: staticDir });
  app.setNotFoundHandler((req, reply) => {
    if (
      ["/~/app/", "/~/sj/", "/uv/service/"].some((prefix) =>
        req.url.startsWith(prefix),
      )
    )
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
