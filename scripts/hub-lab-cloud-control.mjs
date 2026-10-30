/** Test-only counterpart of CloudFront's public routing and deployment API. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export async function createCloudLabControl(state) {
  if (process.env.NODE_ENV !== "test")
    throw Error("Lab cloud control is test-only.");
  const require = createRequire(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../Atlas-Link-Dispenser/apps/server/package.json",
    ),
  );
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: state.databaseUrl });
  const secret = state.serviceSecret;
  const currentHub = async () =>
    (
      await pool.query(
        "SELECT value FROM app_settings WHERE key='hub_current_origin'",
      )
    ).rows[0]?.value || "https://localhost:4300";
  const privateCall = async (path, body) => {
    const response = await fetch("https://localhost:4280" + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + secret,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw Error("Private coordinator request failed: " + response.status);
    return response.json();
  };
  const controlState = async () => {
    const response = await fetch(
      "https://localhost:4280/__lab/simulator/state",
      { headers: { authorization: "Bearer " + secret }, redirect: "error" },
    );
    if (!response.ok) throw Error("Coordinator snapshot unavailable.");
    return response.json();
  };
  const routes = async (origin) =>
    (
      await pool.query(
        "SELECT * FROM hub_cloud_simulator_routes WHERE origin=$1",
        [origin],
      )
    ).rows[0];
  async function handle(request, response) {
    const url = new URL(request.url, "https://" + request.headers.host);
    if (!url.pathname.startsWith("/__lab/cloud/")) return false;
    if (
      url.port !== "4300" ||
      request.method !== "POST" ||
      request.headers.origin ||
      !same(request.headers.authorization, "Bearer " + secret)
    ) {
      response.writeHead(401);
      response.end();
      return true;
    }
    let raw = "";
    for await (const chunk of request) {
      raw += String(chunk);
      if (raw.length > 8_000_000) {
        response.writeHead(413);
        response.end();
        return true;
      }
    }
    try {
      const body = JSON.parse(raw);
      if (
        !/^[a-f0-9-]{36}$/i.test(body.jobId) ||
        !Array.isArray(body.resources ?? body.items)
      )
        throw Error("Invalid operation");
      const action = url.pathname.split("/").at(-1);
      if (action === "prepare") {
        const credentials = JSON.parse(
          readFileSync(
            join(dirname(process.env.ATLAS_LAB_STATE), "nodes.json"),
            "utf8",
          ),
        );
        const items = [];
        for (const { resource: r, distribution: d } of body.resources) {
          if (
            !["hub", "frontend", "node"].includes(r.role) ||
            !/^FAKE[0-9]+$/.test(d.id)
          )
            throw Error("Simulator distributions only.");
          let port = r.role === "hub" ? 4300 : 4280,
            nodeId;
          if (r.role === "node") {
            let index = credentials.findIndex((n) => n.id === r.logicalId);
            if (index < 0 && /^node[234]$/.test(r.logicalId))
              index = Number(r.logicalId.at(-1)) - 2;
            if (index < 0) throw Error("Choose an existing simulated node.");
            port = 4282 + index;
            nodeId = credentials[index].id;
          }
          const origin = `https://${r.role[0]}${body.jobId.replaceAll("-", "")}${d.id.toLowerCase()}.atlas.localhost:${port}`;
          await pool.query(
            "INSERT INTO hub_cloud_simulator_routes(origin,role,logical_id,state,job_id) VALUES($1,$2,$3,'prepared',$4) ON CONFLICT(origin) DO NOTHING",
            [origin, r.role, r.logicalId, body.jobId],
          );
          items.push({ key: r.key, origin, ...(nodeId ? { nodeId } : {}) });
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ items }));
        return true;
      }
      if (!Array.isArray(body.items)) throw Error("Items required");
      if (action === "install") {
        for (const item of body.items) {
          if (item.resource.role === "frontend")
            await privateCall("/api/internal/hub/branches", {
              origin: item.origin,
              id: item.branchId,
              secret: item.branchSecret,
              generation: item.generation,
            });
          const target = new URL(item.origin);
          const path =
            item.resource.role === "frontend"
              ? "/api/hub/state"
              : item.resource.role === "hub"
                ? "/health/ready"
                : "/health";
          let probe = await fetch(target.origin + path, {
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (item.resource.role === "node") {
            // Public node /health is intentionally available; identity probes with
            // its private credential occur inside the revision-checked cutover API.
            if (probe.status === 404)
              probe = await fetch(target.origin + "/node/health", {
                headers: {
                  authorization:
                    "Bearer " +
                    JSON.parse(
                      readFileSync(
                        join(
                          dirname(process.env.ATLAS_LAB_STATE),
                          "nodes.json",
                        ),
                        "utf8",
                      ),
                    ).find((n) => n.id === item.nodeId).token,
                },
                redirect: "error",
              });
          }
          if (!probe.ok) throw Error("Endpoint health probe failed.");
          if (item.resource.role === "frontend") {
            const state = await probe.json();
            if (!state.enabled || state.branchAvailable === false)
              throw Error("Branch registration probe failed.");
          }
        }
        response.setHeader("content-type", "application/json");
        response.end('{"ok":true}');
        return true;
      }
      if (action === "commit") {
        const snapshot = await controlState();
        const mutation = { generation: snapshot.generation + 1, nodes: [] };
        let newHub = await currentHub();
        for (const item of body.items) {
          if (item.resource.role === "hub") {
            newHub = item.origin;
            if (snapshot.hubOrigin !== item.origin) {
              mutation.hubOrigin = item.origin;
              mutation.previousHubOrigin = snapshot.hubOrigin;
            }
          }
          if (item.resource.role === "node") {
            const previous = snapshot.nodes.find((n) => n.id === item.nodeId);
            if (!previous) throw Error("Node identity unavailable.");
            if (previous.endpoint !== item.origin)
              mutation.nodes.push({
                id: item.nodeId,
                previousEndpoint: previous.endpoint,
                endpoint: item.origin,
              });
          }
        }
        if (mutation.hubOrigin || mutation.nodes.length)
          await privateCall("/api/internal/hub/endpoints", mutation);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const item of body.items) {
            await client.query(
              "UPDATE hub_cloud_simulator_routes SET state='active',revision=$2,updated_at=now() WHERE origin=$1",
              [item.origin, item.generation],
            );
            if (item.resource.previous)
              await client.query(
                "INSERT INTO hub_cloud_simulator_routes(origin,role,logical_id,target_origin,state,revision,job_id) VALUES($1,$2,$3,$4,'transition',$5,$6) ON CONFLICT(origin) DO UPDATE SET target_origin=excluded.target_origin,state='transition',revision=excluded.revision,updated_at=now()",
                [
                  item.resource.previous.url,
                  item.resource.role,
                  item.resource.logicalId,
                  item.origin,
                  item.generation,
                  body.jobId,
                ],
              );
          }
          await client.query(
            "INSERT INTO app_settings(key,value) VALUES('hub_current_origin',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [JSON.stringify(newHub)],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        response.setHeader("content-type", "application/json");
        response.end('{"ok":true}');
        return true;
      }
      throw Error("Unknown operation");
    } catch (error) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "SIMULATION_CONTROL_FAILED" }));
      console.error("Local cloud simulation control failed:", error.message);
      return true;
    }
  }
  return { handle, routes, currentHub, close: () => pool.end() };
}
