/** Writer SSE carries invalidation hints only. The authoritative handoff rows,
 * fencing epochs, save receipts and explicit acquire requests remain unchanged.
 * PostgreSQL delivers these narrowly scoped hints only after transaction COMMIT. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Notification, Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";
import type { HubSession } from "./hubIdentity.js";
import { hubListenMultiplexerFor, type HubListenMultiplexer } from "./hubListenMultiplexer.js";

const channel = "atlas_hub_profile_writers_v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const context = /^[A-Za-z0-9_-]{16,96}$/;
export type ProfileWriterRecipient = Pick<
  HubSession,
  "profileId" | "sessionId" | "contextId"
>;
type Change = {
  type: "profile.writers.changed" | "profile.writers.resync";
};
type Listener = (event: Change) => void;
function valid(v: ProfileWriterRecipient) {
  return (
    typeof v.profileId === "string" &&
    uuid.test(v.profileId) &&
    typeof v.sessionId === "string" &&
    uuid.test(v.sessionId) &&
    typeof v.contextId === "string" &&
    context.test(v.contextId)
  );
}
const recipientKey = (v: ProfileWriterRecipient) =>
  JSON.stringify([v.profileId, v.sessionId, v.contextId]);

export async function publishProfileWritersChanged(
  c: PoolClient,
  recipient: ProfileWriterRecipient,
) {
  if (!valid(recipient)) throw Error("Invalid internal profile writer event.");
  await c.query("SELECT pg_notify($1,$2)", [
    channel,
    JSON.stringify(recipient),
  ]);
}

/** A single LISTEN connection per app, shared by all of its profile streams.
 * Subscribers exist before LISTEN becomes active. Every initial/reconnected
 * stream rereads durable state, closing the subscribe-versus-commit race. */
export function createProfileWriterEventBus(
  app: FastifyInstance,
  pool: Pool,
  { connectionTimeoutMs = 5000, retryMs = 1000 } = {},
) {
  const shared = hubListenMultiplexerFor(app);
  if (shared) return sharedProfileWriterBus(app, shared);
  const listeners = new Map<string, Set<Listener>>();
  let client: PoolClient | undefined;
  let connecting: Promise<void> | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const dispatch = (set: Iterable<Listener>, event: Change) => {
    for (const listener of set) {
      try {
        listener(event);
      } catch (error) {
        app.log.warn({ err: error }, "Profile event subscriber failed");
      }
    }
  };
  const resync = () => {
    for (const set of listeners.values())
      dispatch(set, { type: "profile.writers.resync" });
  };
  function schedule() {
    if (closed || retry || !listeners.size) return;
    const delay = Math.min(15000, retryMs * 2 ** Math.min(attempt++, 4));
    retry = setTimeout(() => {
      retry = undefined;
      if (!listeners.size) return;
      void connect().catch((error) => {
        app.log.warn({ err: error }, "Profile event listener reconnect failed");
        schedule();
      });
    }, delay);
    retry.unref();
  }
  async function connect(): Promise<void> {
    if (closed) throw Error("Profile event listener is closed");
    if (connecting) return connecting;
    if (client) return;
    connecting = (async () => {
      let expired = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const acquiring = pool.connect().then((value) => {
        if (expired || closed) {
          value.release();
          throw Error("Profile event listener connection was cancelled");
        }
        return value;
      });
      let value: PoolClient;
      try {
        value = await Promise.race([
          acquiring,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              expired = true;
              reject(Error("Profile event listener connection timed out"));
            }, connectionTimeoutMs);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      client = value;
      const notification = (n: Notification) => {
        if (n.channel !== channel || !n.payload) return;
        try {
          const v = JSON.parse(n.payload) as ProfileWriterRecipient;
          if (!v || !valid(v)) return;
          dispatch(listeners.get(recipientKey(v)) ?? [], {
            type: "profile.writers.changed",
          });
        } catch {
          // Invalid external NOTIFY input contains no durable handoff state.
        }
      };
      const disconnected = () => {
        if (client !== value) return;
        client = undefined;
        value.removeListener("notification", notification);
        value.removeListener("end", disconnected);
        // Keep an error handler attached while this broken connection is
        // destroyed; repeated socket errors must not become uncaught events.
        try {
          value.release(true);
        } catch (error) {
          app.log.warn(
            { err: error },
            "Profile event connection disposal failed",
          );
        }
        resync();
        schedule();
      };
      value.on("notification", notification);
      value.on("error", disconnected);
      value.on("end", disconnected);
      try {
        await Promise.race([
          value.query("LISTEN " + channel),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(Error("Profile event LISTEN timed out")),
              connectionTimeoutMs,
            );
            timeout.unref();
          }),
        ]);
        if (client !== value || closed)
          throw Error("Profile event listener disconnected");
        attempt = 0;
        resync();
      } catch (error) {
        disconnected();
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  app.addHook("onClose", async () => {
    closed = true;
    if (retry) clearTimeout(retry);
    const value = client;
    client = undefined;
    if (value) {
      // This is a dedicated LISTEN socket. Destroying it also cancels an
      // outstanding LISTEN and never returns a subscribed socket to the pool.
      value.release(true);
    }
    listeners.clear();
  });
  return {
    async listen(
      recipient: ProfileWriterRecipient,
      listener: Listener,
      signal?: AbortSignal,
    ) {
      if (!valid(recipient)) throw Error("Invalid profile stream recipient");
      const key = recipientKey(recipient);
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      const detach = () => {
        set!.delete(listener);
        if (!set!.size) listeners.delete(key);
      };
      let aborted: (() => void) | undefined;
      try {
        if (signal?.aborted)
          throw Error("Profile event subscription cancelled");
        await Promise.race([
          connect(),
          new Promise<never>((_resolve, reject) => {
            aborted = () =>
              reject(Error("Profile event subscription cancelled"));
            signal?.addEventListener("abort", aborted, { once: true });
          }),
        ]);
        return detach;
      } catch (error) {
        detach();
        throw error;
      } finally {
        if (aborted) signal?.removeEventListener("abort", aborted);
      }
    },
  };
}

/** Shared production bus; standalone fixtures retain their original independently testable bus. */
function sharedProfileWriterBus(app: FastifyInstance, mux: HubListenMultiplexer) {
  const listeners = new Map<string, Set<Listener>>();
  let connected: Promise<() => void> | undefined;
  const dispatch = (set: Iterable<Listener>, event: Change) => { for (const listener of set) { try { listener(event); } catch {} } };
  app.addHook("onClose", async () => { if (connected) (await connected.catch(() => () => {}))(); listeners.clear(); });
  return { async listen(recipient: ProfileWriterRecipient, listener: Listener, signal?: AbortSignal) {
    if (!valid(recipient) || signal?.aborted) throw Error("Invalid/cancelled profile stream recipient");
    const key = recipientKey(recipient); let set = listeners.get(key); if (!set) listeners.set(key, set = new Set()); set.add(listener);
    const detach = () => { set!.delete(listener); if (!set!.size) listeners.delete(key); };
    connected ??= mux.subscribe(channel, { event: payload => { try { const value=JSON.parse(payload); if(valid(value)) dispatch(listeners.get(recipientKey(value)) || [], {type:"profile.writers.changed"}); } catch {} }, resync: () => { for (const set of listeners.values()) dispatch(set,{type:"profile.writers.resync"}); } }).catch(error => { connected=undefined; throw error; });
    let abort: (()=>void)|undefined;
    try { await Promise.race([connected, new Promise<never>((_,reject)=>{abort=()=>reject(Error("Profile event subscription cancelled"));signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();})]); return detach; }
    catch(error){detach();throw error;} finally{if(abort)signal?.removeEventListener("abort",abort);}
  } };
}

export function registerProfileWriterEventRoute(
  app: FastifyInstance,
  pool: Pool,
  authenticate: (req: FastifyRequest) => Promise<HubSession>,
  {
    path = "/api/hub/branch/profile/events",
    heartbeatMs = 15000,
    lifetimeMs = 120000,
  } = {},
) {
  const bus = createProfileWriterEventBus(app, pool);
  const connections = new Map<string, number>();
  const closers = new Set<() => void>();
  app.get(path, async (req, reply) => {
    if (req.url.includes("?"))
      throw new AppError("HUB_INVALID", "Profile stream not found.", 404);
    const session = await authenticate(req);
    const key = recipientKey(session);
    if ((connections.get(key) ?? 0) >= 4 || closers.size >= 10000)
      throw new AppError("HUB_RATE_LIMITED", "Too many profile streams.", 429);
    connections.set(key, (connections.get(key) ?? 0) + 1);
    const response = reply.raw;
    const waiting = new AbortController();
    let ended = false;
    let started = false;
    let checking = false;
    let detach: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
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
    function close() {
      if (ended) return;
      ended = true;
      waiting.abort();
      detach?.();
      if (timer) clearInterval(timer);
      if (lifetime) clearTimeout(lifetime);
      const remaining = Math.max(0, (connections.get(key) ?? 1) - 1);
      if (remaining) connections.set(key, remaining);
      else connections.delete(key);
      closers.delete(close);
      response.removeListener("close", close);
      if (started) response.end();
    }
    response.once("close", close);
    closers.add(close);
    try {
      detach = await bus.listen(
        session,
        (event) => {
          // LISTEN may deliver a committed event before HTTP headers are sent.
          // Coalesce it into the unconditional initial authoritative reread.
          if (started) send("profile", event);
        },
        waiting.signal,
      );
      if (ended) {
        detach();
        return;
      }
    } catch (error) {
      if (ended) return;
      close();
      app.log.warn({ err: error }, "Profile event listener unavailable");
      throw new AppError(
        "HUB_INVALID",
        "Profile updates are temporarily unavailable.",
        503,
      );
    }
    reply.hijack();
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    response.flushHeaders();
    started = true;
    response.write("retry: 1000\n\n");
    send("ready", { type: "ready" });
    // Always resync, including when no notification was observed. It covers
    // changes committed before LISTEN, process restarts and periodic EOF.
    send("profile", { type: "profile.writers.resync" });
    timer = setInterval(() => {
      if (checking || ended) return;
      checking = true;
      void authenticate(req)
        .then((active) => {
          if (recipientKey(active) !== key)
            throw Error("Changed branch session");
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
    lifetime = setTimeout(close, lifetimeMs);
    lifetime.unref();
  });
  app.addHook("preClose", async () => {
    for (const close of closers) close();
  });
}
