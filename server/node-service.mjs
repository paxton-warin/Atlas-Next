import { digest } from "./store.mjs";
import { verifyTicket } from "./node-ticket.mjs";
import { createRuntime } from "./runtime.mjs";
export async function createNodeService({
  id,
  secret,
  fixture = false,
  staticDir,
  runtimeOrigin = "http://localhost:4183",
  pairing,
}) {
  if (!pairing && (!id || typeof secret !== "string" || secret.length < 32))
    throw Error("NODE_ID and NODE_TOKEN are required.");
  let lastRevision = -1;
  let lastControl = 0,
    state = "disabled",
    leases = new Set();
  const app = await createRuntime({
    appOrigin: runtimeOrigin,
    runtimeOrigin,
    fixture,
    staticDir,
    authorize(raw, origin, purpose = "runtime") {
      if (!secret)
        throw Object.assign(Error("Node is not attached."), {
          statusCode: 503,
        });
      const ticket = verifyTicket(raw, secret, origin);
      if (
        ticket.node !== id ||
        state === "disabled" ||
        Date.now() - lastControl > 45000 ||
        !leases.has(ticket.lease)
      )
        throw Object.assign(
          Error("Node session is unavailable. Reconnect from Atlas."),
          { statusCode: 503 },
        );
      if (
        ticket.role === "runtime-host" &&
        (purpose === "relay" ||
          ticket.relayOrigin !== ticket.origin ||
          typeof ticket.relayTicket !== "string")
      )
        throw Object.assign(Error("Invalid runtime-host ticket."), {
          statusCode: 401,
        });
      return {
        ...(ticket.role === "runtime-host"
          ? { relayOrigin: ticket.relayOrigin, relayTicket: ticket.relayTicket }
          : {}),
        appOrigin: ticket.origin,
        session: ticket.lease,
        node: {
          id: ticket.role === "runtime-host" ? "local" : id,
          name: ticket.name,
        },
      };
    },
    health(req, reply) {
      reply.header("Cache-Control", "no-store");
      if (
        !secret ||
        digest(req.headers.authorization || "") !== digest("Bearer " + secret)
      )
        return reply.code(401).send({ error: "Node verification required." });
      return {
        id,
        status: "ok",
        connections: app.connectionCount(),
        capabilities: ["frontend-relay-v1"],
      };
    },
  });
  let attempts = 0,
    reset = Date.now() + 60000;
  app.post("/node/pair", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (Date.now() > reset) {
      attempts = 0;
      reset = Date.now() + 60000;
    }
    if (++attempts > 10)
      return reply
        .code(429)
        .send({ error: "Wait a minute before retrying pairing." });
    const body = req.body || {};
    if (id) {
      if (
        body.id === id &&
        typeof body.token === "string" &&
        digest(body.token) === digest(secret)
      )
        return { ok: true, id };
      return reply.code(409).send({ error: "This node is already attached." });
    }
    if (!pairing || !pairing.verify(body.code))
      return reply
        .code(401)
        .send({ error: "Pairing code is incorrect or expired." });
    let control;
    try {
      control = new URL(body.controlUrl);
    } catch {
      return reply.code(400).send({ error: "Invalid control endpoint." });
    }
    if (
      ![
        "https:",
        ...(process.env.NODE_ENV === "production" ? [] : ["http:"]),
      ].includes(control.protocol) ||
      control.username ||
      control.password ||
      control.pathname !== "/" ||
      typeof body.token !== "string" ||
      body.token.length < 32 ||
      !/^[a-f0-9-]{36}$/.test(body.id || "")
    )
      return reply.code(400).send({ error: "Invalid pairing details." });
    await pairing.save({
      id: body.id,
      secret: body.token,
      control: control.origin,
    });
    id = body.id;
    secret = body.token;
    return { ok: true, id };
  });
  app.post("/node/control", async (req, reply) => {
    if (
      !secret ||
      digest(req.headers.authorization || "") !== digest("Bearer " + secret)
    )
      return reply.code(401).send({ error: "Node verification required." });
    if (
      !["active", "draining", "disabled"].includes(req.body?.state) ||
      !Number.isSafeInteger(req.body?.revision) ||
      !Array.isArray(req.body?.leases) ||
      !req.body.leases.every((x) => /^[a-f0-9]{64}$/.test(x))
    )
      return reply.code(400).send({ error: "Invalid control state." });
    app.applyControl(req.body);
    return { ok: true };
  });
  app.decorate("applyControl", (value) => {
    if (value.revision <= lastRevision) return;
    lastRevision = value.revision;
    state = value.state;
    leases = new Set(value.leases);
    lastControl = Date.now();
    app.recheckConnections();
  });
  return app;
}
