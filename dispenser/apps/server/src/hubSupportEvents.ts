/** PostgreSQL NOTIFY is emitted inside the same transaction as durable support
 * state. SSE is an invalidation hint, never a substitute for authorized reads. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";
import { hubListenMultiplexerFor } from "./hubListenMultiplexer.js";
const channel = "atlas_hub_support_v1";
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
type Change = { type: "support.changed" | "support.resync"; revision?: string };
type Listener = (event: Change) => void;
export async function publishSupportChanged(
  c: PoolClient,
  userId: string,
  revision: string | number,
) {
  if (!uuid.test(userId) || !/^\d{1,30}$/.test(String(revision)))
    throw Error("Invalid internal support event.");
  await c.query("SELECT pg_notify($1,$2)", [
    channel,
    JSON.stringify({ userId, revision: String(revision) }),
  ]);
}
/** One transactional global invalidation; the shared bus fans out only in
 * memory. Durable publications and reads remain in authorized HTTP endpoints. */
export async function publishSupportBroadcast(c: PoolClient, revision: string | number) {
  if (!/^\d{1,30}$/.test(String(revision))) throw Error("Invalid internal support event.");
  await c.query("SELECT pg_notify($1,$2)", [channel, JSON.stringify({ scope: "all", revision: String(revision) })]);
}
const buses = new WeakMap<
  FastifyInstance,
  Promise<{ listen: (user: string, listener: Listener) => () => void }>
>();
export function supportEventBus(app: FastifyInstance, pool: Pool) {
  let ready = buses.get(app);
  if (ready) return ready;
  const mux = hubListenMultiplexerFor(app);
  if (mux) {
    const listeners = new Map<string, Set<Listener>>();
    ready = mux.subscribe(channel, {
      event: payload => { try { const value = JSON.parse(payload); if (!/^\d{1,30}$/.test(String(value.revision))) return;
        if (value.scope === "all") { for(const set of listeners.values()) for(const listener of set) listener({type:"support.changed",revision:String(value.revision)}); }
        else if(uuid.test(value.userId)) for(const listener of listeners.get(value.userId)||[]) listener({type:"support.changed",revision:String(value.revision)});
      } catch {} },
      resync: () => { for(const set of listeners.values()) for(const listener of set) listener({type:"support.resync"}); },
    }).then(detach => { app.addHook("onClose",async()=>{detach();listeners.clear();}); return {listen:(user:string,listener:Listener)=>{let set=listeners.get(user);if(!set)listeners.set(user,set=new Set());set.add(listener);return()=>{set!.delete(listener);if(!set!.size)listeners.delete(user);};}}; });
    buses.set(app,ready); return ready;
  }
  ready = (async () => {
    const listeners = new Map<string, Set<Listener>>();
    let client: PoolClient | undefined,
      closed = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      connecting: Promise<void> | undefined;
    const sync = () => {
      for (const set of listeners.values())
        for (const listener of set) listener({ type: "support.resync" });
    };
    const schedule = () => {
      if (closed || retry) return;
      retry = setTimeout(() => {
        retry = undefined;
        void connect().catch(schedule);
      }, 1000);
      retry.unref();
    };
    function disconnect(value: PoolClient) {
      if (client !== value) return;
      client = undefined;
      value.removeAllListeners("notification");
      value.removeAllListeners("error");
      value.removeAllListeners("end");
      try {
        value.release(true);
      } catch {}
      sync();
      schedule();
    }
    function connect(): Promise<void> {
      if (closed || client) return Promise.resolve();
      if (connecting) return connecting;
      connecting = (async () => {
        const value = await pool.connect();
        if (closed) {
          value.release();
          return;
        }
        client = value;
        value.on("notification", (notification) => {
          if (notification.channel !== channel || !notification.payload) return;
          try {
            const v = JSON.parse(notification.payload);
            if (v.scope === "all" && /^\d{1,30}$/.test(v.revision)) {
              for (const set of listeners.values()) for (const listener of set)
                listener({ type: "support.changed", revision: v.revision });
              return;
            }
            if (!uuid.test(v.userId) || !/^\d{1,30}$/.test(v.revision)) return;
            for (const listener of listeners.get(v.userId) ?? [])
              listener({ type: "support.changed", revision: v.revision });
          } catch {}
        });
        value.on("error", () => disconnect(value));
        value.on("end", () => disconnect(value));
        try {
          await value.query("LISTEN " + channel);
          sync();
        } catch (e) {
          disconnect(value);
          throw e;
        }
      })().finally(() => {
        connecting = undefined;
      });
      return connecting;
    }
    await connect();
    app.addHook("onClose", async () => {
      closed = true;
      if (retry) clearTimeout(retry);
      const value = client;
      client = undefined;
      if (value) {
        value.removeAllListeners("notification");
        value.removeAllListeners("error");
        value.removeAllListeners("end");
        try {
          await value.query("UNLISTEN " + channel);
        } finally {
          value.release();
        }
      }
      listeners.clear();
    });
    return {
      listen: (user: string, listener: Listener) => {
        let set = listeners.get(user);
        if (!set) {
          set = new Set();
          listeners.set(user, set);
        }
        set.add(listener);
        return () => {
          set!.delete(listener);
          if (!set!.size) listeners.delete(user);
        };
      },
    };
  })();
  buses.set(app, ready);
  return ready;
}
/** Every stream rechecks its original authorization periodically. Tokens,
 * account IDs, subjects and message bodies are never included in event frames. */
export async function registerSupportEventRoute(
  app: FastifyInstance,
  pool: Pool,
  path: string,
  authenticate: (req: FastifyRequest) => Promise<{ id: string }>,
  heartbeatMs = 15000,
  lifetimeMs = 120000,
) {
  const bus = await supportEventBus(app, pool),
    connections = new Map<string, number>(),
    closers = new Set<() => void>();
  app.get(path, async (req, reply) => {
    const user = await authenticate(req);
    if ((connections.get(user.id) ?? 0) >= 20 || closers.size >= 10000)
      throw new AppError(
        "HUB_RATE_LIMITED",
        "Too many notification streams.",
        429,
      );
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    response.flushHeaders();
    connections.set(user.id, (connections.get(user.id) ?? 0) + 1);
    let ended = false,
      checking = false;
    const send = (name: string, event: unknown) => {
      if (ended) return;
      if (response.writableLength > 32768) {
        close();
        return;
      }
      response.write(
        "event: " + name + "\ndata: " + JSON.stringify(event) + "\n\n",
      );
    };
    const detach = bus.listen(user.id, (event) => send("support", event));
    function close() {
      if (ended) return;
      ended = true;
      detach();
      clearInterval(timer);
      clearTimeout(lifetime);
      connections.set(
        user.id,
        Math.max(0, (connections.get(user.id) ?? 1) - 1),
      );
      closers.delete(close);
      response.end();
    }
    const timer = setInterval(() => {
      if (checking || ended) return;
      checking = true;
      void authenticate(req)
        .then((active) => {
          if (active.id !== user.id) throw Error("Changed session");
          send("heartbeat", { type: "heartbeat" });
        })
        .catch(() => {
          send("authorization", { type: "signed-out" });
          close();
        })
        .finally(() => {
          checking = false;
        });
    }, heartbeatMs);
    timer.unref();
    // Periodic EOF makes native EventSource reconnect, reauthorize and reread
    // durable state on ready, without depending on every invalidation arriving.
    const lifetime = setTimeout(close, lifetimeMs);
    lifetime.unref();
    closers.add(close);
    response.once("close", close);
    response.write("retry: 1000\n\n");
    send("ready", { type: "ready" });
  });
  app.addHook("preClose", async () => {
    for (const close of closers) close();
  });
}
