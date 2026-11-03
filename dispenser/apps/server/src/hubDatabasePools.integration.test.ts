import Fastify from "fastify";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  createHubDatabasePools,
  closeHubDatabasePools,
  verifyHubDatabaseHeadroom,
  HUB_DATABASE_POOL_BUDGET,
} from "./hubDatabasePools.js";
import { installHubListenMultiplexer } from "./hubListenMultiplexer.js";
import {
  createProfileWriterEventBus,
  publishProfileWritersChanged,
} from "./hubProfileEvents.js";
import { supportEventBus, publishSupportChanged } from "./hubSupportEvents.js";
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
run(
  "Reserved Hub database pools and shared LISTEN — isolated PostgreSQL",
  () => {
    it("reserves4/6/2/1/1 and keeps control SQL available with both bulk slots occupied", async () => {
      if (
        !["127.0.0.1", "localhost"].includes(new URL(url!).hostname) ||
        !new URL(url!).pathname.endsWith("_test")
      )
        throw Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
      const pools = createHubDatabasePools(url!);
      try {
        expect(
          Object.fromEntries(
            Object.entries(pools).map(([key, p]) => [key, p.options.max]),
          ),
        ).toEqual(HUB_DATABASE_POOL_BUDGET);
        const headroom = await verifyHubDatabaseHeadroom(pools);
        expect(headroom.budget).toBe(14);
        expect(headroom.remaining).toBeGreaterThanOrEqual(13 + headroom.margin);
        const one = await pools.bulk.connect(),
          two = await pools.bulk.connect();
        try {
          const start = performance.now();
          expect(
            (await pools.control.query("SELECT 42 answer")).rows[0].answer,
          ).toBe(42);
          expect(performance.now() - start).toBeLessThan(500);
        } finally {
          one.release();
          two.release();
        }
        console.info("POOL_RESERVATION_PROOF", JSON.stringify(headroom));
      } finally {
        await closeHubDatabasePools(pools);
      }
    });
    it("fails activation when PostgreSQL headroom cannot cover the reserved process budget", async () => {
      const pools = createHubDatabasePools(url!);
      try {
        pools.ordinary.query = (async () => ({
          rows: [{ maximum: 15, reserved: 3, reserved_roles: 0, active: 2 }],
        })) as any;
        await expect(verifyHubDatabaseHeadroom(pools)).rejects.toThrow(
          "HUB_DATABASE_CONNECTION_HEADROOM_REQUIRED",
        );
      } finally {
        await closeHubDatabasePools(pools);
      }
    });
    it("uses one reserved LISTEN connection for support and profile channels, with commit-only delivery", async () => {
      const pools = createHubDatabasePools(url!),
        app = Fastify(),
        recipient = {
          profileId: randomUUID(),
          sessionId: randomUUID(),
          contextId: "context-fixture-123456",
        },
        user = randomUUID(),
        events: string[] = [];
      installHubListenMultiplexer(app, pools.listen);
      const profileBus = createProfileWriterEventBus(app, pools.bulk);
      const detach = await profileBus.listen(recipient, (e) =>
          events.push(e.type),
        ),
        supportBus = await supportEventBus(app, pools.ordinary),
        off = supportBus.listen(user, (e) => events.push(e.type));
      await app.ready();
      try {
        expect(pools.listen.totalCount).toBe(1);
        expect(pools.bulk.totalCount).toBe(0);
        expect(pools.ordinary.totalCount).toBe(0);
        events.length = 0;
        const c = await pools.control.connect();
        try {
          await c.query("BEGIN");
          await publishProfileWritersChanged(c, recipient);
          await publishSupportChanged(c, user, 1);
          await delay(25);
          expect(events).toEqual([]);
          await c.query("COMMIT");
        } finally {
          c.release();
        }
        for (
          let i = 0;
          i < 30 && events.filter((e) => e.endsWith("changed")).length < 2;
          i++
        )
          await delay(10);
        expect(events.filter((e) => e.endsWith("changed")).sort()).toEqual([
          "profile.writers.changed",
          "support.changed",
        ]);
        expect(pools.listen.totalCount).toBe(1);
      } finally {
        detach();
        off();
        await app.close();
        await closeHubDatabasePools(pools);
      }
    });
  },
);
