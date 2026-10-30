import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createSystemCollector } from "./hub-system.mjs";
import {
  createAiConfig,
  providerPresets,
  routingReason,
} from "./ai-config.mjs";
const error = (m, statusCode = 400) => Object.assign(Error(m), { statusCode });
const equal = (a, b) =>
  timingSafeEqual(
    createHash("sha256").update(String(a)).digest(),
    createHash("sha256").update(String(b)).digest(),
  );
export function installHubControl(
  app,
  { config, store, pool, requestLimits, verifyAdministrator, performance },
) {
  const collect = createSystemCollector({ dataDir: config.dataDir });
  const ai = createAiConfig(store);
  const challenges = new Map(),
    attempts = new Map();
  const commandHash = (b) =>
    createHash("sha256")
      .update(JSON.stringify({ operation: b.operation, input: b.input }))
      .digest("hex");
  const actor = (b) => {
    if (
      !b?.administrator ||
      !/^[0-9a-f-]{36}$/i.test(b.administrator.userId || "") ||
      !/^[0-9a-f-]{36}$/i.test(b.administrator.sessionId || "")
    )
      throw error("Administrator session binding required.", 401);
    return b.administrator.userId + ":" + b.administrator.sessionId;
  };
  function authorized(req) {
    if (
      !config.hubServiceSecret ||
      config.hubServiceSecret.length < 32 ||
      req.headers.origin ||
      !equal(req.headers.authorization, "Bearer " + config.hubServiceSecret)
    )
      throw error("Service authorization required.", 401);
  }
  function redactedAi() {
    const c = ai.read();
    return {
      ...c,
      providers: c.providers.map(({ key, ...p }) => ({
        ...p,
        hasKey: !!key,
        routingStatus: routingReason(c, { ...p, key }) || "Ready",
      })),
      presets: providerPresets,
    };
  }
  const snapshot = () => ({
    mutationsEnabled:
      config.hubControlMutations === true || !!store.get("admin"),
    mfaRequired: config.hubControlMutations !== true,
    mfaSetupRequired: !store.get("admin"),
    accountPresence: pool.hubPresence?.() || null,
    name: store.get("siteName") || "Atlas",
    nodes: pool.list({ includeConcurrency: true }).map((n) => ({
      ...n,
      system: n.id === "local" ? collect() : n.systemMetrics || null,
    })),
    catalog: store.db.prepare("SELECT * FROM catalog ORDER BY name").all(),
    ai: redactedAi(),
    requestLimits: requestLimits.current(),
    performance: performance?.() || null,
  });
  app.get("/api/internal/hub/control", async (req) => {
    authorized(req);
    return snapshot();
  });
  app.post("/api/internal/hub/control/challenge", async (req) => {
    authorized(req);
    if (!store.get("admin") || !verifyAdministrator)
      throw error("The coordinator administrator must enroll MFA first.", 503);
    const b = req.body,
      binding = actor(b);
    if (
      ![
        "node.update",
        "site.update",
        "catalog.update",
        "ai.update",
        "requestLimits.update",
      ].includes(b.operation) ||
      !b.input ||
      typeof b.input !== "object" ||
      Array.isArray(b.input)
    )
      throw error("Invalid control operation.");
    const now = Date.now();
    for (const [id, c] of challenges)
      if (c.expiresAt <= now) challenges.delete(id);
    if (challenges.size >= 1000) throw error("Try again shortly.", 429);
    const id = randomBytes(32).toString("base64url");
    challenges.set(id, {
      binding,
      hash: commandHash(b),
      expiresAt: now + 120000,
    });
    return { challengeId: id, expiresIn: 120 };
  });
  app.post("/api/internal/hub/control/legacy-ticket", async (req) => {
    authorized(req);
    const b = req.body;
    if (
      b?.source !== "atlas" ||
      !/^[a-f0-9]{12}$/.test(b.id || "") ||
      typeof b.token !== "string" ||
      b.token.length > 1000
    )
      throw error("Ticket capability is invalid.", 403);
    const row = store.db.prepare("SELECT * FROM tickets WHERE id=?").get(b.id);
    if (
      !row ||
      !equal(row.secret, createHash("sha256").update(b.token).digest("hex"))
    )
      throw error("Ticket capability is invalid.", 403);
    return {
      source: "atlas",
      id: row.id,
      subject: row.subject,
      category: row.category,
      status: row.status,
      messages: store.db
        .prepare(
          "SELECT id,author,body,created FROM messages WHERE ticket=? ORDER BY id",
        )
        .all(row.id)
        .map((m) => ({ ...m, createdAt: new Date(m.created).toISOString() })),
    };
  });
  app.post("/api/internal/hub/control", async (req) => {
    authorized(req);
    const b = req.body;
    if (config.hubControlMutations !== true) {
      if (!store.get("admin") || !verifyAdministrator)
        throw error(
          "The coordinator administrator must enroll MFA first.",
          503,
        );
      const binding = actor(b),
        challenge = challenges.get(b.challengeId);
      challenges.delete(b.challengeId);
      if (
        !challenge ||
        challenge.expiresAt <= Date.now() ||
        challenge.binding !== binding ||
        challenge.hash !== commandHash(b)
      )
        throw error(
          "Administrator challenge expired or changed. Start the operation again.",
          401,
        );
      let rate = attempts.get(binding);
      if (!rate || rate.reset < Date.now()) {
        rate = { count: 0, reset: Date.now() + 60000 };
        attempts.set(binding, rate);
      }
      if (++rate.count > 5)
        throw error("Please wait before trying verification again.", 429);
      await verifyAdministrator({ password: b.password, code: b.code });
    }
    if (
      !b ||
      typeof b.operation !== "string" ||
      !b.input ||
      typeof b.input !== "object" ||
      Array.isArray(b.input)
    )
      throw error("Invalid control operation.");
    const v = b.input;
    switch (b.operation) {
      case "node.update":
        if (typeof v.id !== "string") throw error("Node ID required.");
        pool.update(v.id, { state: v.state, weight: v.weight });
        break;
      case "site.update":
        if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 40)
          throw error("Enter a site name.");
        store.set("siteName", v.name.trim());
        break;
      case "requestLimits.update":
        requestLimits.save(v);
        break;
      case "ai.update":
        ai.save(v);
        break;
      case "catalog.update": {
        const string = (x, max) => {
          if (typeof x !== "string" || !x.trim() || x.length > max)
            throw error("Invalid catalog field.");
          return x.trim();
        };
        const id = string(v.id, 64),
          name = string(v.name, 80),
          description = string(v.description, 180),
          category = string(v.category, 30),
          url = string(v.url, 2048);
        if (
          !/^https:\/\/[^\s]+$/.test(url) &&
          !/^\/games\/[a-z0-9-]+\.html$/.test(url)
        )
          throw error("Use HTTPS or a built-in game path.");
        if (url.startsWith("https:")) {
          const u = new URL(url);
          if (u.username || u.password)
            throw error("URL credentials are not supported.");
        }
        const prior = store.db
          .prepare("SELECT kind,thumbnail FROM catalog WHERE id=?")
          .get(id);
        const kind = v.kind ?? prior?.kind ?? "game";
        if (!["game", "app"].includes(kind)) throw error("Choose App or Game.");
        const art = [
          "numbers",
          "snake",
          "tic",
          "hex",
          "alchemy",
          "chess",
        ].includes(v.artwork)
          ? v.artwork
          : "hex";
        store.db
          .prepare(
            "INSERT INTO catalog(id,name,description,url,artwork,category,enabled,kind,thumbnail) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,artwork=excluded.artwork,category=excluded.category,enabled=excluded.enabled,kind=excluded.kind",
          )
          .run(
            id,
            name,
            description,
            url,
            art,
            category,
            v.enabled === false ? 0 : 1,
            kind,
            prior?.thumbnail || "",
          );
        break;
      }
      default:
        throw error("Unknown control operation.");
    }
    store.audit("hub." + b.operation, typeof v.id === "string" ? v.id : "");
    return snapshot();
  });
  app.addHook("onClose", async () => {
    challenges.clear();
    attempts.clear();
  });
  return { collect, snapshot };
}
