/** Real PostgreSQL lock compatibility and fencing regressions. Every fixture
 * owns a fresh schema in a dedicated _test database; no deployed data is used. */
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { Pool, type PoolClient } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodePortableValue, hubNamespace } from "@atlas-link-dispenser/shared";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import { collectExpiredProfileUploads } from "./hubProfilePolicy.js";
import { encrypt } from "./security.js";
const database = process.env.TEST_DATABASE_URL;
const suite = database ? describe : describe.skip;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const path = "/api/hub/branch/profile";
suite("Account lock isolation and writer fencing (real PostgreSQL)", () => {
  const schema = "locks_" + randomUUID().replaceAll("-", "");
  const application = "account-locks-" + schema;
  const userId = randomUUID(), profileId = randomUUID(), branchId = randomUUID();
  const sessionId = randomUUID(), peerSession = randomUUID();
  const contextId = randomUUID(), peerContext = randomUUID();
  const master = "fixture-account-lock-master", key = "fixture-account-lock-key";
  const a = { kind: "local" as const, origin: "https://a.example.test" };
  const b = { kind: "local" as const, origin: "https://b.example.org" };
  let maintenance: Pool, pool: Pool, app: ReturnType<typeof Fastify>;
  let afterQuery: undefined | ((sql: string) => Promise<void>);
  beforeAll(async () => {
    if (!new URL(database!).pathname.endsWith("_test")) throw Error("Dedicated _test PostgreSQL required");
    maintenance = new Pool({ connectionString: database });
    await maintenance.query("CREATE SCHEMA " + schema);
    pool = new Pool({ connectionString: database, max: 12, application_name: application, options: "-c search_path=" + schema + ",public" });
    await pool.query("CREATE TABLE users(id uuid PRIMARY KEY,email text,normalized_email text);CREATE TABLE links(id uuid PRIMARY KEY);CREATE TABLE sessions(id uuid PRIMARY KEY)");
    for (const migration of ["0009_hub_core.sql", "0013_hub_writer_handoff.sql", "0015_hub_profile_recovery.sql", "0016_hub_profile_policy.sql", "0018_hub_stream_budget.sql", "0019_hub_profile_delete_refs.sql"])
      await pool.query(await readFile(new URL("../../../packages/database/migrations/" + migration, import.meta.url), "utf8"));
    await pool.query("INSERT INTO users VALUES($1,'fixture@example.test','fixture@example.test')", [userId]);
    await pool.query("INSERT INTO links VALUES($1)", [branchId]);
    await pool.query("INSERT INTO sessions VALUES($1),($2)", [sessionId, peerSession]);
    await pool.query("INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$1,'https://branch.example.test',$2)", [branchId, "0".repeat(64)]);
    const instrumented = {
      query: (...args: any[]) => (pool.query as any)(...args),
      connect: async () => {
        const client = await pool.connect();
        return { query: async (...args: any[]) => { const result = await (client.query as any)(...args); await afterQuery?.(String(args[0])); return result; }, release: () => client.release() };
      },
    } as unknown as Pool;
    app = Fastify({ logger: false });
    app.setErrorHandler((error: any, _request: FastifyRequest, reply: FastifyReply) => reply.code(error.status ?? error.statusCode ?? 500).send({ error: { code: error.code, message: error.message } }));
    registerHubProfileRoutes(app, { pool: instrumented, encryptionKey: master, identity: { authenticate: async (req: any) => ({ userId, profileId, branchId, sessionId: req.headers["x-fixture-peer"] ? peerSession : sessionId, contextId: req.headers["x-fixture-peer"] ? peerContext : contextId }) } as any });
    await app.ready();
  });
  beforeEach(async () => {
    afterQuery = undefined;
    await pool.query("TRUNCATE hub_profiles CASCADE");
    await pool.query("INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized,chunk_accounting_version) VALUES($1,$2,$3,true,1)", [profileId, userId, encrypt(key, master)]);
    for (const [id, context] of [[sessionId, contextId], [peerSession, peerContext]])
      await pool.query("INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '1 day')", [id, userId, profileId, branchId, sha(id), context]);
    await pool.query("UPDATE hub_profile_policy_defaults SET profile_bytes=268435456");
  });
  afterAll(async () => { afterQuery = undefined; await app?.close(); await pool?.end(); await maintenance?.query("DROP SCHEMA " + schema + " CASCADE"); await maintenance?.end(); });
  type FixtureResponse = { statusCode: number; body: string; json(): any };
  const request = async (method: any, suffix: string, payload?: unknown, peer = false): Promise<FixtureResponse> => await app.inject({ method, url: path + suffix, headers: peer ? { "x-fixture-peer": "yes" } : {}, ...(payload === undefined ? {} : { payload: payload as any }) }) as FixtureResponse;
  const within = <T>(p: Promise<T>, label: string) => Promise.race([p, delay(1200).then(() => { throw Error("Blocked by unrelated account work: " + label); })]);
  async function hold(sql: string, values: unknown[] = [profileId]) {
    const c = await pool.connect(); await c.query("BEGIN"); await c.query(sql, values);
    return { client: c, close: async () => { await c.query("ROLLBACK"); c.release(); } };
  }
  async function writer(namespace = a) { const r = await request("POST", "/writers", { namespace }); expect(r.statusCode, r.body).toBe(200); return r.json().writer; }
  async function body(epoch: number, namespace = a, baseRevision = 0, value: any = { value: "saved" }) { return { namespace, epoch, baseRevision, idempotencyKey: "lock-" + randomUUID(), mode: "snapshot", payload: await encodePortableValue(value) }; }
  async function lockWait() {
    for (let i = 0; i < 100; i++) {
      if ((await maintenance.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rowCount) return;
      await delay(10);
    }
    throw Error("Expected actual PostgreSQL row-lock wait");
  }
  it("website writer acquisition completes while unrelated accounting holds its profile row", async () => {
    const lock = await hold("SELECT id FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE");
    const pending = request("POST", "/writers", { namespace: b });
    try { const r = await within(pending, "writer acquisition"); expect(r.statusCode, r.body).toBe(200); }
    finally { await lock.close(); await pending; }
  });
  it("a blocked same-site renewal does not block acquiring another website", async () => {
    const w = await writer();
    const lock = await hold("SELECT 1 FROM hub_writers WHERE profile_id=$1 AND site_group=$2 FOR UPDATE", [profileId, hubNamespace(a).siteGroup]);
    const renewal = request("PUT", "/writers", { namespace: a, epoch: w.epoch });
    let unrelated: ReturnType<typeof request> | undefined;
    try {
      await lockWait();
      unrelated = request("POST", "/writers", { namespace: b });
      expect((await within(unrelated, "unrelated-site writer")).statusCode).toBe(200);
    } finally { await lock.close(); await Promise.all([renewal, unrelated]); }
  });
  it("chunk and recovered-save reads do not acquire accounting locks or run collection", async () => {
    const data = Buffer.from("fixture binary"), hash = sha(data), recovery = randomUUID();
    const payload = await encodePortableValue({ value: "recovered" });
    await pool.query("INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,$4)", [profileId, hash, encrypt(data.toString("base64"), key), data.length]);
    await pool.query("INSERT INTO hub_profile_recoveries(id,profile_id,context_id,namespace,encrypted_payload,payload_hash,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)", [recovery, profileId, contextId, hubNamespace(a).key, encrypt(JSON.stringify(payload), key), sha(JSON.stringify(payload)), JSON.stringify(payload).length]);
    const lock = await hold("SELECT id FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE");
    const pending = Promise.all([request("GET", "/chunks/" + hash), request("GET", "/recoveries/" + recovery)]);
    try {
      const [chunk, saved] = await within(pending, "chunk/recovery read");
      expect(chunk.statusCode, chunk.body).toBe(200); expect(chunk.json().data).toBe(data.toString("base64"));
      expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().payload).toEqual(payload);
    } finally { await lock.close(); await pending; }
  });
  it("two simultaneous first owners cannot both acquire the same website", async () => {
    const result = await Promise.all([request("POST", "/writers", { namespace: a }), request("POST", "/writers", { namespace: a }, true)]);
    expect(result.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await pool.query("SELECT epoch FROM hub_writers WHERE profile_id=$1", [profileId])).rows.map((r: {epoch: string | number}) => Number(r.epoch))).toEqual([1]);
  });
  it("commit retains its writer fence through COMMIT while another website can acquire", async () => {
    const w = await writer();
    const h = await request("POST", "/writers/takeover", { namespace: a }, true); expect(h.statusCode, h.body).toBe(200);
    const entered = deferred(), resume = deferred(); let paused = false;
    afterQuery = async sql => { if (!paused && /SELECT \* FROM hub_writers WHERE/.test(sql)) { paused = true; entered.resolve(); await resume.promise; } };
    const committing = request("POST", "/commits", await body(w.epoch));
    let takeover: ReturnType<typeof request> | undefined, unrelated: ReturnType<typeof request> | undefined;
    try {
      await within(entered.promise, "commit fixture entry");
      takeover = request("POST", "/writers", { namespace: a, handoffId: h.json().handoffId, useLatestBackup: true }, true);
      await lockWait();
      unrelated = request("POST", "/writers", { namespace: b });
      expect((await within(unrelated, "unrelated writer during committed fence")).statusCode).toBe(200);
    } finally { afterQuery = undefined; resume.resolve(); await Promise.all([committing, takeover, unrelated]); }
    expect((await committing).statusCode).toBe(200); expect((await takeover!).statusCode).toBe(200);
    const stale = await request("POST", "/commits", await body(w.epoch, a, 1));
    expect(stale.statusCode, stale.body).toBe(409); expect(stale.json().error.code).toBe("HUB_WRITER_LOST");
    expect(Number((await pool.query("SELECT count(*) n FROM hub_commits WHERE profile_id=$1", [profileId])).rows[0].n)).toBe(1);
  });
  it("profile deletion waits for active metadata transaction and leaves no orphan writer", async () => {
    const entered = deferred(), resume = deferred(); let paused = false;
    afterQuery = async sql => { if (!paused && /INSERT INTO hub_writers/.test(sql)) { paused = true; entered.resolve(); await resume.promise; } };
    const acquisition = request("POST", "/writers", { namespace: a });
    let deleting: Promise<any> | undefined, deletionFinished = false;
    try {
      await within(entered.promise, "metadata fixture entry");
      deleting = pool.query("DELETE FROM hub_profiles WHERE id=$1", [profileId]).then(r => { deletionFinished = true; return r; });
      await lockWait(); expect(deletionFinished).toBe(false);
    } finally { afterQuery = undefined; resume.resolve(); await acquisition; await deleting; }
    expect((await acquisition).statusCode).toBe(200);
    expect((await pool.query("SELECT * FROM hub_writers WHERE profile_id=$1", [profileId])).rowCount).toBe(0);
    expect((await request("POST", "/writers", { namespace: a })).statusCode).toBe(401);
  });
  it("profile quota and revision remain atomic across simultaneous different-site commits", async () => {
    const wa = await writer(a), wb = await writer(b);
    await pool.query("UPDATE hub_profile_policy_defaults SET profile_bytes=1048576");
    const result = await Promise.all([request("POST", "/commits", await body(wa.epoch, a, 0, { value: "a".repeat(600000) })), request("POST", "/commits", await body(wb.epoch, b, 0, { value: "b".repeat(600000) }))]);
    expect(result.map(r => r.statusCode).sort()).toEqual([200, 413]);
    const p = (await pool.query("SELECT revision,bytes FROM hub_profiles WHERE id=$1", [profileId])).rows[0];
    expect(Number(p.revision)).toBe(1); expect(Number(p.bytes)).toBeLessThanOrEqual(1048576);
  });
  it("a commit waiting for accounting cannot validate an expired lease against transaction start time", async () => {
    const w = await writer();
    await pool.query("UPDATE hub_writers SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE profile_id=$1", [profileId]);
    const lock = await hold("SELECT id FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE");
    const pending = request("POST", "/commits", await body(w.epoch));
    try { await lockWait(); await delay(150); }
    finally { await lock.close(); }
    const result = await pending;
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().error.code).toBe("HUB_WRITER_LOST");
    expect((await pool.query("SELECT 1 FROM hub_commits WHERE profile_id=$1", [profileId])).rowCount).toBe(0);
  });
  it("bounded chunk collection remains compatible with writer metadata key-share locks", async () => {
    const data = Buffer.from("expired fixture"), hash = sha(data);
    await pool.query("INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes,created_at) VALUES($1,$2,$3,$4,now()-interval '2 days')", [profileId, hash, encrypt(data.toString("base64"), key), data.length]);
    const lock = await hold("SELECT id FROM hub_profiles WHERE id=$1 FOR KEY SHARE");
    try {
      const result = await within(collectExpiredProfileUploads(pool, master, 5, { budgetMs: 1500 }), "bounded GC");
      expect(result.failed).toBe(0); expect(result.chunks).toBe(1);
    } finally { await lock.close(); }
  });
});
