/** A transaction never borrows a second pool client. Aborted/timed-out work
 * destroys its own checked-out connection, never unrelated sessions. */
import { performance } from "node:perf_hooks";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";
import { performanceOutcome, type HubPerformance } from "./hubPerformance.js";
export type HubQueryable = Pick<Pool, "query">;
export const HUB_AUTH_DATABASE_LIMITS = Object.freeze({ acquireMs: 3000, transactionMs: 7000, statementMs: 3000, lockMs: 1000, rollbackMs: 1000 });
const aborted = () => new AppError("HUB_REQUEST_ABORTED", "The sign-in request was interrupted. Try signing in again.", 499);
const busy = () => new AppError("HUB_DATABASE_BUSY", "Sign-in is busy. Please retry shortly.", 503);
const timedOut = () => new AppError("HUB_TRANSACTION_TIMEOUT", "Sign-in took too long. Please retry shortly.", 503);

export function acquireHubClient(pool: Pool, signal: AbortSignal, timeoutMs: number = HUB_AUTH_DATABASE_LIMITS.acquireMs): Promise<PoolClient> {
  if (signal.aborted) return Promise.reject(signal.reason || aborted());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, client?: PoolClient) => {
      if (settled) { client?.release(); return; }
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(client!);
    };
    const cancel = () => finish(signal.reason || aborted());
    const timer = setTimeout(() => finish(busy()), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    // A timed-out queued acquisition can still eventually receive a client.
    // Its continuation immediately releases it rather than orphaning it.
    void pool.connect().then(client => finish(undefined, client), error => finish(error));
  });
}

export async function withHubAuthTransaction<T>(pool: Pool, request: FastifyRequest, reply: FastifyReply, body: (client: HubQueryable) => Promise<T>, telemetry?: HubPerformance): Promise<T> {
  const control = new AbortController();
  let client: PoolClient | undefined, released = false;
  const release = (destroy = false) => { if (client && !released) { released = true; client.release(destroy); } };
  const cancelRequest = () => control.abort(aborted());
  const closedResponse = () => { if (!reply.raw.writableEnded) cancelRequest(); };
  request.raw.once("aborted", cancelRequest); reply.raw.once("close", closedResponse);
  if (request.raw.aborted) cancelRequest();
  const timer = setTimeout(() => control.abort(timedOut()), HUB_AUTH_DATABASE_LIMITS.transactionMs);
  const cancelClient = () => release(true);
  control.signal.addEventListener("abort", cancelClient, { once: true });
  const acquireStart = performance.now();
  const started = performance.now();
  let outcome: unknown;
  try {
    try { client = await acquireHubClient(pool, control.signal); telemetry?.observe("pool.acquire", performance.now() - acquireStart); }
    catch (error) { telemetry?.observe("pool.acquire", performance.now() - acquireStart, performanceOutcome(error)); throw error; }
    if (control.signal.aborted) { release(true); throw control.signal.reason; }
    const guarded = { query: ((...args: any[]) => {
      if (control.signal.aborted) return Promise.reject(control.signal.reason);
      return (client!.query as any)(...args);
    }) } as HubQueryable;
    const work = (async () => {
      try {
        await client!.query("BEGIN");
        await client!.query("SET LOCAL statement_timeout='3000ms'");
        await client!.query("SET LOCAL lock_timeout='1000ms'");
        const result = await body(guarded);
        if (control.signal.aborted) throw control.signal.reason;
        await client!.query("COMMIT");
        return result;
      } catch (error) {
        if (!released) {
          const rollbackStart = performance.now(); let rollbackTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([client!.query("ROLLBACK"), new Promise((_, reject) => { rollbackTimer = setTimeout(() => { release(true); reject(timedOut()); }, HUB_AUTH_DATABASE_LIMITS.rollbackMs); })]);
            telemetry?.observe("auth.rollback", performance.now() - rollbackStart);
          } catch (rollbackError) { release(true); telemetry?.observe("auth.rollback", performance.now() - rollbackStart, performanceOutcome(rollbackError)); }
          finally { clearTimeout(rollbackTimer); }
        }
        if (control.signal.aborted) throw control.signal.reason;
        if (["57014", "55P03"].includes((error as { code?: string })?.code || "")) throw timedOut();
        throw error;
      } finally { release(); }
    })();
    let stop: (() => void) | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        stop = () => reject(control.signal.reason || aborted());
        control.signal.addEventListener("abort", stop, { once: true });
        if (control.signal.aborted) stop();
      })]);
    } finally { if (stop) control.signal.removeEventListener("abort", stop); }
  } catch (error) { outcome = error; throw error; }
  finally {
    clearTimeout(timer); request.raw.removeListener("aborted", cancelRequest); reply.raw.removeListener("close", closedResponse);
    control.signal.removeEventListener("abort", cancelClient); release(control.signal.aborted);
    telemetry?.observe("auth.transaction", performance.now() - started, outcome ? performanceOutcome(outcome) : "ok");
  }
}
