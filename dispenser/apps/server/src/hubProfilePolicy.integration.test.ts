import Fastify from "fastify";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  encodePortableValue,
  hubNamespace,
} from "@atlas-link-dispenser/shared";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import {
  registerHubProfilePolicyRoutes,
  PROFILE_POLICY_DEFAULTS,
  validateProfilePolicy,
  resolveProfilePolicy,
  collectExpiredChunks,
  collectExpiredProfileUploads,
  profileUsage,
} from "./hubProfilePolicy.js";
import { encrypt, decrypt } from "./security.js";
import { AppError } from "./errors.js";
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip,
  MiB = 1024 * 1024,
  hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
run(
  "Configurable profile policy and referenced chunk lifecycle (isolated PostgreSQL)",
  () => {
    let maintenance: Pool, pool: Pool, app: ReturnType<typeof Fastify>;
    const schema = "policy_" + randomUUID().replaceAll("-", ""),
      user = randomUUID(),
      admin = randomUUID(),
      profile = randomUUID(),
      other = randomUUID(),
      branch = randomUUID(),
      session = randomUUID(),
      context = randomUUID(),
      master = "private-test-master-not-a-production-key",
      key = "private-profile-test-key",
      namespace = { kind: "local" as const, origin: "https://save.example" },
      headers = { "x-admin": "yes", "x-csrf": "yes" };
    let epoch = 0,
      revision = 0;
    beforeAll(async () => {
      maintenance = new Pool({ connectionString: url });
      await maintenance.query("CREATE SCHEMA " + schema);
      pool = new Pool({
        connectionString: url,
        options: "-c search_path=" + schema + ",public",
      });
      await pool.query(
        "CREATE TABLE users(id uuid PRIMARY KEY,email text,normalized_email text);CREATE TABLE links(id uuid PRIMARY KEY);CREATE TABLE sessions(id uuid PRIMARY KEY);CREATE TABLE audit_events(id serial PRIMARY KEY,admin_id uuid,action text,target_type text,target_id text,after jsonb)",
      );
      for (const f of [
        "0009_hub_core.sql",
        "0013_hub_writer_handoff.sql",
        "0015_hub_profile_recovery.sql",
        "0016_hub_profile_policy.sql",
        "0018_hub_stream_budget.sql",
        "0019_hub_profile_delete_refs.sql",
      ])
        await pool.query(
          await readFile(
            new URL(
              "../../../packages/database/migrations/" + f,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      await pool.query(
        "INSERT INTO users VALUES($1,$2,$2),($3,$4,$4),($5,$6,$6)",
        [
          user,
          "member@example.test",
          admin,
          "admin@example.test",
          other,
          "other@example.test",
        ],
      );
      await pool.query("INSERT INTO links VALUES($1)", [branch]);
      await pool.query("INSERT INTO sessions VALUES($1)", [session]);
      await pool.query(
        "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$1,$2,$3)",
        [branch, "https://branch.example", "0".repeat(64)],
      );
      await pool.query(
        "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,$3,true)",
        [profile, user, encrypt(key, master)],
      );
      await pool.query(
        "INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '1 day')",
        [session, user, profile, branch, "1".repeat(64), context],
      );
      app = Fastify({ logger: false });
      app.setErrorHandler((e: any, _r: any, reply: any) =>
        reply
          .code(e.status ?? e.statusCode ?? 500)
          .send({ error: { code: e.code, message: e.message } }),
      );
      const requireAdmin = async (r: any) => {
          if (r.headers["x-admin"] !== "yes")
            throw new AppError("FORBIDDEN", "Admin required.", 403);
          return { id: admin, role: "admin" as const };
        },
        csrf = (r: any) => {
          if (r.headers["x-csrf"] !== "yes")
            throw new AppError("FORBIDDEN", "CSRF required.", 403);
        };
      await registerHubProfilePolicyRoutes(app, {
        pool,
        requireAdmin,
        requireUser: requireAdmin,
        csrf,
        encryptionKey: master,
      });
      registerHubProfileRoutes(app, {
        pool,
        encryptionKey: master,
        identity: {
          authenticate: async () => ({
            userId: user,
            profileId: profile,
            sessionId: session,
            contextId: context,
            branchId: branch,
          }),
        } as any,
      });
      await app.ready();
    });
    beforeEach(async () => {
      await pool.query(
        "TRUNCATE hub_profile_chunk_refs,hub_streams,hub_commits,hub_profile_recoveries,hub_chunks,hub_writers,hub_profile_policy_overrides",
      );
      await pool.query(
        "UPDATE hub_profiles SET bytes=0,revision=0,chunk_accounting_version=0",
      );
      await pool.query(
        "UPDATE hub_profile_policy_defaults SET profile_bytes=$1,local_bytes=$2,idb_bytes=$3",
        [
          PROFILE_POLICY_DEFAULTS.profileBytes,
          PROFILE_POLICY_DEFAULTS.localBytes,
          PROFILE_POLICY_DEFAULTS.idbBytes,
        ],
      );
      epoch = 0;
      revision = 0;
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await maintenance?.query("DROP SCHEMA " + schema + " CASCADE");
      await maintenance?.end();
    });
    async function request(method: any, path: string, body?: any, h: any = {}) {
      return app.inject({
        method,
        url: path,
        headers: h,
        ...(body === undefined ? {} : { payload: body }),
      });
    }
    async function wire(value: any) {
      const data = Buffer.from(
          JSON.stringify(await encodePortableValue(value)),
        ),
        digest = hash(data);
      const hashes: string[] = [];
      for (let at = 0; at < data.length; at += 4 * MiB) {
        const part = data.subarray(at, at + 4 * MiB),
          h = hash(part);
        const response = await request(
          "POST",
          "/api/hub/branch/profile/chunks",
          { hash: h, data: part.toString("base64") },
        );
        expect(response.statusCode).toBe(200);
        hashes.push(h);
      }
      return {
        codec: "atlas-chunks-v1",
        hashes,
        bytes: data.length,
        sha256: digest,
      };
    }
    async function commit(payload: any, id = "commit-" + randomUUID()) {
      if (!epoch) {
        const w = await request("POST", "/api/hub/branch/profile/writers", {
          namespace,
        });
        expect(w.statusCode).toBe(200);
        epoch = w.json().writer.epoch;
      }
      const b = {
          namespace,
          mode: "snapshot",
          epoch,
          baseRevision: revision,
          idempotencyKey: id,
          payload,
        },
        r = await request("POST", "/api/hub/branch/profile/commits", b);
      if (r.statusCode === 200) revision = r.json().revision;
      return { r, b };
    }
    it("validates byte ranges, protects policy mutations and resolves per-account inheritance", async () => {
      expect(() =>
        validateProfilePolicy({
          profileBytes: 0,
          localBytes: 5 * MiB,
          idbBytes: 64 * MiB,
        }),
      ).toThrow();
      expect(
        (await request("GET", "/api/admin/hub/profile-policy")).statusCode,
      ).toBe(403);
      expect(
        (
          await request(
            "PUT",
            "/api/admin/hub/profile-policy",
            PROFILE_POLICY_DEFAULTS,
            { "x-admin": "yes" },
          )
        ).statusCode,
      ).toBe(403);
      const value = {
        profileBytes: 32 * MiB,
        localBytes: MiB,
        idbBytes: 16 * MiB,
      };
      expect(
        (await request("PUT", "/api/admin/hub/profile-policy", value, headers))
          .statusCode,
      ).toBe(200);
      expect(await resolveProfilePolicy(pool, user)).toEqual(value);
      expect(
        (
          await request(
            "PUT",
            "/api/admin/hub/profile-policy/accounts/" + user,
            { profileBytes: 8 * MiB, localBytes: null, idbBytes: null },
            headers,
          )
        ).statusCode,
      ).toBe(200);
      const m = await request("GET", "/api/hub/branch/profile");
      expect(m.json().limits).toMatchObject({
        profileBytes: 8 * MiB,
        localBytes: MiB,
        idbBytes: 16 * MiB,
        chunkGraceMs: 86400000,
      });
      expect(await resolveProfilePolicy(pool, other)).toEqual(value);
      expect(
        Number(
          (await pool.query("SELECT count(*) n FROM audit_events")).rows[0].n,
        ),
      ).toBeGreaterThanOrEqual(2);
    });
    it("unreferenced pending uploads consume staging allowance, not canonical account quota", async () => {
      await request(
        "PUT",
        "/api/admin/hub/profile-policy/accounts/" + user,
        { profileBytes: MiB, localBytes: null, idbBytes: null },
        headers,
      );
      const pending = await wire("p".repeat(1200000));
      expect(
        (await request("GET", "/api/hub/branch/profile")).json().bytes,
      ).toBe(0);
      const { r } = await commit(pending);
      expect(r.statusCode).toBe(413);
      expect(
        (await pool.query("SELECT count(*) n FROM hub_profile_chunk_refs"))
          .rows[0].n,
      ).toBe("0");
      expect(
        Number(
          (
            await pool.query("SELECT bytes FROM hub_profiles WHERE id=$1", [
              profile,
            ])
          ).rows[0].bytes,
        ),
      ).toBe(0);
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", { namespace })
        ).json().revision,
      ).toBe(0);
    });
    it("repeated large checkpoints replace canonical usage, while GC preserves every live stream/commit reference", async () => {
      let prior = 0;
      for (let n = 0; n < 4; n++) {
        const payload = await wire(String(n).repeat(300000));
        const { r } = await commit(payload);
        expect(r.statusCode).toBe(200);
        const m = (await request("GET", "/api/hub/branch/profile")).json();
        expect(m.bytes).toBeLessThan(400000);
        expect(m.bytes).toBeGreaterThan(300000);
        prior = m.bytes;
      }
      await pool.query(
        "UPDATE hub_chunks SET created_at=now()-interval '25 hours'",
      );
      expect((await request("GET", "/api/hub/branch/profile")).statusCode).toBe(
        200,
      );
      // Deployed manifest reads are read-only; expiry must be reclaimed by
      // the bounded background collector, not a hidden write on every read.
      expect(Number((await pool.query("SELECT count(*) n FROM hub_chunks")).rows[0].n)).toBe(4);
      expect((await collectExpiredProfileUploads(pool, master)).chunks).toBe(3);
      expect(
        Number(
          (await pool.query("SELECT count(*) n FROM hub_chunks")).rows[0].n,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await pool.query("SELECT bytes FROM hub_profiles WHERE id=$1", [
              profile,
            ])
          ).rows[0].bytes,
        ),
      ).toBe(prior);
      const c = await pool.connect();
      try {
        expect(await collectExpiredChunks(c, profile)).toEqual({
          chunks: 0,
          bytes: 0,
        });
      } finally {
        c.release();
      }
    });
    it("recovery references survive old-checkpoint GC and over-quota recovery atomically rolls back", async () => {
      const old = await wire("r".repeat(400000));
      await commit(old);
      const recovery = randomUUID();
      expect(
        (
          await request("POST", "/api/hub/branch/profile/recoveries", {
            id: recovery,
            namespace,
            payload: old,
          })
        ).statusCode,
      ).toBe(200);
      await commit(await wire("new"));
      await pool.query(
        "UPDATE hub_chunks SET created_at=now()-interval '25 hours'",
      );
      await request("GET", "/api/hub/branch/profile");
      expect(
        (
          await request(
            "GET",
            "/api/hub/branch/profile/chunks/" + old.hashes[0],
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await request("GET", "/api/hub/branch/profile/recoveries/" + recovery))
          .statusCode,
      ).toBe(200);
      await request(
        "PUT",
        "/api/admin/hub/profile-policy/accounts/" + user,
        { profileBytes: MiB, localBytes: null, idbBytes: null },
        headers,
      );
      const large = await wire("z".repeat(900000)),
        denied = await request("POST", "/api/hub/branch/profile/recoveries", {
          id: randomUUID(),
          namespace,
          payload: large,
        });
      expect(denied.statusCode).toBe(413);
      expect(
        Number(
          (await pool.query("SELECT count(*) n FROM hub_profile_recoveries"))
            .rows[0].n,
        ),
      ).toBe(1);
    });
    it("committed replay receipts survive collection of their old unreferenced chunks", async () => {
      const old = await wire("one".repeat(100000)),
        first = await commit(old);
      expect(first.r.statusCode).toBe(200);
      await commit(await wire("two"));
      await pool.query(
        "UPDATE hub_chunks SET created_at=now()-interval '25 hours'",
      );
      await request("GET", "/api/hub/branch/profile");
      expect(
        (
          await request(
            "GET",
            "/api/hub/branch/profile/chunks/" + old.hashes[0],
          )
        ).statusCode,
      ).toBe(404);
      const replay = await request(
        "POST",
        "/api/hub/branch/profile/commits",
        first.b,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json().replayed).toBe(true);
    });
    it("lazy accounting verifies all old ciphertext before GC and cannot collect ambiguous live data", async () => {
      const w = await wire("keep");
      await pool.query(
        "UPDATE hub_profiles SET chunk_accounting_version=0 WHERE id=$1",
        [profile],
      );
      await pool.query(
        "INSERT INTO hub_streams(profile_id,namespace,encrypted_payload,bytes) VALUES($1,$2,$3,$4)",
        [profile, hubNamespace(namespace).key, "corrupt-ciphertext", 100],
      );
      await pool.query(
        "UPDATE hub_chunks SET created_at=now()-interval '25 hours'",
      );
      expect((await request("GET", "/api/hub/branch/profile")).statusCode).toBe(
        500,
      );
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM hub_chunks WHERE hash=$1",
              [w.hashes[0]],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    });
    it("each collection batch is row-bounded and leaves another profile's chunks untouched", async () => {
      const hashes = Array.from({ length: 19 }, (_, index) => hash("bounded-gc-" + index));
      for (const value of hashes) await pool.query("INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes,created_at)VALUES($1,$2,'unreferenced-fixture',1,now()-interval '25 hours')", [profile, value]);
      const c = await pool.connect();
      try { await c.query("BEGIN"); await c.query("SELECT 1 FROM hub_profiles WHERE id=$1 FOR UPDATE", [profile]); expect(await collectExpiredChunks(c, profile, new Date(), 7)).toEqual({ chunks: 7, bytes: 7 }); await c.query("COMMIT"); }
      finally { c.release(); }
      expect(Number((await pool.query("SELECT count(*) n FROM hub_chunks WHERE profile_id=$1 AND hash=ANY($2)", [profile, hashes])).rows[0].n)).toBe(12);
    });
    it("each collection transaction also respects a16MiB byte budget", async () => {
      for (let index=0; index<5; index++) await pool.query("INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes,created_at)VALUES($1,$2,'unreferenced-fixture',$3,now()-interval '25 hours')", [profile, hash("byte-budget-"+index), 4*MiB]);
      const c=await pool.connect();try { await c.query("BEGIN");await c.query("SELECT 1 FROM hub_profiles WHERE id=$1 FOR UPDATE",[profile]);expect(await collectExpiredChunks(c,profile)).toEqual({chunks:4,bytes:16*MiB});await c.query("COMMIT"); } finally { c.release(); }
      expect(Number((await pool.query("SELECT count(*) n FROM hub_chunks WHERE profile_id=$1",[profile])).rows[0].n)).toBe(1);
    });
    it("an interrupted actual PostgreSQL sweep rolls back deletions/accounting and leaves the pool healthy", async () => {
      await pool.query("UPDATE hub_profiles SET bytes=999,chunk_accounting_version=1 WHERE id=$1",[profile]);
      const oldHash=hash("interrupted-sweep");await pool.query("INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes,created_at)VALUES($1,$2,'unreferenced-fixture',1,now()-interval '25 hours')",[profile,oldHash]);
      const wrapped=Object.create(pool) as Pool;
      wrapped.connect=(async()=>{
        const c=await pool.connect(),query=c.query.bind(c);let delayed=false;
        c.query=((...args:any[])=>{
          const text=typeof args[0]==="string"?args[0]:args[0]?.text;
          const result=(query as any)(...args);
          if(!delayed && text?.includes("DELETE FROM hub_chunks")){delayed=true;return result.then(async(value:any)=>{await query("SELECT pg_sleep(1)");return value;});}
          return result;
        }) as any;
        return c;
      }) as any;
      const result=await collectExpiredProfileUploads(wrapped,master,50,{budgetMs:100});
      expect(result.failed).toBe(1);expect(result.chunks).toBe(0);
      expect((await pool.query("SELECT 1 FROM hub_chunks WHERE profile_id=$1 AND hash=$2",[profile,oldHash])).rowCount).toBe(1);
      expect(Number((await pool.query("SELECT bytes FROM hub_profiles WHERE id=$1",[profile])).rows[0].bytes)).toBe(999);
      expect((await pool.query("SELECT 1 healthy")).rows[0].healthy).toBe(1);expect(pool.waitingCount).toBe(0);
    });
    it("periodic collection reclaims only expired unreferenced uploads and keeps fresh staging plus current data", async () => {
      const current = await wire("current"),
        { r } = await commit(current);
      expect(r.statusCode).toBe(200);
      const expired = await wire("expired"),
        fresh = await wire("fresh");
      await pool.query(
        "UPDATE hub_chunks SET created_at=now()-interval '25 hours' WHERE hash=ANY($1)",
        [[current.hashes[0], expired.hashes[0]]],
      );
      const collected = await collectExpiredProfileUploads(pool, master);
      expect(collected.failed).toBe(0);
      expect(collected.chunks).toBe(1);
      const hashes = (await pool.query("SELECT hash FROM hub_chunks")).rows.map(
        (r) => r.hash,
      );
      expect(hashes).toContain(current.hashes[0]);
      expect(hashes).toContain(fresh.hashes[0]);
      expect(hashes).not.toContain(expired.hashes[0]);
      await expect(
        pool.query("DELETE FROM hub_chunks WHERE profile_id=$1 AND hash=$2", [
          profile,
          current.hashes[0],
        ]),
      ).rejects.toMatchObject({ code: "23503" });
    });
    it("lowering allowance preserves reads and old saves, denies growth atomically and permits a smaller checkpoint", async () => {
      const first = await commit(await wire("l".repeat(1200000)));
      expect(first.r.statusCode).toBe(200);
      await request(
        "PUT",
        "/api/admin/hub/profile-policy/accounts/" + user,
        { profileBytes: MiB, localBytes: null, idbBytes: null },
        headers,
      );
      expect((await request("GET", "/api/hub/branch/profile")).statusCode).toBe(
        200,
      );
      const grow = await commit(await wire("b".repeat(1300000)));
      expect(grow.r.statusCode).toBe(413);
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", { namespace })
        ).json().revision,
      ).toBe(1);
      expect((await commit(await wire("small"))).r.statusCode).toBe(200);
      const found = await request(
        "GET",
        "/api/admin/hub/profile-policy/account?email=member%40example.test",
        undefined,
        headers,
      );
      expect(found.statusCode).toBe(200);
      expect(found.json().bytes).toBeLessThan(MiB);
      expect(found.json().stagingBytes).toBeGreaterThan(2 * MiB);
    });
    it("chunked preference retries remain idempotent after their staging chunks expire", async () => {
      const payload = await wire({
          format: "atlas-preferences-patch-v1",
          changes: [
            { key: "atlas.chats", value: "c".repeat(300000), base: null },
          ],
        }),
        body = { idempotencyKey: "preferences-" + randomUUID(), payload };
      expect(
        (await request("POST", "/api/hub/branch/profile/preferences", body))
          .statusCode,
      ).toBe(200);
      await pool.query(
        "UPDATE hub_chunks SET created_at=now()-interval '25 hours'",
      );
      await collectExpiredProfileUploads(pool, master);
      expect(
        Number(
          (await pool.query("SELECT count(*) n FROM hub_chunks")).rows[0].n,
        ),
      ).toBe(0);
      const replay = await request(
        "POST",
        "/api/hub/branch/profile/preferences",
        body,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json().replayed).toBe(true);
    });
    it("renews only an expired exact unsuperseded writer; commits remain live-only and every new fence denies the old owner", async () => {
      const w = await request("POST", "/api/hub/branch/profile/writers", {
          namespace,
        }),
        old = w.json().writer;
      const expires = () =>
        pool.query(
          "UPDATE hub_writers SET expires_at=now()-interval '1 second' WHERE profile_id=$1",
          [profile],
        );
      await expires();
      const body = {
        namespace,
        mode: "snapshot",
        epoch: old.epoch,
        baseRevision: 0,
        idempotencyKey: "expired-writer-save-fixture",
        payload: await encodePortableValue({
          format: "atlas-local-snapshot-v1",
          revision: 0,
          entries: [],
        }),
      };
      expect(
        (await request("POST", "/api/hub/branch/profile/commits", body))
          .statusCode,
      ).toBe(409);
      const renewed = await request("PUT", "/api/hub/branch/profile/writers", {
        namespace,
        epoch: old.epoch,
      });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().writer.epoch).toBe(old.epoch);
      expect(renewed.json().writer.contextId).toBe(context);
      expect(
        (await request("POST", "/api/hub/branch/profile/commits", body))
          .statusCode,
      ).toBe(200);
      await expires();
      await pool.query(
        "UPDATE hub_writers SET context_id=$2 WHERE profile_id=$1",
        [profile, randomUUID()],
      );
      expect(
        (
          await request("PUT", "/api/hub/branch/profile/writers", {
            namespace,
            epoch: old.epoch,
          })
        ).statusCode,
      ).toBe(409);
      await pool.query(
        "UPDATE hub_writers SET context_id=$2,epoch=epoch+1 WHERE profile_id=$1",
        [profile, context],
      );
      expect(
        (
          await request("PUT", "/api/hub/branch/profile/writers", {
            namespace,
            epoch: old.epoch,
          })
        ).statusCode,
      ).toBe(409);
      const replacement = randomUUID();
      await pool.query(
        "INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 day')",
        [
          replacement,
          user,
          profile,
          branch,
          session,
          hash(replacement),
          context,
        ],
      );
      await pool.query(
        "UPDATE hub_writers SET session_id=$2,epoch=$3 WHERE profile_id=$1",
        [profile, replacement, old.epoch],
      );
      expect(
        (
          await request("PUT", "/api/hub/branch/profile/writers", {
            namespace,
            epoch: old.epoch,
          })
        ).statusCode,
      ).toBe(409);
    });
    it("bounds raw chunked snapshot+journal restoration, not tiny manifests; rejection is atomic and a smaller checkpoint recovers", async () => {
      const n = { kind: "idb", origin: namespace.origin, name: "large-values" };
      const data = new ArrayBuffer(26 * MiB);
      const snapshot = await wire({
        format: "atlas-idb-snapshot-v1",
        version: 1,
        stores: [
          {
            name: "records",
            keyPath: null,
            autoIncrement: false,
            indexes: [],
            records: [{ key: 1, value: data }],
            generator: null,
          },
        ],
      });
      const w = (
        await request("POST", "/api/hub/branch/profile/writers", {
          namespace: n,
        })
      ).json().writer;
      const first = await request("POST", "/api/hub/branch/profile/commits", {
        namespace: n,
        mode: "snapshot",
        epoch: w.epoch,
        baseRevision: 0,
        idempotencyKey: "large-raw-snapshot-fixture",
        payload: snapshot,
      });
      expect(first.statusCode).toBe(200);
      const stream = async () =>
        (
          await pool.query(
            "SELECT revision,restore_bytes FROM hub_streams WHERE profile_id=$1 AND namespace=$2",
            [profile, hubNamespace(n as any).key],
          )
        ).rows[0];
      expect(Number((await stream()).restore_bytes)).toBe(snapshot.bytes);
      expect(snapshot.bytes).toBeGreaterThan(32 * MiB);
      const journal = await wire({
        version: 1,
        changes: [
          {
            type: "data",
            action: "put",
            store: "records",
            args: [data, 1],
            key: 1,
          },
        ],
      });
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await request("POST", "/api/hub/branch/profile/commits", {
              namespace: n,
              mode: "journal",
              epoch: w.epoch,
              baseRevision: 1 + i,
              idempotencyKey: "large-raw-accepted-" + i,
              payload: journal,
            })
          ).statusCode,
        ).toBe(200);
      }
      const before = await stream();
      expect(Number(before.restore_bytes)).toBeGreaterThan(64 * MiB);
      const rejected = await request(
        "POST",
        "/api/hub/branch/profile/commits",
        {
          namespace: n,
          mode: "journal",
          epoch: w.epoch,
          baseRevision: 3,
          idempotencyKey: "large-raw-journal-fixture",
          payload: journal,
        },
      );
      expect(rejected.statusCode).toBe(413);
      expect(rejected.json().error.code).toBe("HUB_QUOTA");
      expect(await stream()).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_commits WHERE profile_id=$1 AND idempotency_key='large-raw-journal-fixture'",
            [profile],
          )
        ).rows[0].n,
      ).toBe(0);
      const small = await encodePortableValue({
        format: "atlas-idb-snapshot-v1",
        version: 1,
        stores: [],
      });
      expect(
        (
          await request("POST", "/api/hub/branch/profile/commits", {
            namespace: n,
            mode: "snapshot",
            epoch: w.epoch,
            baseRevision: 3,
            idempotencyKey: "small-checkpoint-fixture",
            payload: small,
          })
        ).statusCode,
      ).toBe(200);
      expect(Number((await stream()).restore_bytes)).toBeLessThan(1024);
    });
    it("account/profile deletion cascades only its own chunks while direct deletion of a live referenced chunk remains denied", async () => {
      for (const target of ["account", "profile"]) {
        const owner = randomUUID(),
          id = randomUUID(),
          h = hash(target + id);
        await pool.query(
          "INSERT INTO users(id,email,normalized_email)VALUES($1,$2,$2)",
          [owner, owner + "@example.test"],
        );
        await pool.query(
          "INSERT INTO hub_profiles(id,user_id,encrypted_key)VALUES($1,$2,$3)",
          [id, owner, encrypt(key, master)],
        );
        await pool.query(
          "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes,created_at)VALUES($1,$2,$3,1,now()-interval '25 hours')",
          [id, h, encrypt("AA==", key)],
        );
        await pool.query(
          "INSERT INTO hub_profile_chunk_refs(profile_id,hash,owner_kind,owner_key)VALUES($1,$2,'stream','fixture')",
          [id, h],
        );
        await expect(
          pool.query("DELETE FROM hub_chunks WHERE profile_id=$1", [id]),
        ).rejects.toMatchObject({ code: "23503" });
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          expect((await collectExpiredChunks(c, id)).chunks).toBe(0);
          await c.query("COMMIT");
        } finally {
          c.release();
        }
        await pool.query(
          target === "account"
            ? "DELETE FROM users WHERE id=$1"
            : "DELETE FROM hub_profiles WHERE id=$1",
          [target === "account" ? owner : id],
        );
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM hub_profile_chunk_refs WHERE profile_id=$1",
              [id],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM hub_chunks WHERE profile_id=$1",
              [id],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM hub_profiles WHERE id=$1",
              [profile],
            )
          ).rows[0].n,
        ).toBe(1);
        if (target === "profile")
          await pool.query("DELETE FROM users WHERE id=$1", [owner]);
      }
    });
    async function journalFixture(count: number) {
      const n = hubNamespace(namespace).key;
      const initial = JSON.stringify(
        await encodePortableValue({
          format: "atlas-local-snapshot-v1",
          revision: 0,
          entries: [],
        }),
      );
      const rows = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const encoded = JSON.stringify(
            await encodePortableValue({
              change: { op: "set", key: "score", value: String(i + 1) },
              revision: i + 1,
            }),
          );
          return {
            id: "journal-" + String(i + 2).padStart(16, "0"),
            encrypted: encrypt(encoded, key),
            bytes: Buffer.byteLength(encoded),
            revision: i + 2,
          };
        }),
      );
      const total =
        Buffer.byteLength(initial) + rows.reduce((n, r) => n + r.bytes, 0);
      await pool.query(
        "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes) VALUES($1,$2,$3,1,$4,$5)",
        [profile, n, count + 1, encrypt(initial, key), total],
      );
      await pool.query(
        "INSERT INTO hub_commits(profile_id,namespace,idempotency_key,payload_hash,mode,encrypted_payload,bytes,revision,profile_revision) SELECT $1,$2,x.id,repeat('0',64),'journal',x.payload,x.bytes,x.revision,x.revision FROM unnest($3::text[],$4::text[],$5::int[],$6::bigint[]) AS x(id,payload,bytes,revision)",
        [
          profile,
          n,
          rows.map((r) => r.id),
          rows.map((r) => r.encrypted),
          rows.map((r) => r.bytes),
          rows.map((r) => r.revision),
        ],
      );
      await pool.query(
        "UPDATE hub_profiles SET revision=$2,bytes=$3 WHERE id=$1",
        [profile, count + 1, total],
      );
      return n;
    }
    it("paginates more than1000 typed journal commits without truncating or mixing later writes", async () => {
      const n = await journalFixture(1203),
        pages: any[] = [];
      let r = await request("POST", "/api/hub/branch/profile/stream", {
        namespace,
      });
      expect(r.statusCode).toBe(200);
      let data = r.json();
      pages.push(data);
      expect(data.revision).toBe(1204);
      expect(data.journal).toHaveLength(500);
      expect(data.hasMore).toBe(true);
      expect(data.snapshot).not.toBeNull();
      await pool.query(
        "UPDATE hub_streams SET revision=1205 WHERE profile_id=$1 AND namespace=$2",
        [profile, n],
      );
      const tail = JSON.stringify(
        await encodePortableValue({
          change: { op: "set", key: "score", value: "newer" },
          revision: 1204,
        }),
      );
      await pool.query(
        "INSERT INTO hub_commits(profile_id,namespace,idempotency_key,payload_hash,mode,encrypted_payload,bytes,revision,profile_revision) VALUES($1,$2,'later-journal-commit',repeat('1',64),'journal',$3,$4,1205,1205)",
        [profile, n, encrypt(tail, key), Buffer.byteLength(tail)],
      );
      while (data.hasMore) {
        r = await request("POST", "/api/hub/branch/profile/stream", {
          namespace,
          after: data.nextAfter,
          targetRevision: 1204,
          snapshotRevision: 1,
        });
        expect(r.statusCode).toBe(200);
        data = r.json();
        expect(data.snapshot).toBeNull();
        expect(data.revision).toBe(1204);
        pages.push(data);
      }
      expect(pages.map((p) => p.journal.length)).toEqual([500, 500, 203]);
      expect(data.nextAfter).toBe(1204);
      const all = pages.flatMap((p) => p.journal);
      expect(all.map((j) => j.revision)).toEqual(
        Array.from({ length: 1203 }, (_, i) => i + 2),
      );
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", {
            namespace,
            headOnly: true,
          })
        ).json(),
      ).toEqual({ revision: 1205, snapshotRevision: 1, snapshotBytes: 245, restoreBytes: 369758 });
    });
    it("rejects changed checkpoints, malformed pins and missing journal revisions instead of partial hydration", async () => {
      const n = await journalFixture(1002);
      for (const extra of [
        { after: 501, targetRevision: 1003 },
        { after: 501, snapshotRevision: 1 },
        { after: 501, targetRevision: 1004, snapshotRevision: 1 },
        { after: 1004, targetRevision: 1003, snapshotRevision: 1 },
      ])
        expect(
          (
            await request("POST", "/api/hub/branch/profile/stream", {
              namespace,
              ...extra,
            })
          ).statusCode,
        ).toBeGreaterThanOrEqual(400);
      await pool.query(
        "UPDATE hub_streams SET snapshot_revision=400 WHERE profile_id=$1 AND namespace=$2",
        [profile, n],
      );
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", {
            namespace,
            after: 501,
            targetRevision: 1003,
            snapshotRevision: 1,
          })
        ).statusCode,
      ).toBe(409);
      await pool.query(
        "UPDATE hub_streams SET snapshot_revision=1 WHERE profile_id=$1 AND namespace=$2",
        [profile, n],
      );
      await pool.query(
        "DELETE FROM hub_commits WHERE profile_id=$1 AND revision=600",
        [profile],
      );
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", {
            namespace,
            after: 501,
            targetRevision: 1003,
            snapshotRevision: 1,
          })
        ).statusCode,
      ).toBe(409);
    });
    it("head-only drain reads do not parse journal ciphertext or return payloads", async () => {
      const n = await journalFixture(2);
      // Accounting is first verified while the fixture is valid; a drain-head
      // lookup must not touch journal payloads after that initialization.
      expect((await request("GET", "/api/hub/branch/profile")).statusCode).toBe(
        200,
      );
      await pool.query(
        "UPDATE hub_commits SET encrypted_payload='corrupt-fixture' WHERE profile_id=$1 AND namespace=$2",
        [profile, n],
      );
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", {
            namespace,
            headOnly: true,
          })
        ).json(),
      ).toEqual({ revision: 3, snapshotRevision: 1, snapshotBytes: 245, restoreBytes: 851 });
      expect(
        (await request("POST", "/api/hub/branch/profile/stream", { namespace }))
          .statusCode,
      ).toBeGreaterThanOrEqual(400);
    });
    it("staging metadata count is bounded independently of account byte allowance", async () => {
      await request("GET", "/api/hub/branch/profile");
      await pool.query(
        "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) SELECT $1,md5(i::text)||md5('chunk'||i::text),'pending-fixture',1 FROM generate_series(1,4096) i",
        [profile],
      );
      const data = Buffer.from("overflow");
      const upload = await request("POST", "/api/hub/branch/profile/chunks", {
        hash: hash(data),
        data: data.toString("base64"),
      });
      expect(upload.statusCode).toBe(413);
      expect(
        Number(
          (await pool.query("SELECT count(*) n FROM hub_chunks")).rows[0].n,
        ),
      ).toBe(4096);
    });
  },
);
