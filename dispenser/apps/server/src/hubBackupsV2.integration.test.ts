import {provisionBackupCatalogTestIndexes} from "./hubBackupsV2Readiness.js";
import Fastify from "fastify";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  encodePortableValue,
  decodePortableValue,
  hubNamespace,
  canonicalBackupJson,
  backupManifestIdentity,
  type BackupCheckpointV2,
} from "@atlas-link-dispenser/shared";
import {
  registerHubBackupsV2Routes,
  runBackupMaintenanceSlice,
  withBackupTransaction,
} from "./hubBackupsV2.js";
import { profileUsage } from "./hubProfilePolicy.js";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import {
  registerHubLegacyConversionRoutes,
  runLegacyConversionJob,
} from "./hubBackupsV2Legacy.js";
import {
  runBackupAccountingSlice,
  runBackupAccountingActivation,
} from "./hubBackupsV2Accounting.js";
import { encrypt } from "./security.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
run("Periodic backup v2 — isolated PostgreSQL, no deployment", () => {
  let admin: Pool, pool: Pool, app: ReturnType<typeof Fastify>;
  const schema = "backupv2_" + randomUUID().replaceAll("-", ""),
    user = randomUUID(),
    profile = randomUUID(),
    branch = randomUUID(),
    session = randomUUID(),
    context = randomUUID();
  const namespace = {
      kind: "idb" as const,
      origin: "https://save.example",
      name: "saves",
    },
    master = "isolated-fixture-master",
    key = "isolated-fixture-profile";
  const sessionValue = {
    protocol: 1,
    userId: user,
    profileId: profile,
    branchId: branch,
    sessionId: session,
    contextId: context,
    expiresAt: Date.now() + 86400000,
    grantExpiresAt: Date.now() + 86400000,
  };
  const root = "/api/hub/branch/profile/backups/v2";
  beforeAll(async () => {
    if (
      !["localhost", "127.0.0.1"].includes(new URL(url!).hostname) ||
      !new URL(url!).pathname.endsWith("_test")
    )
      throw Error("DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: url });
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({
      connectionString: url,
      max: 6,
      options: "-c search_path=" + schema + ",public",
    });
    await pool.query(
      "CREATE TABLE users(id uuid PRIMARY KEY,email text,normalized_email text);CREATE TABLE links(id uuid PRIMARY KEY);CREATE TABLE sessions(id uuid PRIMARY KEY);CREATE TABLE audit_events(id serial PRIMARY KEY,admin_id uuid,action text,target_type text,target_id text,after jsonb)",
    );
    for (const file of [
      "0009_hub_core.sql",
      "0013_hub_writer_handoff.sql",
      "0015_hub_profile_recovery.sql",
      "0016_hub_profile_policy.sql",
      "0018_hub_stream_budget.sql",
      "0019_hub_profile_delete_refs.sql",
      "0025_hub_backups_v2.sql",
      "0026_hub_backup_catalog_scalability.sql",
    ])
      await pool.query(
        await readFile(
          new URL(
            "../../../packages/database/migrations/" + file,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await provisionBackupCatalogTestIndexes(pool);
    await pool.query("INSERT INTO users VALUES($1,$2,$2)", [
      user,
      "member@example.test",
    ]);
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
    app = Fastify({ logger: false });
    app.setErrorHandler((e: any, _r: any, reply: any) =>
      reply
        .code(e.status || e.statusCode || 500)
        .send({
          error: {
            code: e.code,
            message: e.message,
            ...(e.details ? { details: e.details } : {}),
          },
        }),
    );
    registerHubBackupsV2Routes(app, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
      maintenance: false,
    });
    registerHubLegacyConversionRoutes(app, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
      startWorker: false,
    });
    registerHubProfileRoutes(app, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
    });
    await app.ready();
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE hub_backup_catalog_pages,hub_backup_replicas,hub_backup_parts,hub_backup_jobs,hub_streams,hub_profile_recoveries,hub_profile_chunk_refs,hub_chunks,hub_commits,hub_writers CASCADE",
    );
    await pool.query(
      "UPDATE hub_profiles SET bytes=0,backup_v2_bytes=0,backup_v2_staging_bytes=0,backup_v2_staging_parts=0,backup_v2_migration_credit=0,backup_v1_canonical_bytes=0,backup_v1_staging_bytes=0,backup_v1_staging_chunks=0,backup_accounting_version=1,backup_accounting_epoch=0",
    );
    await pool.query(
      "INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '1 day') ON CONFLICT(id) DO NOTHING",
      [session, user, profile, branch, "1".repeat(64), context],
    );
    await pool.query(
      "UPDATE hub_profile_policy_defaults SET profile_bytes=$1",
      [256 * 1024 * 1024],
    );
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
      await admin.end();
    }
  });
  async function register(seedCheckpointId?: string) {
    const b = {
      replicaId: randomUUID(),
      incarnation: randomUUID(),
      label: "Test Chrome",
      ...(seedCheckpointId ? { seedCheckpointId } : {}),
    };
    const response = await app.inject({
      method: "POST",
      url: root + "/replicas",
      payload: b,
    });
    expect(response.statusCode, response.body).toBe(200);
    return b;
  }
  async function make(
    replica: { replicaId: string; incarnation: string },
    options: {
      sequence?: number;
      parent?: BackupCheckpointV2;
      records?: any[];
      kind?: "baseline" | "delta" | "deleted";
      value?: any;
      cut?: number;
    } = {},
  ) {
    const id = randomUUID(),
      records = options.records || [
        {
          operation: "put",
          store: "items",
          storeEpoch: 0,
          key: { t: "string", v: "save" },
          value: await encodePortableValue(options.value ?? { score: 5 }),
          generation: options.cut || 1,
        },
      ];
    const parts: Buffer[] = [],
      metadata: any[] = [];
    for (const record of options.kind === "deleted" ? [] : records) {
      const raw = Buffer.from(canonicalBackupJson(record)),
        recordId = hash(
          canonicalBackupJson({
            namespace,
            store: record.store,
            key: record.key || null,
            operationKey:
              record.operation === "schema"
                ? "schema"
                : record.operation === "clear-store"
                  ? "clear"
                  : "record",
          }),
        );
      const page = Buffer.from(
        JSON.stringify({
          format: "atlas-record-page-v2",
          namespaceVersionId: id,
          records: [
            {
              recordId,
              index: 0,
              count: 1,
              totalBytes: raw.length,
              sha256: hash(raw),
              data: raw.toString("base64"),
            },
          ],
        }),
      );
      parts.push(page);
      metadata.push({
        ordinal: metadata.length,
        sha256: hash(page),
        bytes: page.length,
      });
    }
    const m: BackupCheckpointV2 = {
      format: "atlas-checkpoint-v2",
      checkpointId: randomUUID(),
      replicaId: replica.replicaId,
      incarnation: replica.incarnation,
      sequence:
        options.sequence || (options.parent ? options.parent.sequence + 1 : 1),
      parentCheckpointId: options.parent?.checkpointId || null,
      adoptedThrough: options.parent?.sequence || 0,
      manifestDigest: "",
      namespaces: [
        {
          namespace,
          namespaceVersionId: id,
          parentNamespaceVersionId:
            options.kind === "delta"
              ? options.parent!.namespaces[0].namespaceVersionId
              : null,
          localCut: options.cut || mCut(options.parent),
          schemaEpoch: 1,
          kind: options.kind || "baseline",
          coverage: "complete-at-cut",
          rootDigest: hash(canonicalBackupJson(metadata)),
          parts: metadata,
        },
      ],
    };
    m.manifestDigest = hash(backupManifestIdentity(m));
    return { m, parts };
  }
  function mCut(p?: BackupCheckpointV2) {
    return p ? p.namespaces[0].localCut + 1 : 1;
  }
  async function prepare(m: BackupCheckpointV2) {
    return app.inject({
      method: "POST",
      url: root + "/replicas/" + m.replicaId + "/checkpoints",
      payload: m,
    });
  }
  async function upload(b: Awaited<ReturnType<typeof make>>) {
    for (const part of b.parts) {
      const r = await app.inject({
        method: "PUT",
        url: root + "/staging/" + b.m.checkpointId + "/parts/" + hash(part),
        headers: { "content-type": "application/octet-stream" },
        payload: part,
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().acknowledged).toBeUndefined();
    }
  }
  async function publish(b: Awaited<ReturnType<typeof make>>) {
    const p = await prepare(b.m);
    expect(p.statusCode, p.body).toBe(200);
    await upload(b);
    const r = await app.inject({
      method: "POST",
      url: root + "/staging/" + b.m.checkpointId + "/publish",
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  it("prepares immutable identity, stages encrypted bytes, ACKs committed publication, resolves lost response, restores paged records", async () => {
    const replica = await register(),
      b = await make(replica);
    const p = await prepare(b.m);
    expect(p.json().missingParts).toHaveLength(1);
    expect(p.json().acknowledged).toBeUndefined();
    await upload(b);
    const state = await app.inject({
      url: root + "/staging/" + b.m.checkpointId,
    });
    expect(state.json().missingParts).toEqual([]);
    const r = await app.inject({
      method: "POST",
      url: root + "/staging/" + b.m.checkpointId + "/publish",
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().acknowledged).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT status,receipt FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
          [b.m.checkpointId],
        )
      ).rows[0],
    ).toMatchObject({ status: "complete", receipt: r.json() });
    expect(
      (
        await app.inject({
          method: "POST",
          url: root + "/staging/" + b.m.checkpointId + "/publish",
        })
      ).json(),
    ).toEqual(r.json());
    const latest = (
      await app.inject({ url: root + "/checkpoints/latest" })
    ).json();
    expect(latest.checkpoint.checkpointId).toBe(b.m.checkpointId);
    const records = await app.inject({
      url:
        root +
        "/namespace-versions/" +
        b.m.namespaces[0].namespaceVersionId +
        "/records",
    });
    expect(records.json().records).toHaveLength(1);
    expect(records.json().nextCursor).toBeNull();
    const bytes = await app.inject({
      url: root + "/parts/" + hash(b.parts[0]),
    });
    expect(bytes.rawPayload).toEqual(b.parts[0]);
    const stored = (
      await pool.query(
        "SELECT encrypted_payload,bytes,published_refs FROM hub_backup_parts",
      )
    ).rows[0];
    expect(stored.encrypted_payload.includes(b.parts[0])).toBe(false);
    expect(Number(stored.published_refs)).toBe(1);
  });
  it("keeps separate replicas independent and orders latest by server publication, not client sequence", async () => {
    const a = await register(),
      b = await register(),
      a1 = await make(a),
      b1 = await make(b),
      receipts = await Promise.all([publish(a1), publish(b1)]);
    const latest = (
      await app.inject({ url: root + "/checkpoints/latest" })
    ).json();
    expect(latest.checkpoint.publicationOrdinal).toBe(
      receipts
        .map((r) => BigInt(r.publicationOrdinal))
        .sort((a, b) => (a < b ? -1 : 1))
        .at(-1)!
        .toString(),
    );
    expect(
      (await app.inject({ url: root + "/checkpoints" })).json().checkpoints,
    ).toHaveLength(2);
  });
  it("rejects competing same-replica preparation and altered prepared identity without changing committed data", async () => {
    const a = await register(),
      first = await make(a),
      second = await make(a);
    const rs = await Promise.all([prepare(first.m), prepare(second.m)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const accepted = rs[0].statusCode === 200 ? first : second,
      changed = structuredClone(accepted.m);
    changed.namespaces[0].localCut++;
    changed.manifestDigest = hash(backupManifestIdentity(changed));
    expect((await prepare(changed)).statusCode).toBe(409);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_checkpoints WHERE status='prepared'",
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("rejects missing/corrupt/oversized parts and invalid portable records without publishing partial data", async () => {
    const a = await register(),
      b = await make(a);
    await prepare(b.m);
    expect(
      (
        await app.inject({
          method: "POST",
          url: root + "/staging/" + b.m.checkpointId + "/publish",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "PUT",
          url:
            root +
            "/staging/" +
            b.m.checkpointId +
            "/parts/" +
            hash(b.parts[0]),
          headers: { "content-type": "application/octet-stream" },
          payload: Buffer.from("bad"),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url:
            root +
            "/staging/" +
            b.m.checkpointId +
            "/parts/" +
            hash(b.parts[0]),
          headers: { "content-type": "application/octet-stream" },
          payload: Buffer.alloc(262145),
        })
      ).statusCode,
    ).toBe(413);
    const cancelled = await app.inject({
      method: "DELETE",
      url: root + "/staging/" + b.m.checkpointId,
    });
    expect(cancelled.statusCode).toBe(200);
    const invalid = await make(a, {
      records: [
        {
          operation: "put",
          store: "items",
          key: { t: "string", v: "save" },
          generation: 1,
          value: { codec: "atlas-portable-v1", root: 50, nodes: [] },
        },
      ],
    });
    await prepare(invalid.m);
    await upload(invalid);
    const result = await app.inject({
      method: "POST",
      url: root + "/staging/" + invalid.m.checkpointId + "/publish",
    });
    expect(result.statusCode).toBe(400);
    expect(
      (await app.inject({ url: root + "/checkpoints/latest" })).json()
        .checkpoint,
    ).toBeNull();
  });
  it("quota failure preserves preparation and committed checkpoint; v1 accounting includes v2 bytes exactly", async () => {
    const a = await register(),
      b = await make(a);
    await publish(b);
    const c = await pool.connect();
    try {
      const usage = await profileUsage(c, profile);
      expect(usage.canonicalBytes).toBe(b.parts[0].length);
    } finally {
      c.release();
    }
    const second = await make(a, {
      parent: b.m,
      kind: "delta",
      value: "changed",
    });
    await prepare(second.m);
    await upload(second);
    await pool.query(
      "INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$1,$5,$6,now()+interval '1 day') ON CONFLICT(id) DO NOTHING",
      [session, user, profile, branch, "1".repeat(64), context],
    );
    await pool.query(
      "UPDATE hub_profile_policy_defaults SET profile_bytes=$1",
      [1048576],
    );
    await pool.query(
      "INSERT INTO hub_streams(profile_id,namespace,bytes) VALUES($1,$2,1048576)",
      [
        profile,
        hubNamespace({ kind: "local", origin: "https://quota-fixture.example" })
          .key,
      ],
    );
    await pool.query("UPDATE hub_profiles SET bytes=$1", [
      1048576 + b.parts[0].length,
    ]);
    const r = await app.inject({
      method: "POST",
      url: root + "/staging/" + second.m.checkpointId + "/publish",
    });
    expect(r.statusCode, r.body).toBe(413);
    expect(r.json().error.code).toBe("BACKUP_QUOTA_EXCEEDED");
    expect(
      (await app.inject({ url: root + "/checkpoints/latest" })).json()
        .checkpoint.checkpointId,
    ).toBe(b.m.checkpointId);
    expect(
      (
        await app.inject({ url: root + "/staging/" + second.m.checkpointId })
      ).json().status,
    ).toBe("prepared");
  });
  it("restores latest key versions, tombstones and store epochs without replaying deleted values", async () => {
    const a = await register(),
      b = await make(a);
    await publish(b);
    const delta = await make(a, {
      parent: b.m,
      kind: "delta",
      records: [
        {
          operation: "delete",
          store: "items",
          key: { t: "string", v: "save" },
          storeEpoch: 0,
          generation: 2,
        },
        {
          operation: "put",
          store: "items",
          key: { t: "string", v: "next" },
          value: await encodePortableValue([1, 2, 3]),
          storeEpoch: 0,
          generation: 2,
        },
      ],
    });
    await publish(delta);
    let records = (
      await app.inject({
        url:
          root +
          "/namespace-versions/" +
          delta.m.namespaces[0].namespaceVersionId +
          "/records",
      })
    ).json().records;
    expect(records).toHaveLength(1);
    const clear = await make(a, {
      parent: delta.m,
      kind: "delta",
      records: [
        {
          operation: "clear-store",
          store: "items",
          storeEpoch: 1,
          generation: 3,
        },
        {
          operation: "put",
          store: "items",
          key: { t: "string", v: "new" },
          value: await encodePortableValue("survives"),
          storeEpoch: 1,
          generation: 3,
        },
      ],
    });
    await publish(clear);
    records = (
      await app.inject({
        url:
          root +
          "/namespace-versions/" +
          clear.m.namespaces[0].namespaceVersionId +
          "/records",
      })
    ).json().records;
    expect(records).toHaveLength(1);
    expect(records[0].storeEpoch).toBe(1);
  });
  it("rolls up long namespace chains using bounded resumable metadata work", async () => {
    const a = await register();
    let b = await make(a);
    await publish(b);
    for (let i = 0; i < 8; i++) {
      b = await make(a, { parent: b.m, kind: "delta", value: i });
      await publish(b);
    }
    const work = await runBackupMaintenanceSlice(pool);
    expect(work).toMatchObject({ worked: true, complete: true });
    expect(
      (
        await pool.query(
          "SELECT materialized_ready,depth FROM hub_backup_namespace_versions WHERE namespace_version_id=$1",
          [b.m.namespaces[0].namespaceVersionId],
        )
      ).rows[0],
    ).toMatchObject({ materialized_ready: true, depth: 0 });
    expect(
      (
        await app.inject({
          url:
            root +
            "/namespace-versions/" +
            b.m.namespaces[0].namespaceVersionId +
            "/records",
        })
      ).json().records,
    ).toHaveLength(1);
  });
  it("requires durable adoption and rejects stale publishers after replica or profile deletion", async () => {
    const a = await register(),
      b = await make(a);
    await publish(b);
    const through = await app.inject({
      method: "POST",
      url: root + "/replicas/" + a.replicaId + "/adopt",
      payload: { adoptedThrough: 1 },
    });
    expect(through.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: root + "/replicas/" + a.replicaId + "/adopt",
          payload: { adoptedThrough: 2 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: root + "/replicas/" + a.replicaId,
        })
      ).statusCode,
    ).toBe(200);
    for (let step = 0; step < 8; step++) await runBackupMaintenanceSlice(pool);
    expect(
      Number(
        (await pool.query("SELECT backup_v2_bytes FROM hub_profiles")).rows[0]
          .backup_v2_bytes,
      ),
    ).toBe(0);
    expect(
      (await app.inject({ url: root + "/checkpoints/latest" })).json()
        .checkpoint,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: root + "/replicas/" + a.replicaId,
        })
      ).statusCode,
    ).toBe(200);
    const second = await make(a, { parent: b.m });
    expect((await prepare(second.m)).json().error.code).toBe(
      "BACKUP_REPLICA_DELETED",
    );
    expect([404, 409]).toContain(
      (
        await app.inject({
          method: "POST",
          url: root + "/staging/" + b.m.checkpointId + "/publish",
        })
      ).statusCode,
    );
  });
  it("bounds account lock contention and releases its own connection", async () => {
    const a = await register(),
      b = await make(a);
    await prepare(b.m);
    const hold = await pool.connect();
    await hold.query("BEGIN");
    await hold.query(
      "SELECT * FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE",
      [profile],
    );
    const started = performance.now();
    const r = await app.inject({
      method: "PUT",
      url: root + "/staging/" + b.m.checkpointId + "/parts/" + hash(b.parts[0]),
      headers: { "content-type": "application/octet-stream" },
      payload: b.parts[0],
    });
    expect(r.statusCode, r.body).toBe(503);
    expect(performance.now() - started).toBeLessThan(1800);
    await hold.query("ROLLBACK");
    hold.release();
    await upload(b);
  });
  it("does not invent an acknowledgement when a transaction is aborted before commit", async () => {
    const controller = new AbortController();
    await expect(
      withBackupTransaction(pool, controller.signal, async (c) => {
        await c.query(
          "INSERT INTO hub_backup_parts(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,1)",
          [profile, "a".repeat(64), Buffer.from("one")],
        );
        controller.abort();
        return { acknowledged: true };
      }),
    ).rejects.toThrow();
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_parts")).rows[0].count,
    ).toBe("0");
  });
  it("keeps every replica latest plus seven daily restore points and prunes only durably adopted history", async () => {
    const a = await register(),
      other = await register();
    let b = await make(a);
    await publish(b);
    const protectedOther = await make(other);
    await publish(protectedOther);
    for (let i = 0; i < 10; i++) {
      await pool.query(
        "UPDATE hub_backup_checkpoints SET history_day=current_date-$2::integer WHERE checkpoint_id=$1",
        [b.m.checkpointId, 10 - i],
      );
      b = await make(a, { parent: b.m, value: i });
      await publish(b);
    }
    const adopted = await app.inject({
      method: "POST",
      url: root + "/replicas/" + a.replicaId + "/adopt",
      payload: { adoptedThrough: b.m.sequence },
    });
    expect(adopted.statusCode).toBe(200);
    for (let step = 0; step < 16; step++) await runBackupMaintenanceSlice(pool);
    const rows = (
      await pool.query(
        "SELECT replica_id,checkpoint_id FROM hub_backup_checkpoints WHERE status='complete'",
      )
    ).rows;
    expect(rows.filter((r) => r.replica_id === a.replicaId)).toHaveLength(8);
    expect(rows.some((r) => r.checkpoint_id === b.m.checkpointId)).toBe(true);
    expect(
      rows.some((r) => r.checkpoint_id === protectedOther.m.checkpointId),
    ).toBe(true);
  });
  it("collects only expired unreferenced staging and retains fresh/resumable uploads", async () => {
    const a = await register(),
      b = await make(a);
    await prepare(b.m);
    await upload(b);
    await pool.query(
      "UPDATE hub_backup_parts SET created_at=now()-interval '2 days'",
    );
    await runBackupMaintenanceSlice(pool);
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_parts")).rows[0].count,
    ).toBe("1");
    await app.inject({
      method: "DELETE",
      url: root + "/staging/" + b.m.checkpointId,
    });
    for (let step = 0; step < 8; step++) await runBackupMaintenanceSlice(pool);
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_parts")).rows[0].count,
    ).toBe("0");
    expect(
      Number(
        (await pool.query("SELECT backup_v2_staging_bytes FROM hub_profiles"))
          .rows[0].backup_v2_staging_bytes,
      ),
    ).toBe(0);
  });
  it("seeds a new replica with completed namespaces without overwriting independent local data", async () => {
    const a = await register(),
      b = await make(a);
    await publish(b);
    const next = await register(b.m.checkpointId);
    const empty = await make(next);
    empty.m.namespaces = [];
    empty.parts = [];
    empty.m.manifestDigest = hash(backupManifestIdentity(empty.m));
    await publish(empty);
    const restored = (
      await app.inject({ url: root + "/checkpoints/" + empty.m.checkpointId })
    ).json();
    expect(restored.checkpoint.namespaces[0].namespaceVersionId).toBe(
      b.m.namespaces[0].namespaceVersionId,
    );
    expect(
      (await pool.query("SELECT published_refs FROM hub_backup_parts")).rows[0]
        .published_refs,
    ).toBe("2");
  });
  it("rejects cut/record-identity tampering and preserves immutable preparation", async () => {
    const a = await register(),
      b = await make(a, {
        records: [
          {
            operation: "put",
            store: "items",
            storeEpoch: 0,
            key: { t: "string", v: "save" },
            value: await encodePortableValue("later"),
            generation: 2,
          },
        ],
        cut: 1,
      });
    await prepare(b.m);
    await upload(b);
    const r = await app.inject({
      method: "POST",
      url: root + "/staging/" + b.m.checkpointId + "/publish",
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(
      (await app.inject({ url: root + "/staging/" + b.m.checkpointId })).json()
        .status,
    ).toBe("prepared");
  });
  it("rejects old profile publishers after cloud profile reset without resurrecting deleted data", async () => {
    const a = await register(),
      b = await make(a);
    await prepare(b.m);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM hub_profiles WHERE id=$1", [profile]);
      // Simulate reset in a committed transaction, then restore fixture after the rejected publisher.
      await c.query("COMMIT");
      const r = await app.inject({
        method: "POST",
        url: root + "/staging/" + b.m.checkpointId + "/publish",
      });
      expect(r.statusCode).toBe(401);
    } finally {
      c.release();
      await pool.query(
        "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,$3,true)",
        [profile, user, encrypt(key, master)],
      );
    }
  });
  it("maintains exact v1/v2 counters transactionally without account aggregate scans", async () => {
    const c = await pool.connect(),
      queries: string[] = [];
    try {
      await c.query(
        "INSERT INTO hub_streams(profile_id,namespace,bytes) VALUES($1,'fixture',10)",
        [profile],
      );
      await c.query(
        "INSERT INTO hub_profile_recoveries(id,profile_id,context_id,namespace,encrypted_payload,payload_hash,bytes) VALUES($1,$2,'context','fixture','fixture',$3,20)",
        [randomUUID(), profile, "0".repeat(64)],
      );
      await c.query(
        "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,'fixture',30)",
        [profile, "f".repeat(64)],
      );
      const tracked = {
        query: (sql: string, ...args: any[]) => {
          queries.push(sql);
          return (c.query as any)(sql, ...args);
        },
      } as any;
      expect(await profileUsage(tracked, profile)).toEqual({
        canonicalBytes: 30,
        stagingBytes: 30,
        stagingChunks: 1,
      });
      expect(queries.some((q) => /sum\(|count\(/i.test(q))).toBe(false);
      await c.query(
        "INSERT INTO hub_profile_chunk_refs VALUES($1,$2,'stream','fixture'),($1,$2,'recovery','fixture')",
        [profile, "f".repeat(64)],
      );
      expect(await profileUsage(c, profile)).toEqual({
        canonicalBytes: 60,
        stagingBytes: 0,
        stagingChunks: 0,
      });
      await c.query(
        "DELETE FROM hub_profile_chunk_refs WHERE owner_kind='stream'",
      );
      expect((await profileUsage(c, profile)).canonicalBytes).toBe(60);
      await c.query("BEGIN");
      await c.query("DELETE FROM hub_profile_chunk_refs");
      expect(await profileUsage(c, profile)).toEqual({
        canonicalBytes: 30,
        stagingBytes: 30,
        stagingChunks: 1,
      });
      await c.query("ROLLBACK");
      expect((await profileUsage(c, profile)).canonicalBytes).toBe(60);
      await c.query("DELETE FROM hub_profile_chunk_refs");
      await c.query("UPDATE hub_chunks SET bytes=40");
      expect((await profileUsage(c, profile)).stagingBytes).toBe(40);
      await c.query("DELETE FROM hub_chunks");
      expect(await profileUsage(c, profile)).toEqual({
        canonicalBytes: 30,
        stagingBytes: 0,
        stagingChunks: 0,
      });
      await c.query("UPDATE hub_streams SET bytes=15");
      await c.query("DELETE FROM hub_profile_recoveries");
      expect((await profileUsage(c, profile)).canonicalBytes).toBe(15);
    } finally {
      c.release();
    }
  });
  it("retires legacy wire commits while preserving new local-first backup authority", async () => {
    const writer = await app.inject({
      method: "POST",
      url: "/api/hub/branch/profile/writers",
      payload: { namespace: { kind: "local", origin: "https://save.example" } },
    });
    expect(writer.statusCode).toBe(410);
    expect(writer.json().error).toMatchObject({
      code: "PROFILE_LEGACY_SYNC_RETIRED",
      retryable: false,
    });
    const a = await register(),
      b = await make(a);
    expect((await publish(b)).acknowledged).toBe(true);
  });
  async function legacy(
    namespace: any,
    value: any,
    revision = 1,
    snapshotRevision = revision,
  ) {
    const graph = JSON.stringify(await encodePortableValue(value)),
      encoded = encrypt(graph, key);
    await pool.query(
      "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes,restore_bytes) VALUES($1,$2,$3,$4,$5,$6::int,$6::bigint)",
      [
        profile,
        hubNamespace(namespace).key,
        revision,
        snapshotRevision,
        encoded,
        Buffer.byteLength(graph),
      ],
    );
    await pool.query("UPDATE hub_profiles SET bytes=backup_v1_canonical_bytes");
    return { encoded, graph };
  }
  async function convertedRecords(checkpointId: string) {
    const state = (
        await app.inject({ url: root + "/checkpoints/" + checkpointId })
      ).json(),
      version = state.checkpoint.namespaces[0],
      page = (
        await app.inject({
          url:
            root +
            "/namespace-versions/" +
            version.namespaceVersionId +
            "/records",
        })
      ).json();
    const result: any[] = [];
    for (const meta of page.records) {
      const buffers = [];
      for (const f of meta.fragments) {
        const p = (
          await app.inject({ url: root + "/parts/" + f.sha256 })
        ).json();
        buffers.push(Buffer.from(p.records[f.index].data, "base64"));
      }
      result.push(JSON.parse(Buffer.concat(buffers).toString("utf8")));
    }
    return result;
  }
  it("converts a pinned completed local snapshot in an isolated bounded process, preserves originals and credits only equivalent bytes", async () => {
    const ns = { kind: "local", origin: "https://legacy.example" },
      original = await legacy(ns, {
        format: "atlas-local-snapshot-v1",
        revision: 1,
        entries: Array.from({ length: 100 }, (_, i) => [
          "key" + i,
          "value" + i,
        ]),
      });
    const hints = (
      await app.inject({ url: root + "/checkpoints/latest" })
    ).json();
    expect(hints.checkpoint).toBeNull();
    expect(hints.legacyNamespaces).toContainEqual(ns);
    const queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace: ns },
      })
    ).json();
    expect(queued.status).toBe("pending");
    const result = await runLegacyConversionJob(pool, master);
    expect(result).toMatchObject({ worked: true, complete: true });
    const job = (
      await app.inject({ url: root + "/legacy-conversions/" + queued.jobId })
    ).json();
    expect(job.status).toBe("complete");
    expect(job.completedCheckpointId).toBeTruthy();
    expect(
      (await pool.query("SELECT encrypted_payload FROM hub_streams")).rows[0]
        .encrypted_payload,
    ).toBe(original.encoded);
    const usage = (
      await pool.query(
        "SELECT backup_v1_canonical_bytes,backup_v2_bytes,backup_v2_migration_credit,bytes FROM hub_profiles",
      )
    ).rows[0];
    expect(Number(usage.backup_v2_migration_credit)).toBeGreaterThan(0);
    expect(Number(usage.bytes)).toBe(
      Math.max(
        Number(usage.backup_v1_canonical_bytes),
        Number(usage.backup_v2_bytes),
      ),
    );
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_parts")).rows[0].count,
    ).toBe("1");
    const before = Number(usage.bytes),
      credit = Number(usage.backup_v2_migration_credit);
    await pool.query("UPDATE hub_streams SET revision=2");
    const changed = (
      await pool.query(
        "SELECT bytes,backup_v2_migration_credit FROM hub_profiles",
      )
    ).rows[0];
    expect(Number(changed.backup_v2_migration_credit)).toBe(0);
    expect(Number(changed.bytes)).toBe(before + credit);
  });
  it("preserves typed IDB values and the captured generator, and adds URL-filterable cookie site metadata", async () => {
    const cycle: any = {
      date: new Date(12345),
      bytes: new Uint8Array([1, 2, 3]),
    };
    cycle.self = cycle;
    await legacy(namespace, {
      format: "atlas-idb-snapshot-v1",
      version: 3,
      stores: [
        {
          name: "items",
          keyPath: null,
          autoIncrement: true,
          generator: { next: 101 },
          indexes: [],
          records: [{ key: 1, value: cycle }],
        },
      ],
    });
    let queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace },
      })
    ).json();
    expect((await runLegacyConversionJob(pool, master)).complete).toBe(true);
    let job = (
        await app.inject({ url: root + "/legacy-conversions/" + queued.jobId })
      ).json(),
      records = await convertedRecords(job.completedCheckpointId),
      header: any = decodePortableValue(
        records.find((r) => r.operation === "schema").value,
      ),
      value: any = decodePortableValue(
        records.find((r) => r.operation === "put").value,
      );
    expect(header.stores[0].generator).toEqual({ next: 101 });
    expect(value.self).toBe(value);
    expect(value.date.getTime()).toBe(12345);
    expect(Array.from(value.bytes)).toEqual([1, 2, 3]);
    const ns = { kind: "cookies", origin: "https://www.cookies.example" },
      cookie = {
        partition: "https://cookies.example",
        domain: "cookies.example",
        hostOnly: true,
        path: "/",
        name: "session",
        value: "private-fixture",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        expires: null,
        sessionId: "prior",
      };
    await legacy(ns, {
      format: "atlas-cookie-snapshot-v1",
      revision: 1,
      cookies: [
        {
          ...cookie,
          id: JSON.stringify([
            cookie.partition,
            cookie.domain,
            cookie.hostOnly,
            cookie.path,
            cookie.name,
          ]),
        },
      ],
    });
    queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace: ns },
      })
    ).json();
    expect((await runLegacyConversionJob(pool, master)).complete).toBe(true);
    job = (
      await app.inject({ url: root + "/legacy-conversions/" + queued.jobId })
    ).json();
    records = await convertedRecords(job.completedCheckpointId);
    expect(
      decodePortableValue(records.find((r) => r.operation === "put").value),
    ).toMatchObject({
      site: "cookies.example",
      httpOnly: true,
      sameSite: "lax",
    });
  });
  it("defers unstable journals, oversized source and missing generator state without altering legacy bytes", async () => {
    const ns = { kind: "local", origin: "https://unstable.example" };
    const original = await legacy(
      ns,
      { format: "atlas-local-snapshot-v1", revision: 1, entries: [] },
      2,
      1,
    );
    let queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace: ns },
      })
    ).json();
    expect(queued.reason).toBe("LEGACY_LIVE_JOURNAL_DEFERRED");
    expect(
      (await pool.query("SELECT encrypted_payload FROM hub_streams")).rows[0]
        .encrypted_payload,
    ).toBe(original.encoded);
    await legacy(namespace, {
      format: "atlas-idb-snapshot-v1",
      version: 1,
      stores: [
        {
          name: "items",
          keyPath: null,
          autoIncrement: true,
          generator: null,
          indexes: [],
          records: [],
        },
      ],
    });
    queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace },
      })
    ).json();
    const result = await runLegacyConversionJob(pool, master);
    expect(result).toMatchObject({
      complete: false,
      reason: "LEGACY_GENERATOR_MISSING",
    });
    expect(
      (
        await app.inject({ url: root + "/legacy-conversions/" + queued.jobId })
      ).json().status,
    ).toBe("deferred");
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_checkpoints WHERE status='complete'",
        )
      ).rows[0].count,
    ).toBe("0");
  });
  it("uses bounded epoch-checked accounting backfill for old profiles and defers their v2 producer until ready", async () => {
    await pool.query(
      "UPDATE hub_profiles SET backup_accounting_version=0,backup_v1_canonical_bytes=0",
    );
    await pool.query(
      "INSERT INTO hub_streams(profile_id,namespace,bytes) SELECT $1,'site-'||n,2 FROM generate_series(1,260)n",
      [profile],
    );
    const a = await register(),
      b = await make(a),
      blocked = await prepare(b.m);
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe("BACKUP_BUSY");
    let result = await runBackupAccountingSlice(pool);
    expect(result).toMatchObject({ worked: true, complete: false });
    expect(
      (await pool.query("SELECT backup_accounting_version FROM hub_profiles"))
        .rows[0].backup_accounting_version,
    ).toBe(0);
    await pool.query("UPDATE hub_streams SET bytes=3 WHERE namespace='site-1'");
    for (let i = 0; i < 10 && !result.complete; i++)
      result = await runBackupAccountingSlice(pool);
    expect(result.complete).toBe(true);
    const c = await pool.connect();
    try {
      expect((await profileUsage(c, profile)).canonicalBytes).toBe(521);
    } finally {
      c.release();
    }
    expect((await prepare(b.m)).statusCode).toBe(200);
  });

  it("converts bounded chunked v1 snapshots with pinned chunks and releases those pins only after completion", async () => {
    const ns = { kind: "local" as const, origin: "https://chunked.example" },
      value = {
        format: "atlas-local-snapshot-v1",
        revision: 1,
        entries: [["save", "from-chunks"]],
      },
      graph = Buffer.from(JSON.stringify(await encodePortableValue(value))),
      chunkHash = hash(graph),
      manifest = {
        codec: "atlas-chunks-v1",
        hashes: [chunkHash],
        bytes: graph.length,
        sha256: chunkHash,
      };
    await pool.query(
      "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,$4)",
      [
        profile,
        chunkHash,
        encrypt(graph.toString("base64"), key),
        graph.length,
      ],
    );
    await pool.query(
      "INSERT INTO hub_profile_chunk_refs VALUES($1,$2,'stream',$3)",
      [profile, chunkHash, hubNamespace(ns).key],
    );
    await pool.query(
      "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes,restore_bytes) VALUES($1,$2,1,1,$3,$4::int,$5::bigint)",
      [
        profile,
        hubNamespace(ns).key,
        encrypt(JSON.stringify(manifest), key),
        Buffer.byteLength(JSON.stringify(manifest)),
        graph.length,
      ],
    );
    await pool.query("UPDATE hub_profiles SET bytes=backup_v1_canonical_bytes");
    const queued = (
        await app.inject({
          method: "POST",
          url: root + "/legacy-conversions",
          payload: { namespace: ns },
        })
      ).json(),
      result = await runLegacyConversionJob(pool, master);
    expect(result).toMatchObject({ worked: true, complete: true });
    expect(
      (
        await app.inject({ url: root + "/legacy-conversions/" + queued.jobId })
      ).json().status,
    ).toBe("complete");
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_legacy_chunk_pins"))
        .rows[0].count,
    ).toBe("0");
    expect(
      (await pool.query("SELECT backup_conversion_pins FROM hub_chunks"))
        .rows[0].backup_conversion_pins,
    ).toBe(0);
    expect(
      Number(
        (
          await pool.query(
            "SELECT backup_conversion_staging_bytes FROM hub_profiles",
          )
        ).rows[0].backup_conversion_staging_bytes,
      ),
    ).toBe(0);
  });
  it("fences a changed pinned source during isolated conversion and preserves the newer v1 state", async () => {
    const ns = { kind: "local", origin: "https://changed.example" };
    await legacy(ns, {
      format: "atlas-local-snapshot-v1",
      revision: 1,
      entries: [["save", "old"]],
    });
    await app.inject({
      method: "POST",
      url: root + "/legacy-conversions",
      payload: { namespace: ns },
    });
    const conversion = runLegacyConversionJob(pool, master);
    await new Promise((r) => setTimeout(r, 10));
    await pool.query("UPDATE hub_streams SET revision=2");
    const result = await conversion;
    expect(result.complete).toBe(false);
    expect(
      (await pool.query("SELECT revision FROM hub_streams")).rows[0].revision,
    ).toBe("2");
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_checkpoints WHERE status='complete'",
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      Number(
        (
          await pool.query(
            "SELECT backup_conversion_staging_bytes FROM hub_profiles",
          )
        ).rows[0].backup_conversion_staging_bytes,
      ),
    ).toBe(0);
  });
  it("deletes an account profile containing completed conversion aliases and pending immutable pins atomically", async () => {
    const ns = { kind: "local", origin: "https://delete-converted.example" };
    await legacy(ns, {
      format: "atlas-local-snapshot-v1",
      revision: 1,
      entries: [["save", "old"]],
    });
    await app.inject({
      method: "POST",
      url: root + "/legacy-conversions",
      payload: { namespace: ns },
    });
    expect((await runLegacyConversionJob(pool, master)).complete).toBe(true);
    await pool.query("DELETE FROM hub_profiles WHERE id=$1", [profile]);
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_migration_aliases"))
        .rows[0].count,
    ).toBe("0");
    expect(
      (await app.inject({ url: root + "/checkpoints/latest" })).statusCode,
    ).toBe(401);
    await pool.query(
      "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,$3,true)",
      [profile, user, encrypt(key, master)],
    );
  });
  it("releases conversion credit together with deleted equivalent v2 refs and never undercharges surviving v1 data", async () => {
    const ns = { kind: "local", origin: "https://credit-delete.example" };
    await legacy(ns, {
      format: "atlas-local-snapshot-v1",
      revision: 1,
      entries: [["save", "original"]],
    });
    const queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace: ns },
      })
    ).json();
    expect((await runLegacyConversionJob(pool, master)).complete).toBe(true);
    const cp = (
      await app.inject({
        url:
          root +
          "/checkpoints/" +
          (
            await app.inject({
              url: root + "/legacy-conversions/" + queued.jobId,
            })
          ).json().completedCheckpointId,
      })
    ).json().checkpoint;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: root + "/replicas/" + cp.replicaId,
        })
      ).statusCode,
    ).toBe(200);
    let usage = (
      await pool.query(
        "SELECT bytes,backup_v1_canonical_bytes,backup_v2_bytes,backup_v2_migration_credit FROM hub_profiles",
      )
    ).rows[0];
    expect(Number(usage.backup_v2_migration_credit)).toBe(0);
    expect(Number(usage.backup_v2_bytes)).toBe(0);
    expect(Number(usage.bytes)).toBe(Number(usage.backup_v1_canonical_bytes));
    await pool.query("UPDATE hub_streams SET revision=2");
    usage = (
      await pool.query(
        "SELECT bytes,backup_v1_canonical_bytes FROM hub_profiles",
      )
    ).rows[0];
    expect(Number(usage.bytes)).toBe(Number(usage.backup_v1_canonical_bytes));
  });
  it("pins inherited prepared and registered-seed parts across deletion and GC before atomic publication", async () => {
    const a = await register(),
      baseline = await make(a);
    await publish(baseline);
    const b = await register(baseline.m.checkpointId),
      prepared = await make(b);
    prepared.m.namespaces = [];
    prepared.parts = [];
    prepared.m.manifestDigest = hash(backupManifestIdentity(prepared.m));
    expect((await prepare(prepared.m)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: root + "/replicas/" + a.replicaId,
        })
      ).statusCode,
    ).toBe(200);
    await pool.query(
      "UPDATE hub_backup_parts SET created_at=now()-interval '2 days'",
    );
    await runBackupMaintenanceSlice(pool);
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_parts")).rows[0].count,
    ).toBe("1");
    const result = await app.inject({
      method: "POST",
      url: root + "/staging/" + prepared.m.checkpointId + "/publish",
    });
    expect(result.statusCode, result.body).toBe(200);
    const records = (
      await app.inject({
        url:
          root +
          "/namespace-versions/" +
          baseline.m.namespaces[0].namespaceVersionId +
          "/records",
      })
    ).json().records;
    expect(records).toHaveLength(1);
    expect(
      (
        await app.inject({
          url: root + "/parts/" + records[0].fragments[0].sha256,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("keeps restore readable and returns typed deferred publication while the operational rollback flag is enabled", async () => {
    const a = await register(),
      b = await make(a);
    await publish(b);
    const next = await make(a, { parent: b.m }),
      paused = Fastify();
    paused.setErrorHandler((e: any, _r: any, reply: any) =>
      reply
        .code(e.status || 500)
        .send({
          error: {
            code: e.code,
            message: e.message,
            ...(e.details ? { details: e.details } : {}),
          },
        }),
    );
    registerHubBackupsV2Routes(paused, {
      pool,
      identity: { authenticate: async () => sessionValue } as any,
      encryptionKey: master,
      maintenance: false,
      publicationDisabled: true,
    });
    await paused.ready();
    try {
      expect(
        (await paused.inject({ url: root + "/capabilities" })).json()
          .publicationEnabled,
      ).toBe(false);
      expect(
        (await paused.inject({ url: root + "/checkpoints/latest" })).json()
          .checkpoint.checkpointId,
      ).toBe(b.m.checkpointId);
      expect(
        (await paused.inject({ url: root + "/parts/" + hash(b.parts[0]) }))
          .rawPayload,
      ).toEqual(b.parts[0]);
      const denied = await paused.inject({
        method: "POST",
        url: root + "/replicas/" + a.replicaId + "/checkpoints",
        payload: next.m,
      });
      expect(denied.statusCode).toBe(503);
      expect(denied.json().error.code).toBe("BACKUP_BUSY");
    } finally {
      await paused.close();
    }
    expect((await prepare(next.m)).statusCode).toBe(200);
  });

  it("explicitly defers shared legacy chunk lineage rather than double-charging format conversion", async () => {
    const value = {
        format: "atlas-local-snapshot-v1",
        revision: 1,
        entries: [["save", "shared"]],
      },
      graph = Buffer.from(JSON.stringify(await encodePortableValue(value))),
      chunkHash = hash(graph),
      manifest = JSON.stringify({
        codec: "atlas-chunks-v1",
        hashes: [chunkHash],
        bytes: graph.length,
        sha256: chunkHash,
      });
    await pool.query(
      "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes) VALUES($1,$2,$3,$4)",
      [
        profile,
        chunkHash,
        encrypt(graph.toString("base64"), key),
        graph.length,
      ],
    );
    const namespaces = [
      { kind: "local" as const, origin: "https://shared-a.example" },
      { kind: "local" as const, origin: "https://shared-b.example" },
    ];
    for (const ns of namespaces) {
      await pool.query(
        "INSERT INTO hub_profile_chunk_refs VALUES($1,$2,'stream',$3)",
        [profile, chunkHash, hubNamespace(ns).key],
      );
      await pool.query(
        "INSERT INTO hub_streams(profile_id,namespace,revision,snapshot_revision,encrypted_payload,bytes,restore_bytes) VALUES($1,$2,1,1,$3,$4::int,$5::bigint)",
        [
          profile,
          hubNamespace(ns).key,
          encrypt(manifest, key),
          Buffer.byteLength(manifest),
          graph.length,
        ],
      );
    }
    await pool.query("UPDATE hub_profiles SET bytes=backup_v1_canonical_bytes");
    await app.inject({
      method: "POST",
      url: root + "/legacy-conversions",
      payload: { namespace: namespaces[0] },
    });
    expect(await runLegacyConversionJob(pool, master)).toMatchObject({
      worked: true,
      complete: false,
      reason: "LEGACY_SHARED_CHUNK_DEFERRED",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_checkpoints WHERE status='complete'",
        )
      ).rows[0].count,
    ).toBe("0");
    expect(
      Number(
        (
          await pool.query(
            "SELECT backup_v2_migration_credit FROM hub_profiles",
          )
        ).rows[0].backup_v2_migration_credit,
      ),
    ).toBe(0);
  });
  it("preserves valid deeply nested keys and rejects noncanonical fractional date keys before acknowledgement", async () => {
    const a = await register();
    let key: any = { t: "string", v: "deep" };
    for (let i = 0; i < 40; i++) key = { t: "array", v: [key] };
    const b = await make(a, {
      records: [
        {
          operation: "put",
          store: "items",
          storeEpoch: 0,
          key,
          value: await encodePortableValue("deep-key"),
          generation: 1,
        },
      ],
    });
    await publish(b);
    const malformed = await make(a, {
      parent: b.m,
      kind: "delta",
      records: [
        {
          operation: "put",
          store: "items",
          storeEpoch: 0,
          key: { t: "date", v: "1.2" },
          value: await encodePortableValue("bad-date"),
          generation: 2,
        },
      ],
    });
    await prepare(malformed.m);
    await upload(malformed);
    expect(
      (
        await app.inject({
          method: "POST",
          url: root + "/staging/" + malformed.m.checkpointId + "/publish",
        })
      ).statusCode,
    ).toBe(400);
  });
  it("reactivates exact format-equivalence credit when an inherited completed root takes over the same retained parts", async () => {
    const ns = { kind: "local", origin: "https://credit-seed.example" };
    await legacy(ns, {
      format: "atlas-local-snapshot-v1",
      revision: 1,
      entries: [["save", "original"]],
    });
    const queued = (
      await app.inject({
        method: "POST",
        url: root + "/legacy-conversions",
        payload: { namespace: ns },
      })
    ).json();
    await runLegacyConversionJob(pool, master);
    const cp = (
      await app.inject({
        url:
          root +
          "/checkpoints/" +
          (
            await app.inject({
              url: root + "/legacy-conversions/" + queued.jobId,
            })
          ).json().completedCheckpointId,
      })
    ).json().checkpoint;
    const b = await register(cp.checkpointId),
      next = await make(b);
    next.m.namespaces = [];
    next.parts = [];
    next.m.manifestDigest = hash(backupManifestIdentity(next.m));
    expect((await prepare(next.m)).statusCode).toBe(200);
    await app.inject({
      method: "DELETE",
      url: root + "/replicas/" + cp.replicaId,
    });
    expect(
      Number(
        (
          await pool.query(
            "SELECT backup_v2_migration_credit FROM hub_profiles",
          )
        ).rows[0].backup_v2_migration_credit,
      ),
    ).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: root + "/staging/" + next.m.checkpointId + "/publish",
        })
      ).statusCode,
    ).toBe(200);
    const p = (
      await pool.query(
        "SELECT bytes,backup_v1_canonical_bytes,backup_v2_bytes,backup_v2_migration_credit FROM hub_profiles",
      )
    ).rows[0];
    expect(Number(p.backup_v2_migration_credit)).toBeGreaterThan(0);
    expect(Number(p.bytes)).toBe(
      Math.max(Number(p.backup_v1_canonical_bytes), Number(p.backup_v2_bytes)),
    );
  });
  async function activationProfile(id: string, active = true) {
    const owner = randomUUID();
    await pool.query("INSERT INTO users VALUES($1,$2,$2)", [
      owner,
      owner + "@fixture.test",
    ]);
    await pool.query(
      "INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized,backup_accounting_version,chunk_accounting_version) VALUES($1,$2,$3,true,0,1)",
      [id, owner, encrypt(key, master)],
    );
    if (active)
      await pool.query(
        "INSERT INTO hub_backup_replicas(profile_id,replica_id,incarnation,branch_id,origin,label) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          randomUUID(),
          randomUUID(),
          branch,
          "https://branch.example",
          "activation fixture",
        ],
      );
    return { profileId: id, owner };
  }
  it("prioritizes registered v2 publishers and completes small old profiles without sweeping unrelated legacy accounts", async () => {
    const legacyOnly = await activationProfile(
        "00000000-0000-4000-8000-000000000010",
        false,
      ),
      ready = await activationProfile("00000000-0000-4000-8000-000000000020");
    try {
      for (const p of [legacyOnly, ready])
        await pool.query(
          "INSERT INTO hub_streams(profile_id,namespace,bytes) VALUES($1,'activation-source',7)",
          [p.profileId],
        );
      const result = await runBackupAccountingActivation(pool, {
        maxProfiles: 1,
      });
      expect(result).toMatchObject({
        profiles: 1,
        completedProfiles: 1,
        slices: 3,
      });
      const rows = (
        await pool.query(
          "SELECT id,backup_accounting_version,backup_v1_canonical_bytes FROM hub_profiles WHERE id=ANY($1::uuid[])",
          [[legacyOnly.profileId, ready.profileId]],
        )
      ).rows;
      expect(rows.find((r) => r.id === ready.profileId)).toMatchObject({
        backup_accounting_version: 1,
        backup_v1_canonical_bytes: "7",
      });
      expect(
        rows.find((r) => r.id === legacyOnly.profileId)
          .backup_accounting_version,
      ).toBe(0);
    } finally {
      await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
        [legacyOnly.owner, ready.owner],
      ]);
    }
  });
  it("visits an impossible active profile once and fairly activates the next publisher in the same bounded burst", async () => {
    const deferred = await activationProfile(
        "00000000-0000-4000-8000-000000000030",
      ),
      ready = await activationProfile("00000000-0000-4000-8000-000000000040");
    try {
      await pool.query(
        "UPDATE hub_profiles SET chunk_accounting_version=0 WHERE id=$1",
        [deferred.profileId],
      );
      await pool.query(
        "INSERT INTO hub_chunks(profile_id,hash,encrypted_payload,bytes,backup_reference_count) VALUES($1,$2,'fixture',1,-1)",
        [deferred.profileId, "e".repeat(64)],
      );
      const result = await runBackupAccountingActivation(pool, {
        maxProfiles: 16,
      });
      expect(result).toMatchObject({
        profiles: 2,
        deferredProfiles: 1,
        completedProfiles: 1,
        slices: 4,
      });
      expect(
        (
          await pool.query(
            "SELECT backup_accounting_version FROM hub_profiles WHERE id=$1",
            [deferred.profileId],
          )
        ).rows[0].backup_accounting_version,
      ).toBe(0);
    } finally {
      await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
        [deferred.owner, ready.owner],
      ]);
    }
  });
  it("caps slices per active profile and releases the profile lock/client between every committed slice", async () => {
    const target = await activationProfile(
      "00000000-0000-4000-8000-000000000050",
    );
    try {
      await pool.query(
        "INSERT INTO hub_streams(profile_id,namespace,bytes) SELECT $1,'source-'||n,1 FROM generate_series(1,260)n",
        [target.profileId],
      );
      let observed = 0;
      const result = await runBackupAccountingActivation(pool, {
        maxProfiles: 1,
        maxSlicesPerProfile: 2,
        afterSlice: async (id) => {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query("SET LOCAL lock_timeout='25ms'");
            await c.query(
              "UPDATE hub_profiles SET initialized=initialized WHERE id=$1",
              [id],
            );
            await c.query("ROLLBACK");
            observed++;
          } finally {
            c.release();
          }
        },
      });
      expect(result).toMatchObject({
        profiles: 1,
        slices: 2,
        completedProfiles: 0,
      });
      expect(observed).toBe(2);
      expect(
        (
          await pool.query(
            "SELECT backup_accounting_version FROM hub_profiles WHERE id=$1",
            [target.profileId],
          )
        ).rows[0].backup_accounting_version,
      ).toBe(0);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1", [target.owner]);
    }
  });
  it("bounds activation acquisition by the whole burst deadline and releases a late-assigned queued client", async () => {
    const blocked = new Pool({
        connectionString: url,
        max: 1,
        options: "-c search_path=" + schema + ",public",
      }),
      held = await blocked.connect();
    try {
      const start = performance.now(),
        result = await runBackupAccountingActivation(blocked, { budgetMs: 50 });
      expect(result.budgetExhausted).toBe(true);
      expect(performance.now() - start).toBeLessThan(250);
    } finally {
      held.release();
    }
    try {
      expect((await blocked.query("SELECT 1 answer")).rows[0].answer).toBe(1);
      expect(blocked.waitingCount).toBe(0);
    } finally {
      await blocked.end();
    }
  });
});
