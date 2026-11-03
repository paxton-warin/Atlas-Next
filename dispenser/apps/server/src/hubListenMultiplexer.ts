/** One reserved LISTEN connection multiplexes all Hub invalidation channels. */
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient, Notification } from "pg";
import { acquireHubClient } from "./hubDatabaseWork.js";
type Handler = { event: (payload: string) => void; resync: () => void };
const channels = [
  "atlas_hub_profile_writers_v1",
  "atlas_hub_support_v1",
] as const;
export type HubListenMultiplexer = {
  subscribe: (
    channel: (typeof channels)[number],
    handler: Handler,
  ) => Promise<() => void>;
};
const registered = new WeakMap<FastifyInstance, HubListenMultiplexer>();
export const hubListenMultiplexerFor = (app: FastifyInstance) =>
  registered.get(app);
export function installHubListenMultiplexer(
  app: FastifyInstance,
  pool: Pool,
): HubListenMultiplexer {
  if (registered.has(app))
    throw Error("Hub LISTEN multiplexer already installed");
  const handlers = new Map<string, Set<Handler>>(
    channels.map((c) => [c, new Set()]),
  );
  let client: PoolClient | undefined,
    connecting: Promise<void> | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const resync = () => {
    for (const set of handlers.values())
      for (const h of set) {
        try {
          h.resync();
        } catch {}
      }
  };
  const schedule = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch(schedule);
    }, 1000);
    retry.unref();
  };
  const failed = (value: PoolClient) => {
    if (client !== value) return;
    client = undefined;
    value.removeAllListeners("notification");
    value.removeAllListeners("end");
    try {
      value.release(true);
    } catch {}
    resync();
    schedule();
  };
  function connect(): Promise<void> {
    if (closed) return Promise.reject(Error("Hub event bus closed"));
    if (client) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      const control = new AbortController(),
        timer = setTimeout(() => control.abort(), 1000);
      let value: PoolClient;
      try {
        value = await acquireHubClient(pool, control.signal, 1000);
      } finally {
        clearTimeout(timer);
      }
      if (closed) {
        value.release(true);
        return;
      }
      client = value;
      value.on("notification", (n: Notification) => {
        if (!n.channel || !n.payload) return;
        for (const h of handlers.get(n.channel) || []) {
          try {
            h.event(n.payload);
          } catch {}
        }
      });
      value.on("error", () => failed(value));
      value.on("end", () => failed(value));
      try {
        await value.query(
          "LISTEN atlas_hub_profile_writers_v1; LISTEN atlas_hub_support_v1",
        );
        resync();
      } catch (error) {
        failed(value);
        throw error;
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  const mux: HubListenMultiplexer = {
    async subscribe(channel, handler) {
      if (closed) throw Error("Hub event bus closed");
      const set = handlers.get(channel);
      if (!set) throw Error("Unknown Hub notification channel");
      set.add(handler);
      try {
        await connect();
        return () => set.delete(handler);
      } catch (error) {
        set.delete(handler);
        throw error;
      }
    },
  };
  registered.set(app, mux);
  app.addHook("onClose", async () => {
    closed = true;
    if (retry) clearTimeout(retry);
    const value = client;
    client = undefined;
    if (value) {
      value.removeAllListeners("notification");
      value.removeAllListeners("end");
      value.release(true);
    }
    for (const set of handlers.values()) set.clear();
    if (connecting) await connecting.catch(() => {});
    registered.delete(app);
  });
  return mux;
}
