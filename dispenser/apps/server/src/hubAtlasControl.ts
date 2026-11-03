/** Typed administrator gateway; no arbitrary URL, method, or command forwarding. */
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors.js";
import { importLegacyTicket } from "./hubSupport.js";
import type { HubRouteOptions } from "./hubSupport.js";
const operations = new Set([
  "node.update",
  "site.update",
  "catalog.update",
  "ai.update",
  "requestLimits.update",
]);
export async function registerHubAtlasControlRoutes(
  app: FastifyInstance,
  o: HubRouteOptions & {
    coordinatorOrigin?: string;
    coordinatorOriginKey?: string;
    serviceSecret: string;
    fetch?: typeof fetch;
  },
) {
  const endpoint = o.coordinatorOrigin?.trim();
  if (endpoint) {
    const u = new URL(endpoint);
    if (
      u.protocol !== "https:" ||
      u.origin !== endpoint ||
      u.username ||
      u.password
    )
      throw Error("ATLAS_COORDINATOR_ORIGIN must be a fixed HTTPS origin.");
  }
  if (o.coordinatorOriginKey && (o.coordinatorOriginKey.length < 16 || /[\r\n]/.test(o.coordinatorOriginKey)))
    throw Error("Coordinator origin routing key is invalid.");
  const enabled = !!endpoint && o.serviceSecret.length >= 32;
  let current: any = null,
    pending = false;
  async function call(
    method: string,
    body?: unknown,
    path = "/api/internal/hub/control",
  ) {
    if (!enabled)
      throw new AppError(
        "VALIDATION_ERROR",
        "Atlas coordinator connection is not configured.",
        503,
      );
    let r;
    try {
      r = await (o.fetch ?? fetch)(endpoint + path, {
        method,
        headers: {
          authorization: "Bearer " + o.serviceSecret,
          ...(o.coordinatorOriginKey ? { "x-atlas-origin-key": o.coordinatorOriginKey } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new AppError(
        "VALIDATION_ERROR",
        "Atlas coordinator is temporarily unavailable.",
        503,
      );
    }
    if (!r.ok)
      throw new AppError(
        "VALIDATION_ERROR",
        r.status === 401
          ? "Administrator verification failed or expired. Start the operation again."
          : r.status === 503
            ? "Coordinator verification is unavailable."
            : "Coordinator request failed.",
        r.status >= 500 ? 503 : r.status,
      );
    return r.json();
  }
  async function refresh() {
    if (!enabled || pending) return;
    pending = true;
    try {
      const value = await call("GET");
      if (!value || !Array.isArray(value.nodes))
        throw Error("Invalid coordinator snapshot");
      current = value;
      const sources = Array.isArray(value.accountPresence?.sources)
        ? value.accountPresence.sources
        : [];
      const validId = (id: unknown) =>
        typeof id === "string" && /^[a-zA-Z0-9_-]{1,90}$/.test(id);
      const fresh = (at: unknown) =>
        typeof at === "string" &&
        Number.isFinite(Date.parse(at)) &&
        Math.abs(Date.now() - Date.parse(at)) <= 45000;
      const proof = (s: any) =>
        s &&
        fresh(s.observedAt) &&
        Array.isArray(s.accountIds) &&
        s.accountIds.length <= 100000 &&
        s.accountIds.every(
          (id: any) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
        );
      const nodes = value.nodes.filter((n: any) => validId(n.id));
      const complete =
        nodes.length > 0 &&
        nodes.every((n: any) => {
          const matches = sources.filter((s: any) => s.nodeId === n.id);
          return (
            matches.length === 1 &&
            proof(matches[0]) &&
            matches[0].complete === true
          );
        });
      // Earlier local candidates split presence/resource rows. Keep their history,
      // but retire those redundant live observations without erasing points.
      await o.pool.query(
        "UPDATE hub_metric_sources SET presence_verified=false,complete=false,account_ids='{}' WHERE id LIKE 'atlas_presence_%' AND presence_verified",
      );
      for (const node of nodes) {
        const source = sources.find((s: any) => s.nodeId === node.id),
          verified = !!proof(source),
          systemFresh = node.system && fresh(node.system.observedAt);
        if (!verified && !systemFresh) continue;
        const ids = verified ? source.accountIds : null;
        const known = ids
          ? (
              await o.pool.query(
                "SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active'",
                [ids],
              )
            ).rows.map((row) => row.id)
          : [];
        const metrics: Record<string, number> = {};
        if (systemFresh)
          for (const [key, v] of Object.entries(node.system.metrics ?? {}))
            if (
              /^[a-z_]{1,60}$/.test(key) &&
              typeof v === "number" &&
              Number.isFinite(v) &&
              v >= 0 &&
              v < 1e16
            )
              metrics[key] = v;
        await o.pool.query(
          "INSERT INTO hub_metric_sources(id,observed_at,account_ids,payload,presence_verified,complete) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,received_at=now(),account_ids=excluded.account_ids,payload=excluded.payload,presence_verified=excluded.presence_verified,complete=excluded.complete WHERE hub_metric_sources.observed_at<excluded.observed_at",
          [
            "atlas_" + node.id,
            verified ? source.observedAt : node.system.observedAt,
            known,
            JSON.stringify(metrics),
            verified,
            complete && source.complete === true,
          ],
        );
      }
    } finally {
      pending = false;
    }
  }
  app.get("/api/admin/hub/atlas", async (request) => {
    await o.requireAdmin(request);
    if (!enabled) return { configured: false };
    await refresh();
    return { configured: true, ...current };
  });
  app.post("/api/admin/hub/atlas/challenge", async (request) => {
    const user = await o.requireAdmin(request);
    o.csrf(request, user);
    const b = request.body as any;
    if (
      !operations.has(b?.operation) ||
      !b.input ||
      typeof b.input !== "object" ||
      Array.isArray(b.input)
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "Choose a supported control operation.",
      );
    return call(
      "POST",
      {
        operation: b.operation,
        input: b.input,
        administrator: { userId: user.id, sessionId: user.sessionId },
      },
      "/api/internal/hub/control/challenge",
    );
  });
  app.post("/api/admin/hub/atlas/command", async (request) => {
    const u = await o.requireAdmin(request);
    o.csrf(request, u);
    const b = request.body as any;
    if (
      !b ||
      !operations.has(b.operation) ||
      !b.input ||
      typeof b.input !== "object" ||
      Array.isArray(b.input)
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "Choose a supported control operation.",
      );
    current = await call("POST", {
      operation: b.operation,
      input: b.input,
      administrator: { userId: u.id, sessionId: u.sessionId },
      challengeId: b.challengeId,
      password: b.password,
      code: b.code,
    });
    return { configured: true, ...current };
  });
  const timer = setInterval(() => {
    void refresh().catch((error) =>
      app.log.error({ err: error }, "Atlas telemetry unavailable"),
    );
  }, 15000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  return {
    refresh,
    sourceLabel: (id: string) => {
      const key = id.startsWith("atlas_") ? id.slice(6) : id;
      return (
        current?.nodes?.find((n: any) => n.id === key)?.name ||
        (key === "local"
          ? "Main server"
          : id.startsWith("atlas_")
            ? "Traffic node"
            : id)
      );
    },
    verifyLegacy: async (source: string, id: string, token: string) => {
      if (source !== "atlas" || !enabled) return false;
      try {
        const data = await call(
          "POST",
          { source, id, token },
          "/api/internal/hub/control/legacy-ticket",
        );
        await importLegacyTicket(o.pool, data);
        return true;
      } catch {
        return false;
      }
    },
  };
}
