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
  publishPreparedBackupV2,
  collectBackupGarbageSlice,
  resolvedCTE,
} from "./hubBackupsV2.js";
import { prepareBackupCatalog } from "./hubBackupsV2Catalog.js";
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
run("Persistent COW catalog — isolated PostgreSQL, no deployment", () => {
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
  function tombstone(
    replica: any,
    parent: BackupCheckpointV2 | undefined,
    indices: number[],
  ): BackupCheckpointV2 {
    const m: BackupCheckpointV2 = {
      format: "atlas-checkpoint-v2",
      checkpointId: randomUUID(),
      replicaId: replica.replicaId,
      incarnation: replica.incarnation,
      sequence: (parent?.sequence || 0) + 1,
      parentCheckpointId: parent?.checkpointId || null,
      adoptedThrough: parent?.sequence || 0,
      manifestDigest: "",
      namespaces: indices.map((i) => ({
        namespace: {
          kind: "local",
          origin: "https://n" + String(i).padStart(4, "0") + ".many.example",
        },
        namespaceVersionId: randomUUID(),
        parentNamespaceVersionId: null,
        kind: "baseline" as const,
        localCut: (parent?.sequence || 0) + 1,
        schemaEpoch: 1,
        parts: [],
        rootDigest: hash("[]"),
        coverage: "complete-at-cut" as const,
      })),
    };
    m.manifestDigest = hash(backupManifestIdentity(m));
    return m;
  }
  async function publishManifest(m: BackupCheckpointV2) {
    return publish({ m, parts: [] });
  }
  async function pages(id: string) {
    let cursor: string | undefined,
      namespaces: any[] = [],
      rootDigest: string | undefined;
    do {
      const r = await app.inject({
        url:
          root +
          "/checkpoints/" +
          id +
          "/namespaces" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(65536);
      const p = r.json();
      expect(p.checkpointId).toBe(id);
      expect(p.namespaces.length).toBeLessThanOrEqual(32);
      if (rootDigest) expect(p.rootDigest).toBe(rootDigest);
      rootDigest = p.rootDigest;
      namespaces.push(...p.namespaces);
      cursor = p.nextCursor;
    } while (cursor);
    return namespaces;
  }
  it("qualifies65/256/1024 namespaces, shares unaffected immutable leaves, pages exact metadata and rejects mixed cursors", async () => {
    const replica = await register();
    let parent: BackupCheckpointV2 | undefined;
    for (let at = 0; at < 1024; ) {
      const count = Math.min(64, 1024 - at);
      const m = tombstone(
        replica,
        parent,
        Array.from({ length: count }, (_, i) => at + i),
      );
      await publishManifest(m);
      parent = m;
      at += count;
      if ([256, 1024].includes(at)) {
        const header = await app.inject({
          url: root + "/checkpoints/latest?catalog=paged",
        });
        expect(header.statusCode, header.body).toBe(200);
        expect(header.json().checkpoint.namespaces).toBeUndefined();
        expect(header.json().catalog.namespaceCount).toBe(at);
        expect((await pages(m.checkpointId)).length).toBe(at);
        expect(
          (await app.inject({ url: root + "/checkpoints/" + m.checkpointId }))
            .statusCode,
        ).toBe(426);
      }
    }
    const original = parent!,
      before = (
        await pool.query(
          "SELECT page_id FROM hub_backup_catalog_root_pages WHERE checkpoint_id=$1",
          [original.checkpointId],
        )
      ).rows.map((r) => r.page_id);
    const next = tombstone(replica, parent, [500]);
    await publishManifest(next);
    const after = (
      await pool.query(
        "SELECT page_id FROM hub_backup_catalog_root_pages WHERE checkpoint_id=$1",
        [next.checkpointId],
      )
    ).rows.map((r) => r.page_id);
    expect(after.filter((id) => before.includes(id))).toHaveLength(
      before.length - 1,
    );
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM hub_backup_catalog_entries WHERE page_id=ANY($1::uuid[])",
            [after.filter((id) => !before.includes(id))],
          )
        ).rows[0].count,
      ),
    ).toBeLessThanOrEqual(64);
    expect((await pages(next.checkpointId)).length).toBe(1024);
    const first = (
      await app.inject({
        url: root + "/checkpoints/" + original.checkpointId + "/namespaces",
      })
    ).json();
    expect(
      (
        await app.inject({
          url:
            root +
            "/checkpoints/" +
            next.checkpointId +
            "/namespaces?cursor=" +
            encodeURIComponent(first.nextCursor),
        })
      ).statusCode,
    ).toBe(400);
    const beyond = tombstone(replica, next, [1024]);
    expect((await prepare(beyond)).statusCode).toBe(200);
    const rejected = await app.inject({
      method: "POST",
      url: root + "/staging/" + beyond.checkpointId + "/publish",
    });
    expect(rejected.statusCode, rejected.body).toBe(413);
    expect(rejected.json().error.code).toBe("BACKUP_CATALOG_FULL");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: root + "/staging/" + beyond.checkpointId,
        })
      ).statusCode,
    ).toBe(200);
    const update = tombstone(replica, next, [0]);
    await publishManifest(update);
    expect((await pages(update.checkpointId)).length).toBe(1024);
    const small = await register(),
      a = tombstone(
        small,
        undefined,
        Array.from({ length: 64 }, (_, i) => i),
      );
    await publishManifest(a);
    const b = tombstone(small, a, [64]);
    await publishManifest(b);
    expect((await pages(b.checkpointId)).length).toBe(65);
  }, 30000);
  it("keeps parent parts pinned during preparation/retirement and bounds new-parts activation", async () => {
    const a = await register(),
      first = await make(a);
    await publish(first);
    const b = await register(first.m.checkpointId),
      next = tombstone(b, undefined, [1]);
    await prepare(next);
    await app.inject({
      method: "DELETE",
      url: root + "/replicas/" + a.replicaId,
    });
    for (let i = 0; i < 6; i++) await runBackupMaintenanceSlice(pool);
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_parts")).rows[0].count,
    ).toBe("1");
    const result = await app.inject({
      method: "POST",
      url: root + "/staging/" + next.checkpointId + "/publish",
    });
    expect(result.statusCode, result.body).toBe(200);
    expect((await pages(next.checkpointId)).length).toBe(2);
    expect(
      Number(
        (await pool.query("SELECT backup_v2_bytes FROM hub_profiles")).rows[0]
          .backup_v2_bytes,
      ),
    ).toBe(first.parts[0].length);
    expect(
      (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
        .rawPayload,
    ).toEqual(first.parts[0]);
    for (let i = 0; i < 8; i++) await runBackupMaintenanceSlice(pool);
    expect(
      (await app.inject({ url: root + "/parts/" + hash(first.parts[0]) }))
        .statusCode,
    ).toBe(200);
  });
  it("bounds HTTP bulk admission and preserves Retry-After while account-lock contenders defer", async () => {
    const a = await register(),
      b = await make(a);
    await prepare(b.m);
    const locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query(
      "SELECT 1 FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE",
      [profile],
    );
    try {
      const responses = await Promise.all(
        Array.from({ length: 14 }, () =>
          app.inject({
            method: "PUT",
            url:
              root +
              "/staging/" +
              b.m.checkpointId +
              "/parts/" +
              hash(b.parts[0]),
            headers: { "content-type": "application/octet-stream" },
            payload: b.parts[0],
          }),
        ),
      );
      expect(responses.some((r) => r.statusCode === 429)).toBe(true);
      for (const r of responses) {
        expect([429, 503]).toContain(r.statusCode);
        if (r.statusCode === 429) expect(r.headers["retry-after"]).toBe("2");
      }
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    await upload(b);
    const done = await app.inject({
      method: "POST",
      url: root + "/staging/" + b.m.checkpointId + "/publish",
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().acknowledged).toBe(true);
  });
  it("preserves account deletion with completed roots, shared leaves and prepared parent pins", async () => {
    const a = await register(),
      first = tombstone(a, undefined, [0]);
    await publishManifest(first);
    const b = await register(first.checkpointId),
      pending = tombstone(b, undefined, [1]);
    await prepare(pending);
    await expect(
      pool.query("DELETE FROM hub_profiles WHERE id=$1", [profile]),
    ).resolves.toBeDefined();
    expect(
      (await pool.query("SELECT count(*) FROM hub_backup_catalog_pages"))
        .rows[0].count,
    ).toBe("0");
    // Restore only the isolated test profile for the afterEach fixture contract.
    await pool.query(
      "INSERT INTO hub_profiles(id,user_id,encrypted_key,backup_accounting_version) VALUES($1,$2,$3,1)",
      [profile, user, encrypt(key, master)],
    );
  });
  async function assertExactBytes() {
    const p = (await pool.query("SELECT * FROM hub_profiles")).rows[0],
      b = (
        await pool.query(
          "SELECT COALESCE(sum(bytes) FILTER(WHERE published_refs>0),0) canonical,COALESCE(sum(bytes) FILTER(WHERE published_refs=0),0) staged,count(*) FILTER(WHERE published_refs=0) parts FROM hub_backup_parts",
        )
      ).rows[0];
    expect(Number(p.backup_v2_bytes)).toBe(Number(b.canonical));
    expect(Number(p.backup_v2_staging_bytes)).toBe(Number(b.staged));
    expect(Number(p.backup_v2_staging_parts)).toBe(Number(b.parts));
    expect(Number(p.bytes)).toBe(
      Number(p.backup_v1_canonical_bytes) +
        Math.max(0, Number(b.canonical) - Number(p.backup_v2_migration_credit)),
    );
  }
  it("prunes oldest eligible history under quota pressure in bounded background steps, then resumes the exact publication", async () => {
    const a = await register();
    await pool.query(
      "UPDATE hub_profile_policy_defaults SET profile_bytes=1048576",
    );
    let b: Awaited<ReturnType<typeof make>> | undefined;
    const old: string[] = [];
    for (let i = 0; i < 5; i++) {
      const next = await make(a, {
        parent: b?.m,
        value: String(i).repeat(140000),
      });
      await publish(next);
      old.push(next.m.checkpointId);
      await pool.query(
        "UPDATE hub_backup_checkpoints SET history_day=current_date-$2::integer WHERE checkpoint_id=$1",
        [next.m.checkpointId, 5 - i],
      );
      b = next;
    }
    await app.inject({
      method: "POST",
      url: root + "/replicas/" + a.replicaId + "/adopt",
      payload: { adoptedThrough: b!.m.sequence },
    });
    const next = await make(a, { parent: b!.m, value: "n".repeat(140000) });
    await prepare(next.m);
    await upload(next);
    const deferred = await app.inject({
      method: "POST",
      url: root + "/staging/" + next.m.checkpointId + "/publish",
    });
    expect(deferred.statusCode, deferred.body).toBe(503);
    expect(deferred.json().error.code).toBe("BACKUP_BUSY");
    expect(
      (
        await pool.query(
          "SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
          [next.m.checkpointId],
        )
      ).rows[0].status,
    ).toBe("prepared");
    for (let step = 0; step < 5; step++)
      await withBackupTransaction(pool, new AbortController().signal, (c) =>
        collectBackupGarbageSlice(c, pool, { profileId: profile }),
      );
    const done = await app.inject({
      method: "POST",
      url: root + "/staging/" + next.m.checkpointId + "/publish",
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().checkpointId).toBe(next.m.checkpointId);
    expect(done.json().manifestDigest).toBe(next.m.manifestDigest);
    expect(
      (
        await pool.query(
          "SELECT checkpoint_id FROM hub_backup_checkpoints WHERE checkpoint_id=ANY($1::uuid[]) AND status='complete'",
          [old.slice(1)],
        )
      ).rows,
    ).toHaveLength(4);
    await assertExactBytes();
    expect(
      Number(
        (await pool.query("SELECT bytes FROM hub_profiles")).rows[0].bytes,
      ),
    ).toBeLessThanOrEqual(1048576);
  });
  it("coalesces concurrent publication identities and independent replicas without duplicate references or ordinals", async () => {
    const a = await register(),
      first = await make(a);
    await prepare(first.m);
    await upload(first);
    const both = await Promise.all([
      app.inject({
        method: "POST",
        url: root + "/staging/" + first.m.checkpointId + "/publish",
      }),
      app.inject({
        method: "POST",
        url: root + "/staging/" + first.m.checkpointId + "/publish",
      }),
    ]);
    for (const r of both) expect(r.statusCode, r.body).toBe(200);
    expect(both[0].json()).toEqual(both[1].json());
    expect(
      (await pool.query("SELECT published_refs FROM hub_backup_parts")).rows[0]
        .published_refs,
    ).toBe("1");
    const b = await register(),
      second = await make(b);
    await publish(second);
    await assertExactBytes();
    const latest = (
      await app.inject({ url: root + "/checkpoints/latest?catalog=paged" })
    ).json();
    expect(latest.checkpoint.checkpointId).toBe(second.m.checkpointId);
  });
  it("recovers a genuinely committed publication after its COMMIT response is lost, with no duplicate quota or acknowledgement", async () => {
    const a = await register(),
      b = await make(a);
    await prepare(b.m);
    await upload(b);
    let lost = true,
      inPublication = false;
    const lockedSql: string[] = [];
    const faulty = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, k) {
            if (k === "query")
              return async (...args: any[]) => {
                const text = String(args[0]);
                if (
                  text.includes("SELECT * FROM hub_profiles") &&
                  text.includes("FOR NO KEY UPDATE")
                )
                  inPublication = true;
                if (inPublication) lockedSql.push(text);
                const result = await (target.query as any)(...args);
                if (text === "COMMIT" && inPublication) {
                  inPublication = false;
                  if (lost) {
                    lost = false;
                    throw Object.assign(
                      Error("COMMIT receipt lost after SQL durability"),
                      { code: "ECONNRESET" },
                    );
                  }
                }
                return result;
              };
            const v = Reflect.get(target, k, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    } as unknown as Pool;
    await expect(
      publishPreparedBackupV2(
        { pool: faulty, encryptionKey: master },
        sessionValue as any,
        b.m.checkpointId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("COMMIT receipt lost");
    const stored = (
      await pool.query(
        "SELECT status,receipt FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
        [b.m.checkpointId],
      )
    ).rows[0];
    expect(stored.status).toBe("complete");
    expect(stored.receipt.acknowledged).toBe(true);
    expect(
      lockedSql.some((q) =>
        /hub_backup_catalog_entries|hub_backup_catalog_namespace_refs|hub_backup_namespace_parts/.test(
          q,
        ),
      ),
    ).toBe(false);
    const recovered = await app.inject({
      method: "POST",
      url: root + "/staging/" + b.m.checkpointId + "/publish",
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toEqual(stored.receipt);
    await assertExactBytes();
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM hub_backup_checkpoints WHERE receipt IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("prepares inherited roots and part pins while another transaction holds the account quota row", async () => {
    const a = await register(),
      first = await make(a);
    await publish(first);
    const next = tombstone(a, first.m, [10]);
    await prepare(next);
    const locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query(
      "SELECT 1 FROM hub_profiles WHERE id=$1 FOR NO KEY UPDATE",
      [profile],
    );
    try {
      await expect(
        prepareBackupCatalog(
          (work) =>
            withBackupTransaction(pool, new AbortController().signal, work),
          profile,
          next.checkpointId,
          resolvedCTE,
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined();
      expect(
        (
          await pool.query(
            "SELECT catalog_ready FROM hub_backup_checkpoints WHERE checkpoint_id=$1",
            [next.checkpointId],
          )
        ).rows[0].catalog_ready,
      ).toBe(true);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    await assertExactBytes();
  });
  it("frees deleted catalog slots, rebalances leaves, and reports exact rejected additions with cancellable identity", async () => {
    const a = await register();
    let parent: BackupCheckpointV2 | undefined;
    for (let at = 0; at < 1024; at += 64) {
      const m = tombstone(
        a,
        parent,
        Array.from({ length: 64 }, (_, i) => at + i),
      );
      await publishManifest(m);
      parent = m;
    }
    const rejected = tombstone(a, parent, [1024]);
    await prepare(rejected);
    const fail = await app.inject({
      method: "POST",
      url: root + "/staging/" + rejected.checkpointId + "/publish",
    });
    expect(fail.statusCode).toBe(413);
    expect(fail.json().error.details).toEqual({
      checkpointId: rejected.checkpointId,
      manifestDigest: rejected.manifestDigest,
      rejectedNamespaceVersionIds: [rejected.namespaces[0].namespaceVersionId],
    });
    const cancel = await app.inject({
      method: "DELETE",
      url: root + "/staging/" + rejected.checkpointId,
    });
    expect(cancel.json()).toEqual({
      checkpointId: rejected.checkpointId,
      manifestDigest: rejected.manifestDigest,
      cancelled: true,
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: root + "/staging/" + rejected.checkpointId,
        })
      ).json(),
    ).toEqual(cancel.json());
    const changed = tombstone(
      a,
      parent,
      Array.from({ length: 64 }, (_, i) => i),
    );
    for (const ns of changed.namespaces) ns.kind = "deleted";
    changed.manifestDigest = hash(backupManifestIdentity(changed));
    await publishManifest(changed);
    expect((await pages(changed.checkpointId)).length).toBe(960);
    const added = tombstone(
      a,
      changed,
      Array.from({ length: 64 }, (_, i) => 1024 + i),
    );
    await publishManifest(added);
    expect((await pages(added.checkpointId)).length).toBe(1024);
    const rootPages = (
      await pool.query(
        "SELECT p.entry_count FROM hub_backup_catalog_root_pages r JOIN hub_backup_catalog_pages p USING(profile_id,page_id) WHERE checkpoint_id=$1",
        [added.checkpointId],
      )
    ).rows;
    expect(rootPages.length).toBeLessThanOrEqual(32);
    expect(
      rootPages.every(
        (p) => Number(p.entry_count) >= 32 && Number(p.entry_count) <= 64,
      ),
    ).toBe(true);
  }, 30000);
  async function largeHead(a:any,parent?:BackupCheckpointV2,char='a'){
    const generation=parent?parent.namespaces[0].localCut+1:1;return make(a,{parent,records:await Promise.all(Array.from({length:4},async(_,i)=>({operation:'put',store:'items',storeEpoch:0,key:{t:'string',v:'key'+i},value:await encodePortableValue((char+i).repeat(70000)),generation}))) });
  }
  it('atomically replaces a quota-sized own head only after reader and seed protections end',async()=>{
    await pool.query('UPDATE hub_profile_policy_defaults SET profile_bytes=1048576');const a=await register(),first=await largeHead(a);await publish(first);await app.inject({method:'POST',url:root+'/replicas/'+a.replicaId+'/adopt',payload:{adoptedThrough:first.m.sequence}});
    const reader=(await app.inject({url:root+'/checkpoints/'+first.m.checkpointId+'?catalog=paged&restoreId='+randomUUID()})).json().restoreReaderPin;const other=await register(first.m.checkpointId),next=await largeHead(a,first.m,'b');await prepare(next.m);await upload(next);
    const blocked=await app.inject({method:'POST',url:root+'/staging/'+next.m.checkpointId+'/publish'});expect(blocked.statusCode,blocked.body).toBe(413);expect((await pool.query('SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1',[first.m.checkpointId])).rows[0].status).toBe('complete');await assertExactBytes();
    await app.inject({method:'POST',url:root+'/checkpoints/'+first.m.checkpointId+'/restore-release',payload:{leaseId:reader.leaseId}});
    const seeded=await app.inject({method:'POST',url:root+'/staging/'+next.m.checkpointId+'/publish'});expect(seeded.statusCode,seeded.body).toBe(413);
    const inherited=tombstone(other,undefined,[]);await publishManifest(inherited);expect((await app.inject({method:'POST',url:root+'/staging/'+next.m.checkpointId+'/publish'})).statusCode).toBe(413);
    await app.inject({method:'DELETE',url:root+'/replicas/'+other.replicaId});for(let i=0;i<10;i++)await withBackupTransaction(pool,new AbortController().signal,c=>collectBackupGarbageSlice(c,pool,{profileId:profile}));
    const done=await app.inject({method:'POST',url:root+'/staging/'+next.m.checkpointId+'/publish'});expect(done.statusCode,done.body).toBe(200);expect(done.json().historyShortened).toBe(true);expect((await pool.query('SELECT status FROM hub_backup_checkpoints WHERE checkpoint_id=$1',[first.m.checkpointId])).rows[0].status).toBe('retired');await assertExactBytes();expect(Number((await pool.query('SELECT bytes FROM hub_profiles')).rows[0].bytes)).toBeLessThanOrEqual(1048576);
  });
  for(const mode of ['before-commit','lost-commit'] as const)it('preserves atomic replacement accounting on '+mode,async()=>{
    await pool.query('UPDATE hub_profile_policy_defaults SET profile_bytes=1048576');const a=await register(),first=await largeHead(a);await publish(first);await app.inject({method:'POST',url:root+'/replicas/'+a.replicaId+'/adopt',payload:{adoptedThrough:first.m.sequence}});const next=await largeHead(a,first.m,'z');await prepare(next.m);await upload(next);let armed=true,inside=false;
    const faulty={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,k){if(k==='query')return async(...args:any[])=>{const text=String(args[0]);if(text.includes('SELECT * FROM hub_profiles')&&text.includes('FOR NO KEY UPDATE'))inside=true;if(armed&&inside&&mode==='before-commit'&&text.includes("UPDATE hub_backup_checkpoints SET status='complete'")){armed=false;throw Error('fail after credit before publication');}const result=await(target.query as any)(...args);if(text==='COMMIT'&&inside){inside=false;if(armed&&mode==='lost-commit'){armed=false;throw Error('lost atomic replacement COMMIT response');}}return result;};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});}} as unknown as Pool;
    await expect(publishPreparedBackupV2({pool:faulty,encryptionKey:master},sessionValue as any,next.m.checkpointId,new AbortController().signal)).rejects.toThrow();await assertExactBytes();
    const states=(await pool.query('SELECT checkpoint_id,status FROM hub_backup_checkpoints WHERE checkpoint_id=ANY($1::uuid[])',[[first.m.checkpointId,next.m.checkpointId]])).rows;if(mode==='before-commit'){expect(states.find(x=>x.checkpoint_id===first.m.checkpointId).status).toBe('complete');expect(states.find(x=>x.checkpoint_id===next.m.checkpointId).status).toBe('prepared');}else{expect(states.find(x=>x.checkpoint_id===first.m.checkpointId).status).toBe('retired');expect(states.find(x=>x.checkpoint_id===next.m.checkpointId).status).toBe('complete');}
    const retry=await app.inject({method:'POST',url:root+'/staging/'+next.m.checkpointId+'/publish'});expect(retry.statusCode,retry.body).toBe(200);expect(retry.json().checkpointId).toBe(next.m.checkpointId);expect(retry.json().historyShortened).toBe(true);await assertExactBytes();
  });
  it('keeps exact cancellation proof through real GC and fences stale prepare after durable cancellation adoption',async()=>{
    const a=await register(),first=await make(a);await publish(first);const cancelled=await make(a,{parent:first.m});await prepare(cancelled.m);await upload(cancelled);const cancel=await app.inject({method:'DELETE',url:root+'/staging/'+cancelled.m.checkpointId});expect(cancel.statusCode,cancel.body).toBe(200);
    for(let i=0;i<12;i++)await withBackupTransaction(pool,new AbortController().signal,c=>collectBackupGarbageSlice(c,pool,{profileId:profile}));expect((await pool.query('SELECT count(*) FROM hub_backup_checkpoints WHERE checkpoint_id=$1',[cancelled.m.checkpointId])).rows[0].count).toBe('0');
    const proof=await app.inject({url:root+'/staging/'+cancelled.m.checkpointId});expect(proof.statusCode,proof.body).toBe(200);expect(proof.json()).toMatchObject({checkpointId:cancelled.m.checkpointId,manifestDigest:cancelled.m.manifestDigest,status:'expired',cancelled:true});expect((await app.inject({method:'DELETE',url:root+'/staging/'+cancelled.m.checkpointId})).json()).toEqual(cancel.json());
    const body={checkpointId:cancelled.m.checkpointId,manifestDigest:cancelled.m.manifestDigest},adopt=await app.inject({method:'POST',url:root+'/replicas/'+a.replicaId+'/cancellations/adopt',payload:body});expect(adopt.statusCode,adopt.body).toBe(200);expect(adopt.json()).toMatchObject({...body,adopted:true,headSequence:cancelled.m.sequence,headCheckpointId:first.m.checkpointId,adoptedThrough:cancelled.m.sequence});expect((await app.inject({method:'POST',url:root+'/replicas/'+a.replicaId+'/cancellations/adopt',payload:body})).json()).toEqual(adopt.json());
    expect((await prepare(cancelled.m)).statusCode).toBe(409);const fresh=await make(a,{parent:first.m,sequence:cancelled.m.sequence+1,value:'fresh after cancellation fence'});fresh.m.adoptedThrough=cancelled.m.sequence;fresh.m.manifestDigest=hash(backupManifestIdentity(fresh.m));await publish(fresh);await assertExactBytes();
  });

});
