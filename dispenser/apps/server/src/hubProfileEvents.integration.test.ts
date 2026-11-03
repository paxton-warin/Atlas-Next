import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import type { HubSession } from "./hubIdentity.js";
import {
  publishProfileWritersChanged,
  registerProfileWriterEventRoute,
} from "./hubProfileEvents.js";

const database = process.env.TEST_DATABASE_URL;
const suite = database ? describe : describe.skip;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw Error("Expected profile event did not arrive.");
    await delay(10);
  }
}
async function stream(origin: string, token: string, path = "/events") {
  const abort = new AbortController();
  const response = await fetch(origin + path, {
    headers: { "x-test-grant": token },
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
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      ended = true;
    }
  })();
  await until(() => text.includes('"profile.writers.resync"'));
  return {
    text: () => text,
    ended: () => ended,
    count: (type: string) => text.split('"' + type + '"').length - 1,
    async close() {
      abort.abort();
      await reading;
    },
  };
}

suite(
  "Profile writer SSE provides authorized transactional wakeups with durable resync",
  () => {
    const appName = "profile-events-" + randomUUID();
    const app = Fastify(),
      peer = Fastify();
    const revoked = new Set<string>();
    const profileId = randomUUID(),
      otherProfile = randomUUID(),
      contextId = randomUUID();
    const grant = (
      profileId: string,
      contextId = randomUUID(),
    ): HubSession => ({
      protocol: 1,
      userId: randomUUID(),
      profileId,
      branchId: randomUUID(),
      sessionId: randomUUID(),
      contextId,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    });
    const grants: Record<string, HubSession> = {
      owner: grant(profileId, contextId),
      requester: grant(profileId),
      sameContextNewSession: grant(profileId, contextId),
      foreign: grant(otherProfile),
    };
    let pool: Pool,
      peerPool: Pool,
      maintenance: Pool,
      origin: string,
      peerOrigin: string;
    const authenticate = async (req: any) => {
      const token = req.headers["x-test-grant"] as string;
      if (!grants[token] || revoked.has(token))
        throw new AppError("HUB_SESSION_EXPIRED", "Signed out.", 401);
      return grants[token]!;
    };
    beforeAll(async () => {
      if (!new URL(database!).pathname.endsWith("_test"))
        throw Error("Dedicated test database required");
      maintenance = new Pool({ connectionString: database });
      pool = new Pool({
        connectionString: database,
        application_name: appName,
        connectionTimeoutMillis: 1000,
      });
      peerPool = new Pool({
        connectionString: database,
        application_name: appName + "-peer",
        connectionTimeoutMillis: 1000,
      });
      registerProfileWriterEventRoute(app, pool, authenticate, {
        path: "/events",
        heartbeatMs: 40,
      });
      registerProfileWriterEventRoute(peer, peerPool, authenticate, {
        path: "/events",
        heartbeatMs: 40,
        lifetimeMs: 600,
      });
      origin = await app.listen({ host: "127.0.0.1", port: 0 });
      peerOrigin = await peer.listen({ host: "127.0.0.1", port: 0 });
    });
    afterAll(async () => {
      await app.close();
      await peer.close();
      await pool?.end();
      await peerPool?.end();
      await maintenance?.end();
    });
    it("denies unsigned/query streams and closes established streams after revocation", async () => {
      expect((await fetch(origin + "/events")).status).toBe(401);
      expect(
        (
          await fetch(origin + "/events?profileId=" + profileId, {
            headers: { "x-test-grant": "owner" },
          })
        ).status,
      ).toBe(404);
      const s = await stream(origin, "owner");
      try {
        revoked.add("owner");
        await until(() => s.ended());
        expect(s.text()).toContain("event: authorization");
        expect(s.text()).not.toContain(profileId);
      } finally {
        revoked.delete("owner");
        await s.close();
      }
    });
    it("emits type-only hints after COMMIT across processes, not ROLLBACK or matching-context/foreign grants", async () => {
      const owner = await stream(origin, "owner"),
        remote = await stream(peerOrigin, "owner");
      const sameContext = await stream(origin, "sameContextNewSession"),
        requester = await stream(origin, "requester"),
        foreign = await stream(origin, "foreign");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await publishProfileWritersChanged(c, grants.owner!);
        await delay(50);
        expect(owner.count("profile.writers.changed")).toBe(0);
        expect(remote.count("profile.writers.changed")).toBe(0);
        await c.query("ROLLBACK");
        await delay(50);
        expect(owner.count("profile.writers.changed")).toBe(0);
        await c.query("BEGIN");
        await publishProfileWritersChanged(c, grants.owner!);
        await c.query("COMMIT");
        await until(
          () =>
            owner.count("profile.writers.changed") === 1 &&
            remote.count("profile.writers.changed") === 1,
        );
        for (const s of [sameContext, requester, foreign])
          expect(s.count("profile.writers.changed")).toBe(0);
        for (const s of [owner, remote]) {
          expect(s.text()).toContain(
            'event: profile\ndata: {"type":"profile.writers.changed"}',
          );
          for (const secret of [
            profileId,
            contextId,
            grants.owner!.sessionId,
            grants.owner!.userId,
          ])
            expect(s.text()).not.toContain(secret);
        }
      } finally {
        await c.query("ROLLBACK");
        c.release();
        await Promise.all(
          [owner, remote, sameContext, requester, foreign].map((s) =>
            s.close(),
          ),
        );
      }
    });
    it("initial resync and reconnect recover changes missed before subscribe or after bounded EOF", async () => {
      const c = await pool.connect();
      try {
        await publishProfileWritersChanged(c, grants.requester!);
      } finally {
        c.release();
      }
      const a = await stream(peerOrigin, "requester");
      try {
        expect(a.count("profile.writers.resync")).toBeGreaterThanOrEqual(1);
        await until(() => a.ended());
        const b = await stream(peerOrigin, "requester");
        try {
          expect(b.count("profile.writers.resync")).toBeGreaterThanOrEqual(1);
        } finally {
          await b.close();
        }
      } finally {
        await a.close();
      }
    });
    it("resyncs after its exact LISTEN connection dies, reconnects, then receives later committed hints", async () => {
      const s = await stream(origin, "owner");
      try {
        const before = s.count("profile.writers.resync");
        const connections = await maintenance.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query=$2",
          [appName, "LISTEN atlas_hub_profile_writers_v1"],
        );
        expect(connections.rows).toHaveLength(1);
        await maintenance.query("SELECT pg_terminate_backend($1)", [
          connections.rows[0]!.pid,
        ]);
        await until(() => s.count("profile.writers.resync") > before);
        await until(
          async () =>
            (
              await maintenance.query(
                "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND query=$2",
                [appName, "LISTEN atlas_hub_profile_writers_v1"],
              )
            ).rows[0]!.n === 1,
        );
        const c = await pool.connect();
        try {
          await publishProfileWritersChanged(c, grants.owner!);
        } finally {
          c.release();
        }
        await until(() => s.count("profile.writers.changed") === 1);
        expect(s.ended()).toBe(false);
      } finally {
        await s.close();
      }
    });
    it("bounds concurrent streams per exact grant and frees slots on cancellation", async () => {
      const streams = await Promise.all(
        [1, 2, 3, 4].map(() => stream(origin, "requester")),
      );
      try {
        expect(
          (
            await fetch(origin + "/events", {
              headers: { "x-test-grant": "requester" },
            })
          ).status,
        ).toBe(429);
        await streams[0]!.close();
        await delay(50);
        const replacement = await stream(origin, "requester");
        await replacement.close();
      } finally {
        await Promise.all(streams.map((s) => s.close()));
      }
    });
  },
);
