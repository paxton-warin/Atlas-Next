import { registerHubAtlasControlRoutes } from "./hubAtlasControl.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { Pool } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { registerHubSupportRoutes } from "./hubSupport.js";
import {
  registerHubMetricsRoutes,
  sampleHubMetrics,
  downsampleHubMetrics,
} from "./hubMetrics.js";
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("Hub support ownership, durable replies and verified metrics", () => {
  const schema = "hub_" + randomUUID().replaceAll("-", "");
  const user = randomUUID(),
    other = randomUUID(),
    admin = randomUUID();
  let pool: Pool, maintenance: Pool;
  const app = Fastify();
  let ticket: string;
  let presence: any = null,
    controls: any;
  const adminSession = randomUUID();
  const headers = (id = user) => ({ "x-test-user": id, "x-test-csrf": "yes" });
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith("_test"))
      throw Error("Dedicated test DB required");
    maintenance = new Pool({ connectionString: url });
    await maintenance.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: url,
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
    const requireUser = async (r: any) => {
      if (![user, other, admin].includes(r.headers["x-test-user"]))
        throw Object.assign(Error("Unauthorized"), { statusCode: 401 });
      return {
        id: r.headers["x-test-user"],
        sessionId: adminSession,
        role:
          r.headers["x-test-user"] === admin
            ? ("admin" as const)
            : ("user" as const),
      };
    };
    const options = {
      pool,
      requireUser,
      requireAdmin: async (r: any) => {
        const u = await requireUser(r);
        if (u.role !== "admin")
          throw Object.assign(Error("Forbidden"), { statusCode: 403 });
        return u;
      },
      csrf: (r: any) => {
        if (r.headers["x-test-csrf"] !== "yes")
          throw Object.assign(Error("CSRF"), { statusCode: 403 });
      },
      verifyService: (r: any) => r.headers.authorization === "Bearer fixture",
      legacyVerify: async (_s: string, _id: string, token: string) =>
        token === "capability",
    };
    await registerHubSupportRoutes(app, options);
    await registerHubSupportRoutes(app, {
      ...options,
      userPrefix: "/api/hub/branch",
      includeAdmin: false,
    });
    await registerHubMetricsRoutes(app, options);
    controls = await registerHubAtlasControlRoutes(app, {
      ...options,
      coordinatorOrigin: "https://coordinator.example",
      serviceSecret: "control-".repeat(6),
      fetch: async (url, request) => {
        const path = new URL(String(url)).pathname;
        expect(path.startsWith("/api/internal/hub/control")).toBe(true);
        const input = request?.body
          ? JSON.parse(String(request.body))
          : undefined;
        if (path.endsWith("/challenge")) {
          expect(input.administrator).toEqual({
            userId: admin,
            sessionId: adminSession,
          });
          return new Response(
            JSON.stringify({
              challengeId: "fixture-challenge",
              expiresIn: 120,
            }),
          );
        }
        if (path.endsWith("/legacy-ticket")) {
          if (input.token !== "real-fixture-capability")
            return new Response("{}", { status: 403 });
          return new Response(
            JSON.stringify({
              source: "atlas",
              id: "012345abcdef",
              subject: "Verified legacy ticket",
              messages: [
                { id: "1", author: "user", body: "Legacy body fixture" },
              ],
            }),
          );
        }
        if (request?.method === "POST") {
          expect(input.administrator).toEqual({
            userId: admin,
            sessionId: adminSession,
          });
          expect(input.challengeId).toBe("fixture-challenge");
          expect(input.password).toBe("fixture-password");
          expect(input.code).toBe("123456");
        }
        expect((request?.headers as any).authorization).toBe(
          "Bearer " + "control-".repeat(6),
        );
        return new Response(
          JSON.stringify({
            mutationsEnabled: false,
            accountPresence: presence,
            name: "Fixture Atlas",
            catalog: [],
            nodes: [
              {
                id: "local",
                name: "Main",
                system: {
                  observedAt: new Date().toISOString(),
                  metrics: { heap_used_bytes: 1234 },
                },
              },
              ...(presence?.sources
                ?.filter((s: any) => s.nodeId !== "local")
                .map((s: any) => ({ id: s.nodeId, name: "Traffic node" })) ||
                []),
            ],
          }),
        );
      },
    });
    await app.ready();
  });
  beforeEach(async () => {
    presence = null;
    await pool.query("TRUNCATE hub_tickets CASCADE");
    await pool.query("TRUNCATE hub_metric_points,hub_metric_sources");
    const r = await app.inject({
      method: "POST",
      url: "/api/hub/tickets",
      headers: headers(),
      payload: {
        subject: "Help with browser",
        body: "Fixture issue details",
        category: "Other",
      },
    });
    expect(r.statusCode).toBe(200);
    ticket = r.json().ticket.id;
  });
  afterAll(async () => {
    await app.close();
    await pool?.end();
    await maintenance?.query(`DROP SCHEMA ${schema} CASCADE`);
    await maintenance?.end();
  });
  it("requires authentication and isolates ticket ownership", async () => {
    expect((await app.inject("/api/hub/tickets")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/hub/tickets/" + ticket,
          headers: headers(other),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/api/admin/hub/tickets", headers: headers() }))
        .statusCode,
    ).toBe(403);
  });
  it("persists public reply notification and monotonic read cursor", async () => {
    const reply = await app.inject({
      method: "POST",
      url: `/api/admin/hub/tickets/${ticket}/messages`,
      headers: headers(admin),
      payload: { body: "Public response" },
    });
    expect(reply.statusCode).toBe(200);
    const id = reply.json().message.id;
    expect(
      (
        await app.inject({ url: "/api/hub/notifications", headers: headers() })
      ).json().unread,
    ).toBe(1);
    expect(
      (
        await app.inject({
          url: "/api/hub/notifications",
          headers: headers(other),
        })
      ).json().unread,
    ).toBe(0);
    for (const cursor of [id, 0])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/hub/tickets/${ticket}/read`,
            headers: headers(),
            payload: { messageId: cursor },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await app.inject({ url: "/api/hub/notifications", headers: headers() })
      ).json().unread,
    ).toBe(0);
    expect(
      Number(
        (await pool.query("SELECT message_id FROM hub_ticket_reads")).rows[0]
          .message_id,
      ),
    ).toBe(Number(id));
  });
  it("never exposes internal notes or generates their notifications", async () => {
    await app.inject({
      method: "POST",
      url: `/api/admin/hub/tickets/${ticket}/messages`,
      headers: headers(admin),
      payload: { body: "Private admin note", public: false },
    });
    expect(
      (
        await app.inject({ url: "/api/hub/notifications", headers: headers() })
      ).json().unread,
    ).toBe(0);
    expect(
      (
        await app.inject({
          url: `/api/hub/tickets/${ticket}`,
          headers: headers(),
        })
      ).body,
    ).not.toContain("Private admin note");
    expect(
      (
        await app.inject({
          url: `/api/admin/hub/tickets/${ticket}`,
          headers: headers(admin),
        })
      ).body,
    ).toContain("Private admin note");
  });
  it("rolls back public reply when notification insertion fails", async () => {
    await pool.query(
      "CREATE FUNCTION reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_notification BEFORE INSERT ON hub_notifications FOR EACH ROW EXECUTE FUNCTION reject_notification()",
    );
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/hub/tickets/${ticket}/messages`,
            headers: headers(admin),
            payload: { body: "Must roll back" },
          })
        ).statusCode,
      ).toBe(500);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_ticket_messages WHERE author='admin'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER reject_notification ON hub_notifications");
      await pool.query("DROP FUNCTION reject_notification()");
    }
  });
  it("imports idempotently and claims only with legacy proof", async () => {
    const input = {
      source: "legacy",
      id: "abc",
      subject: "Old ticket",
      messages: [{ id: "1", body: "Historical message", author: "admin" }],
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/hub/internal/legacy-tickets",
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/hub/internal/legacy-tickets",
            headers: { authorization: "Bearer fixture" },
            payload: input,
          })
        ).statusCode,
      ).toBe(200);
    for (const [token, status] of [
      ["bad", 403],
      ["capability", 200],
    ] as const)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/hub/legacy-tickets/claim",
            headers: headers(),
            payload: { source: "legacy", id: "abc", token },
          })
        ).statusCode,
      ).toBe(status);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/hub/legacy-tickets/claim",
          headers: headers(other),
          payload: { source: "legacy", id: "abc", token: "capability" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM hub_ticket_messages WHERE legacy_message_id IS NOT NULL",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("uses verified account deduplication, not browser claims", async () => {
    expect((await sampleHubMetrics(pool)).onlineUsers).toBeNull();
    for (const sourceId of ["node2", "node3"]) {
      const payload = {
        sourceId,
        observedAt: new Date().toISOString(),
        accountIds: [user, user],
        complete: true,
        metrics: { host_memory_used_bytes: 1024 },
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/hub/internal/metrics",
            headers: headers(),
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/hub/internal/metrics",
            headers: { authorization: "Bearer fixture" },
            payload,
          })
        ).statusCode,
      ).toBe(200);
    }
    expect((await sampleHubMetrics(pool)).onlineUsers).toBe(1);
    await pool.query(
      "UPDATE hub_metric_sources SET observed_at=now()-interval '46 seconds'",
    );
    expect((await sampleHubMetrics(pool)).onlineUsers).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM hub_metric_points WHERE scope='fleet' AND metric='online_users'",
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
  });
  it("downsamples weighted values without losing peaks", async () => {
    await pool.query(
      "INSERT INTO hub_metric_points VALUES(date_trunc('hour',now()-interval '8 days'),15,'fleet','online_users',10,10,10,1),(date_trunc('hour',now()-interval '8 days')+interval '15 seconds',15,'fleet','online_users',30,30,30,1)",
    );
    await downsampleHubMetrics(pool);
    const r = (await pool.query("SELECT * FROM hub_metric_points")).rows;
    expect(r).toHaveLength(1);
    expect(r[0].resolution).toBe(300);
    expect(r[0].value).toBe(20);
    expect(r[0].maximum).toBe(30);
    expect(Number(r[0].samples)).toBe(2);
  });
  it("imports genuine resource telemetry without inventing account concurrency", async () => {
    expect(
      (await app.inject({ url: "/api/admin/hub/atlas", headers: headers() }))
        .statusCode,
    ).toBe(403);
    const r = await app.inject({
      url: "/api/admin/hub/atlas",
      headers: headers(admin),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().mutationsEnabled).toBe(false);
    const m = await sampleHubMetrics(pool);
    expect(m.onlineUsers).toBeNull();
    expect(m.sources[0].onlineUsers).toBeNull();
    expect(m.sources[0].metrics.heap_used_bytes).toBe(1234);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/hub/atlas/command",
          headers: headers(admin),
          payload: { operation: "shell.exec", input: {} },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("branch support uses the same account-owned conversations and notification read cursors", async () => {
    const read = await app.inject({
      url: "/api/hub/branch/tickets/" + ticket,
      headers: headers(),
    });
    expect(read.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/hub/branch/tickets/" + ticket,
          headers: headers(other),
        })
      ).statusCode,
    ).toBe(404);
    await app.inject({
      method: "POST",
      url: "/api/admin/hub/tickets/" + ticket + "/messages",
      headers: headers(admin),
      payload: { body: "A public reply for the branch" },
    });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            url: "/api/hub/branch/notifications",
            headers: headers(),
          })
        ).json().unread,
      ).toBe(1);
    const messages = (
      await app.inject({
        url: "/api/hub/branch/tickets/" + ticket,
        headers: headers(),
      })
    ).json().messages;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/hub/branch/tickets/" + ticket + "/read",
          headers: headers(),
          payload: { messageId: messages.at(-1).id },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/hub/branch/notifications",
          headers: headers(),
        })
      ).json().unread,
    ).toBe(0);
  });
  it("corroborated coordinator presence deduplicates accounts across traffic nodes and persists history", async () => {
    await pool.query(
      "INSERT INTO hub_metric_sources(id,observed_at,account_ids,payload,presence_verified,complete) VALUES('atlas_presence_local',now(),$1,'{}',true,true)",
      [[other]],
    );
    presence = {
      sources: ["local", "node2"].map((nodeId) => ({
        nodeId,
        accountIds: [user],
        complete: true,
        observedAt: new Date().toISOString(),
      })),
    };
    expect(
      (
        await app.inject({
          url: "/api/admin/hub/atlas",
          headers: headers(admin),
        })
      ).statusCode,
    ).toBe(200);
    const metrics = await sampleHubMetrics(pool);
    expect(metrics.onlineUsers).toBe(1);
    expect(metrics.complete).toBe(true);
    expect(metrics.sources.map((source) => source.id).sort()).toEqual([
      "atlas_local",
      "atlas_node2",
    ]);
    expect(
      metrics.sources.find((source) => source.id === "atlas_local")?.metrics
        .heap_used_bytes,
    ).toBe(1234);
    expect(controls.sourceLabel("atlas_local")).toBe("Main");
    expect(controls.sourceLabel("atlas_node2")).toBe("Traffic node");
    expect(
      (
        await pool.query(
          "SELECT value FROM hub_metric_points WHERE scope='fleet' AND metric='online_users'",
        )
      ).rows[0].value,
    ).toBe(1);
    presence.sources[1].accountIds = null;
    presence.sources[1].complete = false;
    for (const source of presence.sources)
      source.observedAt = new Date(Date.now() + 1).toISOString();
    await new Promise((r) => setTimeout(r, 2));
    await app.inject({ url: "/api/admin/hub/atlas", headers: headers(admin) });
    expect((await sampleHubMetrics(pool)).complete).toBe(false);
  });
  it("central MFA gateway binds operation to the authenticated admin session and verifies real legacy capability before importing", async () => {
    const payload = {
      operation: "site.update",
      input: { name: "Changed" },
      administrator: { userId: other, sessionId: other },
    };
    const challenge = await app.inject({
      method: "POST",
      url: "/api/admin/hub/atlas/challenge",
      headers: headers(admin),
      payload,
    });
    expect(challenge.statusCode).toBe(200);
    const applied = await app.inject({
      method: "POST",
      url: "/api/admin/hub/atlas/command",
      headers: headers(admin),
      payload: {
        ...payload,
        challengeId: challenge.json().challengeId,
        password: "fixture-password",
        code: "123456",
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(
      await controls.verifyLegacy("atlas", "012345abcdef", "guessed"),
    ).toBe(false);
    expect(
      await controls.verifyLegacy(
        "atlas",
        "012345abcdef",
        "real-fixture-capability",
      ),
    ).toBe(true);
    expect(
      await controls.verifyLegacy(
        "atlas",
        "012345abcdef",
        "real-fixture-capability",
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM hub_ticket_messages WHERE legacy_message_id='1'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
