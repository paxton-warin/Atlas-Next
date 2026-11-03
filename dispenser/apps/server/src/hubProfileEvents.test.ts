import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createProfileWriterEventBus,
  publishProfileWritersChanged,
} from "./hubProfileEvents.js";

const recipient = () => ({
  profileId: randomUUID(),
  sessionId: randomUUID(),
  contextId: randomUUID(),
});
const client = (listen = async () => undefined) =>
  Object.assign(new EventEmitter(), {
    query: vi.fn(listen),
    release: vi.fn(),
  });
describe("Profile writer event lifecycle", () => {
  it("does not permanently cache an initial acquisition failure", async () => {
    const app = Fastify(),
      c = client();
    const pool = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(Error("database down"))
        .mockResolvedValue(c),
    };
    const bus = createProfileWriterEventBus(app, pool as any),
      r = recipient();
    try {
      await expect(bus.listen(r, () => undefined)).rejects.toThrow(
        "database down",
      );
      const events: any[] = [],
        detach = await bus.listen(r, (event) => events.push(event));
      expect(events).toContainEqual({ type: "profile.writers.resync" });
      expect(pool.connect).toHaveBeenCalledTimes(2);
      detach();
    } finally {
      await app.close();
    }
    expect(c.release).toHaveBeenCalledWith(true);
  });
  it("subscribes before LISTEN and never exposes metadata in invalidation hints", async () => {
    const app = Fastify(),
      r = recipient(),
      events: any[] = [];
    let c: ReturnType<typeof client>;
    c = client(async () => {
      c.emit("notification", {
        channel: "atlas_hub_profile_writers_v1",
        payload: JSON.stringify(r),
      });
    });
    const bus = createProfileWriterEventBus(app, {
      connect: async () => c,
    } as any);
    try {
      const detach = await bus.listen(r, (event) => events.push(event));
      expect(events).toEqual([
        { type: "profile.writers.changed" },
        { type: "profile.writers.resync" },
      ]);
      detach();
      c.emit("notification", {
        channel: "atlas_hub_profile_writers_v1",
        payload: JSON.stringify(r),
      });
      expect(events).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
  it("cancels one subscriber promptly without cancelling a shared connection attempt", async () => {
    const app = Fastify(),
      c = client();
    let acquired!: (value: typeof c) => void;
    const bus = createProfileWriterEventBus(app, {
      connect: () =>
        new Promise((r) => {
          acquired = r;
        }),
    } as any);
    const abort = new AbortController();
    try {
      const cancelled = bus.listen(
        recipient(),
        () => {
          throw Error("Detached subscriber was invoked");
        },
        abort.signal,
      );
      const connected = bus.listen(recipient(), () => undefined);
      abort.abort();
      await expect(cancelled).rejects.toThrow("subscription cancelled");
      acquired(c);
      const detach = await connected;
      detach();
      expect(c.release).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("times out stalled pool acquisition, releases its late result, and allows a fresh attempt", async () => {
    const app = Fastify(),
      late = client(),
      next = client();
    let acquired!: (value: typeof late) => void;
    const pool = {
      connect: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((r) => {
              acquired = r;
            }),
        )
        .mockResolvedValue(next),
    };
    const bus = createProfileWriterEventBus(app, pool as any, {
      connectionTimeoutMs: 20,
    });
    try {
      await expect(bus.listen(recipient(), () => undefined)).rejects.toThrow(
        "connection timed out",
      );
      acquired(late);
      await Promise.resolve();
      await Promise.resolve();
      expect(late.release).toHaveBeenCalledTimes(1);
      expect(late.query).not.toHaveBeenCalled();
      const detach = await bus.listen(recipient(), () => undefined);
      detach();
      expect(next.query).toHaveBeenCalledWith(
        "LISTEN atlas_hub_profile_writers_v1",
      );
    } finally {
      await app.close();
    }
  });
  it("times out stalled LISTEN without hanging application shutdown", async () => {
    const app = Fastify(),
      c = client(() => new Promise(() => undefined));
    const bus = createProfileWriterEventBus(
      app,
      { connect: async () => c } as any,
      { connectionTimeoutMs: 20 },
    );
    await expect(bus.listen(recipient(), () => undefined)).rejects.toThrow(
      "LISTEN timed out",
    );
    expect(c.release).toHaveBeenCalledWith(true);
    await app.close();
  });
  it("rejects invalid internal recipient fields before issuing a NOTIFY", async () => {
    const c = { query: vi.fn() },
      r = recipient();
    await expect(
      publishProfileWritersChanged(c as any, { ...r, sessionId: "foreign" }),
    ).rejects.toThrow("Invalid internal");
    expect(c.query).not.toHaveBeenCalled();
  });
});
