import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerHubSupportRoutes } from "./hubSupport.js";
import {
  publishSupportChanged,
  registerSupportEventRoute,
} from "./hubSupportEvents.js";
const database = process.env.TEST_DATABASE_URL;
const suite = database ? describe : describe.skip;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error("Expected support event did not arrive.");
    await delay(10);
  }
}
async function stream(url: string, user: string) {
  const abort = new AbortController();
  const response = await fetch(url, {
    headers: { "x-test-user": user },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let text = "",
    ended = false;
  const reading = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
    } catch {
    } finally {
      ended = true;
    }
  })();
  await until(() => text.includes("event: ready"));
  return {
    text: () => text,
    ended: () => ended,
    async close() {
      abort.abort();
      await reading;
    },
  };
}
suite(
  "Support SSE uses transactional durable hints and authorized account streams",
  () => {
    const schema = "support_events_" + randomUUID().replaceAll("-", "");
    const user = randomUUID(),
      other = randomUUID(),
      admin = randomUUID();
    const app = Fastify(),
      peer = Fastify();
    const revoked = new Set<string>();
    let pool: Pool, maintenance: Pool, origin: string, peerOrigin: string;
    const headers = (id = user) => ({
      "x-test-user": id,
      "x-test-csrf": "yes",
    });
    const authenticate = async (req: any) => {
      const id = req.headers["x-test-user"];
      if (![user, other, admin].includes(id) || revoked.has(id))
        throw Object.assign(Error("Not signed in"), { statusCode: 401 });
      return {
        id,
        role: id === admin ? ("admin" as const) : ("user" as const),
      };
    };
    beforeAll(async () => {
      if (!new URL(database!).pathname.endsWith("_test"))
        throw Error("Dedicated test database required");
      maintenance = new Pool({ connectionString: database });
      await maintenance.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: database,
        options: `-c search_path=${schema},public`,
      });
      await pool.query(
        "CREATE TABLE users(id uuid PRIMARY KEY,email text,status text NOT NULL DEFAULT 'active')",
      );
      await pool.query(
        await readFile(
          new URL(
            "../../../packages/database/migrations/0011_hub_support_metrics.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await pool.query(await readFile(new URL("../../../packages/database/migrations/0023_hub_announcements.sql", import.meta.url), "utf8"));
      await pool.query(await readFile(new URL("../../../packages/database/migrations/0024_hub_support_media.sql", import.meta.url), "utf8"));
      for (const id of [user, other, admin])
        await pool.query("INSERT INTO users(id)VALUES($1)", [id]);
      await registerHubSupportRoutes(app, {
        pool,
        requireUser: authenticate,
        requireAdmin: async (req) => {
          const u = await authenticate(req);
          if (u.role !== "admin")
            throw Object.assign(Error("Forbidden"), { statusCode: 403 });
          return u;
        },
        csrf: (req) => {
          if (req.headers["x-test-csrf"] !== "yes")
            throw Object.assign(Error("CSRF"), { statusCode: 403 });
        },
      });
      await registerSupportEventRoute(
        app,
        pool,
        "/events-fast",
        authenticate,
        40,
      );
      await registerSupportEventRoute(peer, pool, "/events", authenticate, 40);
      await registerSupportEventRoute(
        app,
        pool,
        "/events-expiry",
        authenticate,
        40,
        120,
      );
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      peerOrigin = await peer.listen({ host: "127.0.0.1", port: 0 });
    });
    afterAll(async () => {
      await app.close();
      await peer.close();
      await pool?.end();
      await maintenance?.query(`DROP SCHEMA ${schema} CASCADE`);
      await maintenance?.end();
    });
    it("denies unsigned streams, then rechecks revocation and closes established streams", async () => {
      expect((await fetch(origin + "/events-fast")).status).toBe(401);
      const s = await stream(origin + "/events-fast", other);
      try {
        revoked.add(other);
        await until(() => s.ended());
        expect(s.text()).toContain("event: authorization");
        expect(s.text()).not.toContain(other);
      } finally {
        revoked.delete(other);
        await s.close();
      }
    });
    it("intentionally ends bounded streams for reauthorization and durable recovery", async () => {
      const s = await stream(origin + "/events-expiry", user);
      try {
        await until(() => s.ended());
        expect(s.text()).toContain("retry: 1000");
        expect(s.text()).toContain("event: ready");
        expect(s.text()).not.toContain("event: authorization");
        const next = await stream(origin + "/events-expiry", user);
        await next.close();
      } finally {
        await s.close();
      }
    });
    it("publishes only after COMMIT across server processes, never on ROLLBACK or to a peer account", async () => {
      const local = await stream(origin + "/api/hub/events", user);
      const remote = await stream(peerOrigin + "/events", user);
      const foreign = await stream(peerOrigin + "/events", other);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await publishSupportChanged(c, user, "8001");
        await delay(75);
        expect(local.text()).not.toContain("8001");
        expect(remote.text()).not.toContain("8001");
        await c.query("COMMIT");
        await until(
          () => local.text().includes("8001") && remote.text().includes("8001"),
        );
        expect(foreign.text()).not.toContain("8001");
        expect(remote.text()).not.toContain(user);
        await c.query("BEGIN");
        await publishSupportChanged(c, user, "8002");
        await c.query("ROLLBACK");
        await delay(75);
        expect(remote.text()).not.toContain("8002");
      } finally {
        await c.query("ROLLBACK");
        c.release();
        await Promise.all([local.close(), remote.close(), foreign.close()]);
      }
    });
    it("public replies notify but delivery never marks read; private notes do not notify; cursor read invalidates once", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/hub/tickets",
        headers: headers(),
        payload: {
          subject: "Synthetic request",
          body: "Synthetic support issue",
          category: "Other",
        },
      });
      const ticket = created.json().ticket.id;
      const s = await stream(peerOrigin + "/events", user);
      try {
        const reply = await app.inject({
          method: "POST",
          url: `/api/admin/hub/tickets/${ticket}/messages`,
          headers: headers(admin),
          payload: { body: "PRIVATE-TO-ACCOUNT-REPLY" },
        });
        const revision = reply.json().message.id;
        await until(() => s.text().includes('"revision":"' + revision + '"'));
        expect(s.text()).not.toContain("PRIVATE-TO-ACCOUNT-REPLY");
        expect(
          (
            await app.inject({
              url: "/api/hub/notifications",
              headers: headers(),
            })
          ).json().unread,
        ).toBe(1);
        const before = (s.text().match(/event: support/g) || []).length;
        await app.inject({
          method: "POST",
          url: `/api/admin/hub/tickets/${ticket}/messages`,
          headers: headers(admin),
          payload: { body: "INTERNAL-ONLY", public: false },
        });
        await delay(75);
        expect((s.text().match(/event: support/g) || []).length).toBe(before);
        await app.inject({
          method: "POST",
          url: `/api/hub/tickets/${ticket}/read`,
          headers: headers(),
          payload: { messageId: revision },
        });
        await until(
          () => (s.text().match(/event: support/g) || []).length === before + 1,
        );
        expect(
          (
            await app.inject({
              url: "/api/hub/notifications",
              headers: headers(),
            })
          ).json().unread,
        ).toBe(0);
        await app.inject({
          method: "POST",
          url: `/api/hub/tickets/${ticket}/read`,
          headers: headers(),
          payload: { messageId: revision },
        });
        await delay(75);
        expect((s.text().match(/event: support/g) || []).length).toBe(
          before + 1,
        );
      } finally {
        await s.close();
      }
    });
    it("reconnect ready always rereads durable state rather than trusting a lost event", async () => {
      const s = await stream(origin + "/api/hub/events", user);
      await s.close();
      const created = await app.inject({
        method: "POST",
        url: "/api/hub/tickets",
        headers: headers(),
        payload: {
          subject: "Disconnected request",
          body: "Lost notification fixture",
          category: "Other",
        },
      });
      const ticket = created.json().ticket.id;
      await app.inject({
        method: "POST",
        url: `/api/admin/hub/tickets/${ticket}/messages`,
        headers: headers(admin),
        payload: { body: "Durable while disconnected" },
      });
      const reconnect = await stream(origin + "/api/hub/events", user);
      try {
        expect(reconnect.text()).toContain("event: ready");
        expect(
          (
            await app.inject({
              url: "/api/hub/notifications",
              headers: headers(),
            })
          ).json().unread,
        ).toBe(1);
      } finally {
        await reconnect.close();
      }
    });
  },
);
