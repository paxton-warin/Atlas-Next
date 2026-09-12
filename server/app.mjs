import { fetchSearchSuggestions } from "./search-suggestions.mjs";
import { createNodePool } from "./node-pool.mjs";
import { requestOrigin } from "./request-origin.mjs";
import Fastify from "fastify";
import { installAi } from "./ai.mjs";
import fastifyStatic from "@fastify/static";
import argon2 from "argon2";
import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { openStore, token, digest } from "./store.mjs";
export const otp = (secret) =>
  new TOTP({
    issuer: "Atlas",
    label: "Owner",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
export const defaults = () => ({
  dataDir: resolve(process.env.DATA_DIR || "data"),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:4180",
  runtimeOrigin:
    process.env.RUNTIME_ORIGIN ||
    (process.env.LOCAL_BROWSING === "false"
      ? "https://runtime.invalid"
      : "http://127.0.0.1:4181"),
  adminPath: process.env.ADMIN_PATH || "/_control/atlas-owner",
  staticDir: resolve("dist/web"),
  dynamicOrigins: true,
  nodesEnabled: false,
});
export async function createApp(options = {}) {
  const config = { ...defaults(), ...options };
  if (
    new URL(config.appOrigin).hostname ===
    new URL(config.runtimeOrigin).hostname
  )
    throw Error(
      "Application and runtime require distinct hostnames (not only ports).",
    );
  if (!/^\/_control\/[a-zA-Z0-9_-]{8,100}$/.test(config.adminPath))
    throw Error(
      "ADMIN_PATH must be /_control/ followed by 8–100 letters, digits, hyphens or underscores.",
    );
  const secure = new URL(config.appOrigin).protocol === "https:";
  if (
    process.env.NODE_ENV === "production" &&
    (!secure || !config.runtimeOrigin.startsWith("https://"))
  )
    throw Error("Production origins require HTTPS.");
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024,
    trustProxy: process.env.TRUST_PROXY
      ? process.env.TRUST_PROXY.split(",")
      : false,
  });
  const originFor = (req) =>
    config.dynamicOrigins
      ? requestOrigin(req, config.appOrigin)
      : config.appOrigin;
  const store = openStore(config.dataDir),
    { db, get, set, audit, seal, unseal } = store;
  const pool = createNodePool(store, { runtimeOrigin: config.runtimeOrigin });
  app.decorate("nodePool", pool);
  app.decorate("store", store);
  app.decorate("atlasConfig", config);
  app.addHook("onClose", () => db.close());
  const fail = (message, statusCode = 400) =>
    Object.assign(new Error(message), { statusCode });
  const text = (v, min, max) => {
    if (typeof v !== "string" || v.trim().length < min || v.length > max)
      throw fail(`Enter between ${min} and ${max} characters.`);
    return v.trim();
  };
  const rate = (key, max, window) => {
    const now = Date.now();
    db.prepare("DELETE FROM limits WHERE reset<?").run(now);
    db.prepare(
      "INSERT INTO limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
    ).run(key, now + window);
    if (db.prepare("SELECT count FROM limits WHERE key=?").get(key).count > max)
      throw fail("Please wait before trying again.", 429);
  };
  const ip = (req) => digest(req.ip);
  const name = secure ? "__Host-atlas-admin" : "atlas-admin";
  const cookie = (value, age) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  function session(req, mutation = false) {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1);
    const row = raw
      ? db.prepare("SELECT * FROM sessions WHERE hash=?").get(digest(raw))
      : null;
    if (
      !row ||
      Date.now() - row.seen > 3600000 ||
      Date.now() - row.created > 43200000
    )
      throw fail("Verify administrator access to continue.", 401);
    if (mutation && req.headers["x-atlas-csrf"] !== row.csrf)
      throw fail("Refresh the page before continuing.", 403);
    db.prepare("UPDATE sessions SET seen=? WHERE hash=?").run(
      Date.now(),
      row.hash,
    );
    return row;
  }
  function startSession(reply) {
    const raw = token(),
      csrf = token(),
      now = Date.now();
    db.prepare("DELETE FROM sessions WHERE created<? OR seen<?").run(
      now - 43200000,
      now - 3600000,
    );
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(
      digest(raw),
      csrf,
      now,
      now,
    );
    reply.header("Set-Cookie", cookie(raw, 43200));
    return { csrf };
  }
  function verifyOtp(secret, code) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
    const delta = otp(secret).validate({ token: code, window: 1 });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30000) + delta;
    if (step <= (get("lastTotpStep") ?? -1)) return false;
    set("lastTotpStep", step);
    return true;
  }
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "X-Frame-Options",
        req.url.startsWith("/games/") ? "SAMEORIGIN" : "DENY",
      );
    reply.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' ${config.runtimeOrigin} ${pool
        .list()
        .filter((n) => n.id !== "local")
        .map((n) => n.endpoint)
        .join(
          " ",
        )}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${req.url.startsWith("/games/") ? "'self'" : "'none'"}`,
    );
    reply.header(
      "Permissions-Policy",
      `camera=(self "${config.runtimeOrigin}"), microphone=(self "${config.runtimeOrigin}"), geolocation=()`,
    );
    if (secure) reply.header("Strict-Transport-Security", "max-age=31536000");
    if (req.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      if (req.url === "/api/nodes/heartbeat") return;
      if (req.headers.origin && req.headers.origin !== originFor(req))
        throw fail("Origin mismatch.", 403);
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.headers.origin !== originFor(req)
      )
        throw fail("Origin required.", 403);
      rate("api:" + ip(req), 600, 60000);
    }
  });
  app.setErrorHandler((err, req, reply) =>
    reply.code(err.statusCode || 500).send({
      error: err.statusCode
        ? err.message
        : "The request could not be completed.",
    }),
  );
  app.get("/api/config", () => ({
    name: get("siteName") || "Atlas",
    runtimeOrigin: config.runtimeOrigin,
    engines: ["scramjet"],
    nodeRouting: config.nodesEnabled,
  }));
  app.get("/health", () => {
    db.prepare("SELECT 1").get();
    return { status: "ok", database: "ready" };
  });
  app.post("/api/search/suggestions", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    rate("suggestions:" + ip(req), 120, 60000);
    const q = req.body?.q;
    // Search terms only: don't forward addresses, URL tokens or credentials.
    if (
      typeof q !== "string" ||
      q.trim().length < 2 ||
      q.length > 120 ||
      /[\/\\@?#=]|^[a-z][a-z0-9+.-]*:|^\S+\.\S+$|[\x00-\x1f]/i.test(q.trim())
    )
      return { suggestions: [] };
    try {
      return {
        suggestions: await (
          config.suggestionProvider || fetchSearchSuggestions
        )(q),
      };
    } catch {
      return { suggestions: [] };
    }
  });
  app.get("/api/catalog", () =>
    db.prepare("SELECT * FROM catalog WHERE enabled=1 ORDER BY rowid").all(),
  );
  app.get("/api/admin/state", (req) => {
    session(req);
    return { initialized: !!get("admin"), csrf: session(req).csrf };
  });
  app.post("/api/admin/access", (req) => {
    if (req.body?.path !== config.adminPath) throw fail("Not found.", 404);
    return { initialized: !!get("admin") };
  });
  app.post("/api/admin/enroll", async (req) => {
    rate("login:" + ip(req), 8, 900000);
    if (get("admin"))
      throw fail("Administrator setup is already complete.", 409);
    const setup = get("bootstrap");
    if (
      !setup ||
      setup.expires < Date.now() ||
      digest(req.body?.token) !== setup.hash
    )
      throw fail("Setup token is invalid or expired.", 401);
    const password = text(req.body.password, 12, 128),
      secret = new Secret({ size: 20 }).base32,
      challenge = token();
    const pending = {
      hash: digest(challenge),
      secret: seal(secret),
      password: await argon2.hash(password, { type: argon2.argon2id }),
      expires: Date.now() + 600000,
    };
    set("enrollment", pending);
    return {
      challenge,
      secret,
      qr: await QRCode.toDataURL(otp(secret).toString()),
    };
  });
  app.post("/api/admin/complete", (req, reply) => {
    rate("login:" + ip(req), 8, 900000);
    const pending = get("enrollment");
    if (
      get("admin") ||
      !pending ||
      pending.expires < Date.now() ||
      digest(req.body?.challenge) !== pending.hash
    )
      throw fail("Start administrator setup again.", 401);
    if (!verifyOtp(unseal(pending.secret), req.body.code))
      throw fail("Authenticator code is invalid or already used.", 401);
    const recovery = Array.from({ length: 8 }, () =>
      randomBytes(12).toString("hex"),
    );
    set("admin", {
      password: pending.password,
      secret: pending.secret,
      recovery: recovery.map(digest),
    });
    set("enrollment", null);
    set("bootstrap", null);
    audit("admin.enrolled");
    return { ...startSession(reply), recovery };
  });
  app.post("/api/admin/login", async (req, reply) => {
    rate("login:" + ip(req), 8, 900000);
    const admin = get("admin");
    if (
      !admin ||
      typeof req.body?.password !== "string" ||
      req.body.password.length > 128 ||
      !(await argon2.verify(admin.password, req.body.password))
    )
      throw fail("Verification failed.", 401);
    const code = String(req.body.code || "");
    const recoveryHash = digest(code);
    if (admin.recovery.includes(recoveryHash)) {
      admin.recovery = admin.recovery.filter((x) => x !== recoveryHash);
      set("admin", admin);
      audit("admin.recovery_used");
    } else if (!verifyOtp(unseal(admin.secret), code))
      throw fail("Verification failed. Use a fresh authenticator code.", 401);
    audit("admin.login");
    return startSession(reply);
  });
  app.post("/api/admin/logout", (req, reply) => {
    const s = session(req, true);
    db.prepare("DELETE FROM sessions WHERE hash=?").run(s.hash);
    reply.header("Set-Cookie", cookie("", 0));
    return { ok: true };
  });
  app.post("/api/tickets", (req) => {
    rate("ticket:" + ip(req), 5, 3600000);
    if (req.body?.website) throw fail("Submission rejected.");
    const subject = text(req.body?.subject, 3, 120),
      body = text(req.body?.body, 10, 5000),
      category = text(req.body?.category, 2, 30);
    if (!["Browsing", "Games", "Suggestion", "Other"].includes(category))
      throw fail("Choose a category.");
    const id = randomBytes(6).toString("hex"),
      access = token(),
      now = Date.now();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?,?)").run(
        id,
        digest(access),
        subject,
        category,
        "open",
        now,
        now,
      );
      db.prepare(
        "INSERT INTO messages(ticket,author,body,created) VALUES (?,?,?,?)",
      ).run(id, "visitor", body, now);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { id, token: access };
  });
  function ticketAccess(req) {
    const row = db
      .prepare("SELECT * FROM tickets WHERE id=?")
      .get(req.params.id);
    const supplied = digest(
      (req.headers.authorization || "").replace(/^Bearer /, ""),
    );
    if (
      !row ||
      !timingSafeEqual(Buffer.from(row.secret), Buffer.from(supplied))
    )
      throw fail("Ticket not found.", 404);
    return row;
  }
  function publicTicket(row) {
    const { secret, ...safe } = row;
    return {
      ...safe,
      messages: db
        .prepare(
          "SELECT author,body,created FROM messages WHERE ticket=? ORDER BY id",
        )
        .all(row.id),
    };
  }
  app.get("/api/tickets/:id", (req) => publicTicket(ticketAccess(req)));
  function append(row, author, body) {
    const now = Date.now();
    db.prepare(
      "INSERT INTO messages(ticket,author,body,created) VALUES (?,?,?,?)",
    ).run(row.id, author, body, now);
    db.prepare("UPDATE tickets SET updated=?,status=? WHERE id=?").run(
      now,
      author === "admin" ? "awaiting_you" : "open",
      row.id,
    );
  }
  app.post("/api/tickets/:id/messages", (req) => {
    const row = ticketAccess(req);
    rate("reply:" + row.id, 30, 3600000);
    append(row, "visitor", text(req.body?.body, 1, 5000));
    return { ok: true };
  });
  app.get("/api/admin/tickets", (req) => {
    session(req);
    return db
      .prepare(
        "SELECT id,subject,category,status,created,updated FROM tickets ORDER BY updated DESC LIMIT 200",
      )
      .all();
  });
  app.get("/api/admin/tickets/:id", (req) => {
    session(req);
    const row = db
      .prepare("SELECT * FROM tickets WHERE id=?")
      .get(req.params.id);
    if (!row) throw fail("Ticket not found.", 404);
    return publicTicket(row);
  });
  app.post("/api/admin/tickets/:id/messages", (req) => {
    session(req, true);
    const row = db
      .prepare("SELECT * FROM tickets WHERE id=?")
      .get(req.params.id);
    if (!row) throw fail("Ticket not found.", 404);
    append(row, "admin", text(req.body?.body, 1, 5000));
    audit("ticket.replied", row.id);
    return { ok: true };
  });
  app.patch("/api/admin/tickets/:id", (req) => {
    session(req, true);
    const status = req.body?.status;
    if (!["open", "closed"].includes(status)) throw fail("Invalid status.");
    const result = db
      .prepare("UPDATE tickets SET status=?,updated=? WHERE id=?")
      .run(status, Date.now(), req.params.id);
    if (!result.changes) throw fail("Ticket not found.", 404);
    audit("ticket." + status, req.params.id);
    return { ok: true };
  });
  app.get("/api/admin/catalog", (req) => {
    session(req);
    return db.prepare("SELECT * FROM catalog ORDER BY rowid").all();
  });
  app.put("/api/admin/catalog/:id", (req) => {
    session(req, true);
    const b = req.body,
      id = text(req.params.id, 1, 64),
      name = text(b.name, 1, 80),
      description = text(b.description, 1, 180),
      category = text(b.category, 1, 30),
      url = text(b.url, 1, 2048);
    if (
      !/^https:\/\/[^\s]+$/.test(url) &&
      !/^\/games\/[a-z0-9-]+\.html$/.test(url)
    )
      throw fail("Use an HTTPS URL or a built-in game path.");
    if (url.startsWith("https:")) {
      const u = new URL(url);
      if (u.username || u.password)
        throw fail("URL credentials are not supported.");
    }
    const artwork = [
      "numbers",
      "snake",
      "tic",
      "hex",
      "alchemy",
      "chess",
    ].includes(b.artwork)
      ? b.artwork
      : "hex";
    const existing = db
      .prepare("SELECT kind,thumbnail FROM catalog WHERE id=?")
      .get(id);
    const kind = b.kind === undefined ? existing?.kind || "game" : b.kind;
    if (!["app", "game"].includes(kind)) throw fail("Choose App or Game.");
    const thumbnail = existing?.thumbnail || "";
    db.prepare(
      "INSERT INTO catalog (id,name,description,url,artwork,category,enabled,kind,thumbnail) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,artwork=excluded.artwork,category=excluded.category,enabled=excluded.enabled,kind=excluded.kind",
    ).run(
      id,
      name,
      description,
      url,
      artwork,
      category,
      b.enabled === false ? 0 : 1,
      kind,
      thumbnail,
    );
    audit("catalog.saved", id);
    return { ok: true };
  });
  app.get("/api/admin/overview", (req) => {
    session(req);
    return {
      tickets: db.prepare("SELECT count(*) n FROM tickets").get().n,
      open: db
        .prepare("SELECT count(*) n FROM tickets WHERE status!='closed'")
        .get().n,
      catalog: db
        .prepare("SELECT count(*) n FROM catalog WHERE enabled=1")
        .get().n,
      name: get("siteName") || "Atlas",
      runtime: existsSync("runtime/public/manifest.json")
        ? JSON.parse(readFileSync("runtime/public/manifest.json", "utf8"))
        : { status: "build required" },
      audit: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 50").all(),
    };
  });
  app.put("/api/admin/settings", (req) => {
    session(req, true);
    set("siteName", text(req.body?.name, 1, 40));
    audit("settings.saved");
    return { ok: true };
  });
  app.post("/api/browse/session", async (req) => {
    rate("browse:" + ip(req), 60, 60000);
    return pool.allocate(
      req.body?.session,
      originFor(req),
      config.runtimeOrigin,
    );
  });
  app.delete("/api/browse/session", (req) => {
    pool.release(req.body?.session, originFor(req));
    return { ok: true };
  });
  app.post("/api/nodes/heartbeat", async (req) => {
    rate("node-heartbeat:" + ip(req), 120, 60000);
    await pool.heartbeat(
      req.body?.id,
      req.headers.authorization?.replace(/^Bearer /, ""),
      req.body?.connections,
    );
    return pool.nodeState(req.body.id);
  });
  app.get("/api/admin/nodes", (req) => {
    session(req);
    return pool.list();
  });
  app.post("/api/admin/nodes", (req) => {
    session(req, true);
    return pool.attach(req.body, originFor(req));
  });
  app.put("/api/admin/nodes/:id", (req) => {
    session(req, true);
    pool.update(req.params.id, req.body);
    return { ok: true };
  });
  app.delete("/api/admin/nodes/:id", (req) => {
    session(req, true);
    pool.remove(req.params.id);
    return { ok: true };
  });
  installAi(app, { store, session, rate, ip, fail });
  if (existsSync(config.staticDir)) {
    await app.register(fastifyStatic, { root: config.staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method !== "GET" ||
        req.url.startsWith("/api/") ||
        (req.url.startsWith("/_control/") &&
          req.url.split("?")[0] !== config.adminPath)
      )
        return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
