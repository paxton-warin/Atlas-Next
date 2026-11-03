import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,writeFile,rm,statfs} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {BACKUP_CATALOG_INDEXES,backupCatalogIndexSQL,backupCatalogIndexStatus} from "./hubBackupsV2Readiness.js";
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
run("Online backup indexes — isolated PostgreSQL, no deployment", () => {
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
  const exec=promisify(execFile),script=fileURLToPath(new URL('../../../scripts/backup-v2-online-indexes.mjs',import.meta.url));
  async function operator(apply=false,headroom=true){const dir=await mkdtemp(join(tmpdir(),'atlas-index-proof-'));try{const disk=await statfs(tmpdir()),path=join(dir,'headroom.json');await writeFile(path,JSON.stringify({measuredAt:new Date().toISOString(),freeDiskBytes:disk.bavail*disk.bsize}));const u=new URL(url!);u.searchParams.set('options','-c search_path='+schema+',public');const args=[script,...apply?['--apply']:[],...headroom?['--headroom-json',path]:[]];try{const result=await exec(process.execPath,args,{env:{...process.env,DATABASE_URL:u.href},timeout:20000});return {code:0,data:JSON.parse(result.stdout.trim())};}catch(e:any){return {code:e.code,data:JSON.parse(e.stderr.trim())};}}finally{await rm(dir,{recursive:true,force:true});}}
  it('pauses only backup publication until all online indexes are valid, then accepts the same candidate',async()=>{
    expect((await app.inject({url:root+'/capabilities'})).json().publicationEnabled).toBe(false);const a=await register(),b=await make(a);expect((await prepare(b.m)).statusCode).toBe(503);expect((await pool.query('SELECT count(*) FROM hub_backup_checkpoints')).rows[0].count).toBe('0');
    const dry=await operator();expect(dry.code).toBe(0);expect(dry.data.applied).toBe(false);expect(dry.data.ready).toBe(false);expect(dry.data.steps.every((s:any)=>s.action==='would-create')).toBe(true);
    const missing=await operator(true,false);expect(missing.code).toBe(1);expect(missing.data.code).toBe('RECENT_DATABASE_HOST_HEADROOM_REQUIRED');expect((await backupCatalogIndexStatus(pool)).some(i=>i.present)).toBe(false);
    const applied=await operator(true);expect(applied.code,JSON.stringify(applied.data)).toBe(0);expect(applied.data.ready).toBe(true);expect(applied.data.steps.every((s:any)=>s.action==='created-concurrently')).toBe(true);await new Promise(r=>setTimeout(r,1050));expect((await app.inject({url:root+'/capabilities'})).json().publicationEnabled).toBe(true);await publish(b);
    const again=await operator(true);expect(again.code).toBe(0);expect(again.data.steps.every((s:any)=>s.action==='already-valid')).toBe(true);
  },30000);
  it('resumes an actually cancelled invalid concurrent index but refuses a same-name wrong definition',async()=>{
    await provisionBackupCatalogTestIndexes(pool);const spec=BACKUP_CATALOG_INDEXES.find(i=>i.name==='hub_backup_jobs_cleanup')!;await pool.query('DROP INDEX '+schema+'.'+spec.name);const writer=await pool.connect(),builder=await pool.connect();
    try{await writer.query('BEGIN');await writer.query("INSERT INTO hub_backup_jobs(profile_id,kind) VALUES($1,'prune')",[profile]);await builder.query("SET statement_timeout='100ms'");await expect(builder.query(backupCatalogIndexSQL(spec,schema,true))).rejects.toMatchObject({code:'57014'});}finally{await writer.query('ROLLBACK');writer.release();await builder.query('SET statement_timeout=0');builder.release();}
    const invalid=(await backupCatalogIndexStatus(pool)).find(i=>i.name===spec.name)!;expect(invalid.present).toBe(true);expect(invalid.matches).toBe(true);expect(invalid.valid).toBe(false);
    const resumed=await operator(true);expect(resumed.code,JSON.stringify(resumed.data)).toBe(0);expect(resumed.data.steps.find((s:any)=>s.name===spec.name).action).toBe('created-concurrently');
    await pool.query('DROP INDEX '+schema+'.'+spec.name);await pool.query('CREATE INDEX '+spec.name+' ON '+schema+'.hub_backup_jobs(profile_id,id)');const denied=await operator();expect(denied.code).toBe(1);expect(denied.data.code).toBe('INDEX_DEFINITION_MISMATCH');expect((await backupCatalogIndexStatus(pool)).find(i=>i.name===spec.name)?.matches).toBe(false);
    await pool.query('DROP INDEX '+schema+'.'+spec.name);await pool.query(backupCatalogIndexSQL(spec,schema,false));
  },30000);
});
