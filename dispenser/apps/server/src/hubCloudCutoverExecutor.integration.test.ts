/** Real isolated PostgreSQL state machine; private HTTP and signed browser
 * observations are deterministic adapters, never claimed production acceptance. */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { encrypt, hashSecret } from "./security.js";
import { makePlan, hashPlan, type CloudResource } from "./hubCloudWorker.js";
import { canonicalCutoverJSON, cutoverDigest, type RuntimeAcceptanceBody, type RuntimeAcceptanceEnvelope } from "./hubCloudCutover.js";
import { ProductionCutoverExecutor, type CutoverBinding } from "./hubCloudCutoverExecutor.js";

const url = process.env.TEST_DATABASE_URL, suite = url ? describe : describe.skip;
const id = (n: number) => n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const secret = "s".repeat(43), encryptionKey = "disposable-cutover-encryption-key", sessionSecret = "disposable-cutover-session-secret-with-32-characters", originKey = "synthetic-private-origin-key", serviceSecret = "synthetic-service-secret-more-than-32-characters", assetHash = "c".repeat(64), receiptHash = "a".repeat(64), valueHash = "b".repeat(64);
suite("production cutover durable real-PostgreSQL executor", () => {
  const schema = "cutover_executor_" + randomUUID().replaceAll("-", ""); let pool: Pool, maintenance: Pool;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith("_test")) throw Error("Dedicated disposable test database required");
    maintenance = new Pool({ connectionString: url }); await maintenance.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public"); await maintenance.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 6 });
    for (const name of (await readdir(new URL("../../../packages/database/migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort()) await pool.query(await readFile(new URL("../../../packages/database/migrations/" + name, import.meta.url), "utf8"));
  });
  beforeEach(async () => { await pool.query("TRUNCATE users,links CASCADE"); });
  afterAll(async () => { await pool?.end(); await maintenance?.query(`DROP SCHEMA ${schema} CASCADE`); await maintenance?.end(); });

  async function fixture({ missingBranch = false, missingCredential = false, roles = ["frontend", "hub", "node"] as Array<CloudResource["role"]> } = {}) {
    await pool.query("INSERT INTO users(id,email,normalized_email,role,quota_override,quota_reset_at) VALUES($1,'admin@example.test','admin@example.test','admin',NULL,NULL),($2,'probe@example.test','probe@example.test','user','{\"linksPerWeek\":3}',now()),($3,'student@example.test','student@example.test','user','{\"linksPerWeek\":2}',now())", [id(10), id(70), id(80)]);
    await pool.query("INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,'fixture-session','fixture-csrf',now()+interval '1 hour')", [id(73), id(70)]);
    await pool.query("INSERT INTO links(id,name,url) VALUES($1,'Existing Atlas','https://old-frontend.example')", [id(20)]);
    await pool.query("INSERT INTO link_assignments(user_id,link_id) VALUES($1,$3),($2,$3)", [id(70), id(80), id(20)]);
    if (!missingBranch) {
      await pool.query("INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$2,'https://old-frontend.example',$3)", [id(60), id(20), hashSecret(secret, sessionSecret)]);
      if (!missingCredential) await pool.query("INSERT INTO hub_cloud_branch_credentials(branch_id,encrypted_secret) VALUES($1,$2)", [id(60), encrypt(secret, encryptionKey)]);
      await pool.query("INSERT INTO hub_branch_origins(branch_id,origin,state) VALUES($1,'https://old-frontend.example','active')", [id(60)]);
    }
    await pool.query("INSERT INTO hub_profiles(id,user_id,encrypted_key,initialized) VALUES($1,$2,'untouched-profile-key',true)", [id(71), id(70)]);
    if (!missingBranch) await pool.query("INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$5,'fixture-branch-session','fixture-context',now()+interval '1 hour')", [id(72), id(70), id(71), id(60), id(73)]);
    await pool.query("INSERT INTO hub_cloud_accounts(id,label,expected_account_id,verified_account_id,status) VALUES($1,'Old','111111111111','111111111111','connected'),($2,'New','222222222222','222222222222','connected')", [id(40), id(50)]);
    const resources: CloudResource[] = roles.map((role, i) => ({ key: "resource-" + role, role, logicalId: role === "frontend" ? id(20) : role === "node" ? "node-two" : "hub-main", originHost: role + ".origin.example", previous: { id: id(30 + i), revision: 3, distributionId: "EOLD12345" + i, accountId: id(40), url: "https://old-" + role + ".example" } }));
    const plan = makePlan({ id: id(50), expectedAccountId: "222222222222", region: "us-east-1" }, resources), checkpoint = { resources: Object.fromEntries(resources.map((r, i) => [r.key, { id: "ENEW12345" + i, domain: "dnew" + r.role + ".cloudfront.net", status: "Deployed", caller: "atlas-hub-" + id(1) + "-" + r.key, originHost: r.originHost }])) };
    for (const r of resources) await pool.query("INSERT INTO hub_cloud_endpoints(id,role,logical_id,link_id,account_id,distribution_id,url,origin_host,revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,3,'active')", [r.previous!.id, r.role, r.logicalId, r.role === "frontend" ? r.logicalId : null, id(40), r.previous!.distributionId, r.previous!.url, r.originHost]);
    await pool.query("INSERT INTO hub_cloud_jobs(id,plan,plan_hash,state,revision,checkpoint,approved_by,created_by) VALUES($1,$2,$3,'ready_for_activation',7,$4,$5,$5)", [id(1), JSON.stringify(plan), hashPlan(plan), JSON.stringify(checkpoint), id(10)]);
    const job = { id: id(1), state: "ready_for_activation", revision: 7, plan, planHash: hashPlan(plan), checkpoint }, binding: CutoverBinding = { jobId: job.id, expectedRevision: 7, planHash: job.planHash, assetManifestHash: assetHash, operatorId: id(10) };
    const state = { generation: 5, hubOrigin: "https://old-hub.example", nodes: [{ id: "node-two", endpoint: "https://old-node.example" }], registry: new Map<string, { id: string; generation: number; secret: string; transitionRevision: number; transitionActive: boolean }>(), endpointHash: "", endpointApplications: 0, transitionApplications: 0, aliases: new Map<string, any>(), loseEndpointAck: false, loseTransitionAck: false, rejectPrivate: false };
    if (!missingBranch) state.registry.set("https://old-frontend.example", { id: id(60), generation: 9, secret, transitionRevision: 0, transitionActive: false });
    const calls: Array<{ path: string; method: string; body: any; headers: any }> = [];
    const snapshot = () => ({ format: "atlas-coordinator-endpoint-snapshot-v1" as const, origin: "https://coordinator.example", observedAt: new Date().toISOString(), generation: state.generation, hubOrigin: state.hubOrigin, nodes: structuredClone(state.nodes), branches: [...state.registry].map(([origin, r]) => ({ origin, id: r.id, generation: r.generation, transitionRevision: r.transitionRevision, transitionActive: r.transitionActive })) });
    const request: typeof fetch = async (input, options) => {
      const u = new URL(String(input)), path = u.pathname, method = options?.method ?? "GET", body = options?.body ? JSON.parse(String(options.body)) : null, headers = options?.headers as Record<string, string>;
      calls.push({ path, method, body, headers }); expect(u.origin).toBe("https://coordinator.example"); expect(headers.authorization).toBe("Bearer " + serviceSecret); expect(headers["X-Atlas-Origin-Key"]).toBe(originKey); expect(options?.redirect).toBe("error");
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status }); if (state.rejectPrivate) return json({}, 503);
      if (path === "/api/internal/hub/endpoints" && method === "GET") return json(snapshot());
      if (path === "/api/internal/hub/branches" && method === "POST") { const old = state.registry.get(body.origin); if (old && body.generation <= old.generation) return old.id === body.id && old.generation === body.generation && old.secret === body.secret ? json({ ok: true, generation: old.generation, replayed: true }) : json({}, 409); state.registry.set(body.origin, { id: body.id, generation: body.generation, secret: body.secret, transitionRevision: 0, transitionActive: false }); return json({ ok: true, generation: body.generation }); }
      if (path === "/api/internal/hub/qualification-aliases") { expect(Object.keys(body).sort()).toEqual((method === "POST" ? ["jobId", "planHash", "probeAccountId", "stableNodeId", "expectedCurrentEndpoint", "candidateEndpoint", "expiresAt"] : ["jobId", "planHash", "probeAccountId", "stableNodeId"]).sort()); if (method === "POST") { expect(body.probeAccountId).toBe(id(70)); expect(body.stableNodeId).toBe("node-two"); expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000); state.aliases.set(body.stableNodeId, body); } else state.aliases.delete(body.stableNodeId); return json({ ok: true }); }
      if (path === "/api/internal/hub/endpoints" && method === "POST") { const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex"); if (body.generation === state.generation && hash === state.endpointHash) return json({ ok: true, generation: state.generation, replayed: true }); if (body.generation !== state.generation + 1 || body.hubOrigin && body.previousHubOrigin !== state.hubOrigin || body.nodes.some((n: any) => !state.nodes.some(old => old.id === n.id && old.endpoint === n.previousEndpoint))) return json({}, 409); if (body.hubOrigin) state.hubOrigin = body.hubOrigin; for (const n of body.nodes) state.nodes.find(x => x.id === n.id)!.endpoint = n.endpoint; state.generation = body.generation; state.endpointHash = hash; state.endpointApplications++; if (state.loseEndpointAck) { state.loseEndpointAck = false; throw Error("fixture lost endpoint acknowledgement"); } return json({ ok: true, generation: body.generation }); }
      if (path === "/api/internal/hub/branch-transitions" && method === "POST") { const old = state.registry.get(body.origin); if (!old || old.generation !== body.expectedGeneration) return json({}, 409); if (old.transitionRevision === body.revision && old.transitionActive === body.active) return json({ ok: true, generation: old.generation, revision: body.revision, active: body.active, replayed: true }); if (body.revision !== old.transitionRevision + 1) return json({}, 409); old.transitionRevision = body.revision; old.transitionActive = body.active; state.transitionApplications++; if (state.loseTransitionAck) { state.loseTransitionAck = false; throw Error("fixture lost transition acknowledgement"); } return json({ ok: true, generation: old.generation, revision: body.revision, active: body.active }); }
      throw Error("unexpected private route " + method + " " + path);
    };
    const options = { pool, encryptionKey, sessionSecret, coordinatorOrigin: "https://coordinator.example", serviceSecret, coordinatorOriginKey: originKey, probeUserId: id(70), fetch: request };
    const worker = (extra: Partial<ConstructorParameters<typeof ProductionCutoverExecutor>[0]> = {}) => new ProductionCutoverExecutor({ ...options, ...extra });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519"), pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    async function qualification() {
      const branch = (await pool.query("SELECT id FROM hub_branches WHERE link_id=$1", [id(20)])).rows[0];
      if (roles.includes("frontend")) {
        if (missingBranch) await pool.query("INSERT INTO hub_branch_sessions(id,user_id,profile_id,branch_id,parent_session_id,token_hash,context_id,expires_at) VALUES($1,$2,$3,$4,$5,'fixture-new-branch-session','fixture-context',now()+interval '1 hour') ON CONFLICT(id) DO NOTHING", [id(72), id(70), id(71), branch.id, id(73)]);
        await pool.query("INSERT INTO hub_handoffs(code_hash,branch_id,user_id,parent_session_id,challenge,state,callback_origin,expires_at,used_at) VALUES($1,$2,$3,$4,$5,'fixture-state','https://dnewfrontend.cloudfront.net',now()+interval '1 minute',now()) ON CONFLICT(code_hash) DO NOTHING", [receiptHash, branch.id, id(70), id(73), "x".repeat(43)]);
        await pool.query("INSERT INTO hub_commits(profile_id,idempotency_key,namespace,payload_hash,mode,revision,profile_revision) VALUES($1,'probe-save-0000000000000001',$2,$3,'snapshot',1,1) ON CONFLICT DO NOTHING", [id(71), JSON.stringify(["local", "https://save.example", ""]), receiptHash]);
      }
      const at = new Date().toISOString(), cookieAttributes = ["Secure", "HttpOnly", "HostOnly", "Path=/", "SameSite=Lax"];
      const websocket = (origin: string) => ({ url: origin.replace("https:", "wss:") + "/wisp/probe", sessionId: id(72), openedAt: at, closedAt: at, sentSHA256: valueHash, receivedSHA256: valueHash, sentBytes: 32, receivedBytes: 32 });
      const body: RuntimeAcceptanceBody = { format: "atlas-runtime-acceptance-v1", jobId: job.id, jobRevision: job.revision, planHash: job.planHash, checkpointHash: cutoverDigest(checkpoint), accountIdentity: plan.accountIdentity, assetManifestHash: assetHash, observedAt: at, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), coordinator: snapshot(), endpoints: resources.map(r => ({ resourceKey: r.key, distributionId: checkpoint.resources[r.key]!.id, origin: "https://" + checkpoint.resources[r.key]!.domain, role: r.role, assetManifestHash: assetHash, ...(r.role === "frontend" ? { auth: { kind: "account-bound-handoff" as const, branchId: branch.id, userId: id(70), profileId: id(71), sessionId: id(72), callbackOrigin: "https://dnewfrontend.cloudfront.net", redeemedCodeHash: receiptHash, redeemedAt: at, replayHTTPStatus: 409, cookieAttributes }, profile: { profileId: id(71), namespace: ["local", "https://save.example", ""] as [string, string, string], idempotencyKey: "probe-save-0000000000000001", revision: 1, payloadHash: receiptHash, sourceValueHash: valueHash, restoredValueHash: valueHash, acknowledgedAt: at, restoredAt: at }, websocket: websocket(roles.includes("node") ? "https://dnewnode.cloudfront.net" : "https://old-node.example") } : r.role === "hub" ? { hubSession: { sessionId: id(73), userId: id(70), HTTPStatus: 200, cookieAttributes } } : { nodeIdentity: { expectedId: "node-two", observedId: "node-two" }, websocket: websocket("https://dnewnode.cloudfront.net") }) })) };
      const envelope: RuntimeAcceptanceEnvelope = { format: "atlas-runtime-acceptance-envelope-v1", payload: body, signature: sign(null, Buffer.from(canonicalCutoverJSON(body)), privateKey).toString("base64url") };
      return { envelope, trustedProbePublicKey: pub };
    }
    const preserved = async () => { const rows: Record<string, unknown> = {}; for (const table of ["users", "link_assignments", "sessions", "hub_profiles", "hub_branch_sessions", "hub_commits"]) rows[table] = (await pool.query("SELECT to_jsonb(t) AS row FROM " + table + " t")).rows.map(r => JSON.stringify(r.row)).sort(); return cutoverDigest(rows); };
    return { binding, job, resources, state, snapshot, calls, worker, qualification, preserved, options };
  }

  it("stages callbacks/registries/one dedicated alias without changing URLs, assignments, quotas, profiles or global endpoints", async () => {
    const f = await fixture(), before = await f.preserved(), r = await f.worker().stage(f.binding);
    expect(r.phase).toBe("prepared"); expect(r.registryStaged).toBe(true); expect(await f.preserved()).toBe(before); expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://old-frontend.example"); expect(f.state.hubOrigin).toBe("https://old-hub.example"); expect(f.state.nodes[0]!.endpoint).toBe("https://old-node.example");
    expect((await pool.query("SELECT origin,state FROM hub_branch_origins ORDER BY origin")).rows).toEqual([{ origin: "https://dnewfrontend.cloudfront.net", state: "transition" }, { origin: "https://old-frontend.example", state: "active" }]); expect(f.state.aliases.size).toBe(1);
    const receipt = (await pool.query("SELECT encrypted_payload FROM hub_cloud_cutovers")).rows[0].encrypted_payload; expect(receipt).not.toContain(secret); expect(receipt).not.toContain(originKey); expect(JSON.stringify(r)).not.toContain(secret); expect(JSON.stringify(r)).not.toContain(originKey);
  });
  it("commits all roles atomically then completes fixed coordinator operations, preserving stable IDs and every protected row", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); const q = await f.qualification(), before = await f.preserved(), result = await w.commit(f.binding, q);
    expect(result.phase).toBe("complete"); expect(result.acceptanceHash).toMatch(/^[a-f0-9]{64}$/); expect(await f.preserved()).toBe(before); expect((await pool.query("SELECT id,url FROM links")).rows[0]).toEqual({ id: id(20), url: "https://dnewfrontend.cloudfront.net" }); expect((await pool.query("SELECT id,origin FROM hub_branches")).rows[0]).toEqual({ id: id(60), origin: "https://dnewfrontend.cloudfront.net" });
    expect((await pool.query("SELECT state,revision,lease_until FROM hub_cloud_jobs")).rows[0]).toEqual({ state: "complete", revision: 9, lease_until: null }); expect((await pool.query("SELECT state,count(*)::int FROM hub_cloud_endpoints GROUP BY state ORDER BY state")).rows).toEqual([{ state: "active", count: 3 }, { state: "transition", count: 3 }]); expect(f.state.endpointApplications).toBe(1); expect(f.state.transitionApplications).toBe(1); expect(f.state.aliases.size).toBe(0);
    expect(f.calls.every(c => ["/api/internal/hub/endpoints", "/api/internal/hub/branches", "/api/internal/hub/branch-transitions", "/api/internal/hub/qualification-aliases"].includes(c.path))).toBe(true);
  });
  it("returns exact completed replay without reallocating or repeating private mutations", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); const q = await f.qualification(), first = await w.commit(f.binding, q), calls = f.calls.length, before = await f.preserved(); expect(await w.commit(f.binding, q)).toEqual(first); expect(await w.stage(f.binding)).toEqual(first); expect(f.calls.length).toBe(calls); expect(await f.preserved()).toBe(before);
  });
  it("records initial Hub bootstrap already bound to target without inventing an endpoint rotation", async () => {
    const f = await fixture({ roles: ["hub"] }); f.state.hubOrigin = "https://dnewhub.cloudfront.net"; const w = f.worker(); await w.stage(f.binding); const r = await w.commit(f.binding, await f.qualification()); expect(r.phase).toBe("complete"); expect(f.state.generation).toBe(5); expect(f.calls.filter(c => c.path === "/api/internal/hub/endpoints" && c.method === "POST")).toHaveLength(0); expect((await pool.query("SELECT state FROM hub_cloud_endpoints ORDER BY revision")).rows).toEqual([{ state: "transition" }, { state: "active" }]); expect((await pool.query("SELECT value FROM app_settings WHERE key='hub_current_origin'")).rows[0].value).toBe("https://dnewhub.cloudfront.net");
  });
  it("recovers a crash after durable DB commit without overwriting subsequent account writes", async () => {
    const f = await fixture(), w = f.worker({ fault: async p => { if (p === "after-database-commit") throw Error("fixture crash"); } }); await w.stage(f.binding); await expect(w.commit(f.binding, await f.qualification())).rejects.toThrow("fixture crash");
    expect((await pool.query("SELECT phase FROM hub_cloud_cutovers")).rows[0].phase).toBe("database_committed"); expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://dnewfrontend.cloudfront.net"); expect(f.state.endpointApplications).toBe(0);
    await pool.query("INSERT INTO hub_commits(profile_id,idempotency_key,namespace,payload_hash,mode,revision,profile_revision) VALUES($1,'later-account-write-00000001',$2,$3,'journal',2,2)", [id(71), JSON.stringify(["local", "https://save.example", ""]), "d".repeat(64)]); const before = await f.preserved(); expect((await f.worker().commit(f.binding)).phase).toBe("complete"); expect(await f.preserved()).toBe(before); expect(f.state.endpointApplications).toBe(1);
  });
  it.each(["endpoint", "transition"])("reconciles lost %s acknowledgement with exact durable replay only", async kind => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); if (kind === "endpoint") f.state.loseEndpointAck = true; else f.state.loseTransitionAck = true;
    await expect(w.commit(f.binding, await f.qualification())).rejects.toThrow("PRIVATE_COORDINATOR_UNAVAILABLE"); const before = await f.preserved(); expect((await f.worker().commit(f.binding)).phase).toBe("complete"); expect(f.state.endpointApplications).toBe(1); expect(f.state.transitionApplications).toBe(1); expect(await f.preserved()).toBe(before);
    const endpointBodies = f.calls.filter(c => c.path === "/api/internal/hub/endpoints" && c.method === "POST").map(c => canonicalCutoverJSON(c.body)); expect(new Set(endpointBodies).size).toBe(1);
  });
  it("resumes after coordinator acknowledgement and alias release but before final receipt publication", async () => {
    const f=await fixture(),w=f.worker({fault:async p=>{if(p==="before-complete")throw Error("fixture final crash");}});await w.stage(f.binding);await expect(w.commit(f.binding,await f.qualification())).rejects.toThrow("fixture final crash");expect(f.state.endpointApplications).toBe(1);expect(f.state.transitionApplications).toBe(1);expect(f.state.aliases.size).toBe(0);expect((await f.worker().commit(f.binding)).phase).toBe("complete");expect(f.state.endpointApplications).toBe(1);expect(f.state.transitionApplications).toBe(1);
  });
  it("replays stage after registry acknowledgement loss without another branch identity or callback", async () => {
    const f = await fixture(), w = f.worker({ fault: async p => { if (p === "after-registry-staging") throw Error("fixture stage crash"); } }); await expect(w.stage(f.binding)).rejects.toThrow("fixture stage crash"); expect((await pool.query("SELECT staged_at FROM hub_cloud_cutovers")).rows[0].staged_at).toBe(null); const r = await f.worker().stage(f.binding); expect(r.registryStaged).toBe(true); expect((await pool.query("SELECT count(*)::int FROM hub_branches")).rows[0].count).toBe(1); expect((await pool.query("SELECT count(*)::int FROM hub_branch_origins")).rows[0].count).toBe(2);
  });
  it("bootstraps a missing pre-Hub branch on the existing logical link without rotating an existing identity", async () => {
    const f = await fixture({ missingBranch: true }), before = (await pool.query("SELECT id FROM link_assignments ORDER BY id")).rows; const r = await f.worker().stage(f.binding), branch = r.items.find(i => i.role === "frontend")!.branchId!; expect(branch).toMatch(/^[a-f0-9-]{36}$/); expect((await pool.query("SELECT id,link_id,origin FROM hub_branches")).rows[0]).toEqual({ id: branch, link_id: id(20), origin: "https://old-frontend.example" }); expect((await pool.query("SELECT id FROM link_assignments ORDER BY id")).rows).toEqual(before); expect((await f.worker().commit(f.binding, await f.qualification())).phase).toBe("complete"); expect((await pool.query("SELECT id FROM hub_branches")).rows[0].id).toBe(branch);
  });
  it("requires the exact old branch credential and can privately escrow a verified supplied credential", async () => {
    const f = await fixture({ missingCredential: true }); await expect(f.worker().stage(f.binding)).rejects.toThrow("EXACT_EXISTING_BRANCH_CREDENTIAL_REQUIRED"); expect((await pool.query("SELECT count(*)::int FROM hub_cloud_cutovers")).rows[0].count).toBe(0); const before = (await pool.query("SELECT secret_hash FROM hub_branches")).rows[0].secret_hash; const r = await f.worker({ initialCredentials: { [id(60)]: secret } }).stage(f.binding); expect(r.registryStaged).toBe(true); expect((await pool.query("SELECT secret_hash FROM hub_branches")).rows[0].secret_hash).toBe(before);
  });
  it("requires real detailed signed proof plus actual Hub receipts; health-only cannot publish", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); await expect(w.commit(f.binding)).rejects.toThrow("REAL_RUNTIME_QUALIFICATION_REQUIRED"); const q = await f.qualification(); q.envelope.payload.endpoints[0]!.auth = undefined; await expect(w.commit(f.binding, q)).rejects.toThrow("RUNTIME_EVIDENCE_SIGNATURE_INVALID"); expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://old-frontend.example"); expect((await pool.query("SELECT phase FROM hub_cloud_cutovers")).rows[0].phase).toBe("prepared");
  });
  it("rejects revoked probe sessions or absent immutable profile receipts without changing active endpoints", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); const q = await f.qualification(); await pool.query("UPDATE hub_branch_sessions SET revoked_at=now() WHERE id=$1", [id(72)]); await expect(w.commit(f.binding, q)).rejects.toThrow("LIVE_ACCOUNT_SESSION_CORROBORATION_FAILED"); expect(f.state.endpointApplications).toBe(0); expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://old-frontend.example");
  });
  it("rejects stale coordinator snapshot or changed endpoint revisions before any canonical URL changes", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); const q = await f.qualification(); f.state.generation++; await expect(w.commit(f.binding, q)).rejects.toThrow("QUALIFIED_COORDINATOR_SNAPSHOT_CHANGED"); f.state.generation--; await pool.query("UPDATE hub_cloud_endpoints SET revision=revision+1 WHERE role='node'"); await expect(w.commit(f.binding, q)).rejects.toThrow("ENDPOINT_REVISION_CONFLICT"); expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://old-frontend.example");
  });
  it("rejects changed canonical link and callback states within the publication transaction", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); const q = await f.qualification(); await pool.query("UPDATE links SET url='https://changed.example'"); await expect(w.commit(f.binding, q)).rejects.toThrow("STABLE_LINK_OR_BRANCH_CHANGED"); expect((await pool.query("SELECT state FROM hub_cloud_endpoints WHERE role='frontend'")).rows[0].state).toBe("active");
  });
  it("SQL-enforces immutable prepared bindings, original job checkpoint, monotonic phases and accepted evidence", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); await expect(pool.query("UPDATE hub_cloud_cutovers SET asset_manifest_hash=$1", ["d".repeat(64)])).rejects.toThrow("Cutover bindings are immutable"); await expect(pool.query("UPDATE hub_cloud_jobs SET checkpoint='{}'")).rejects.toThrow("prepared cutover checkpoint is immutable");
    const crash = f.worker({ fault: async p => { if (p === "after-database-commit") throw Error("fixture crash"); } }); await expect(crash.commit(f.binding, await f.qualification())).rejects.toThrow("fixture crash"); await expect(pool.query("UPDATE hub_cloud_cutovers SET phase='prepared'")).rejects.toThrow("phase cannot move backwards"); await expect(pool.query("UPDATE hub_cloud_cutovers SET acceptance_hash=$1", ["e".repeat(64)])).rejects.toThrow("Runtime acceptance is immutable"); await expect(pool.query("UPDATE hub_cloud_jobs SET state='cancelled'")).rejects.toThrow("must finish its durable coordinator operation");
  });
  it("prevents another pending job from reserving the same logical target", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); await pool.query("INSERT INTO hub_cloud_jobs(id,plan,plan_hash,state,revision,checkpoint,approved_by,created_by) SELECT $1,plan,plan_hash,state,revision,checkpoint,approved_by,created_by FROM hub_cloud_jobs WHERE id=$2", [id(2), id(1)]);
    // The duplicate job must own its exact caller references before attempting
    // reservation, just like a real separately provisioned immutable plan.
    const cp = structuredClone(f.job.checkpoint); for (const d of Object.values(cp.resources)) d.caller = d.caller.replace(id(1), id(2)); await pool.query("UPDATE hub_cloud_jobs SET checkpoint=$2 WHERE id=$1", [id(2), JSON.stringify(cp)]);
    await expect(w.stage({ ...f.binding, jobId: id(2) })).rejects.toThrow("LOGICAL_TARGET_ALREADY_PREPARED"); expect((await pool.query("SELECT count(*)::int FROM hub_cloud_cutovers")).rows[0].count).toBe(1);
  });
  it("requires admin, correct job revision, approved job and verified target identity", async () => {
    const f = await fixture(); await expect(f.worker().stage({ ...f.binding, operatorId: id(70) })).rejects.toThrow("ACTIVE_ADMINISTRATOR_REQUIRED"); await expect(f.worker().stage({ ...f.binding, expectedRevision: 8 })).rejects.toThrow("JOB_REVISION_OR_STATE_CONFLICT"); await pool.query("UPDATE hub_cloud_jobs SET approved_by=NULL"); await expect(f.worker().stage(f.binding)).rejects.toThrow("APPROVED_PROVISIONING_JOB_REQUIRED");
  });
  it("serializes two same-job stage calls and retains exactly one branch/receipt", async () => {
    const f = await fixture({ missingBranch: true }); const [a, b] = await Promise.all([f.worker().stage(f.binding), f.worker().stage(f.binding)]); expect(a.items).toEqual(b.items); expect((await pool.query("SELECT count(*)::int FROM hub_cloud_cutovers")).rows[0].count).toBe(1); expect((await pool.query("SELECT count(*)::int FROM hub_branches")).rows[0].count).toBe(1);
  });
  it("stages 100 existing frontend logical IDs while preserving every ordinary assignment and quota row", async () => {
    const f=await fixture({roles:["frontend"]}),resources:CloudResource[]=[structuredClone(f.resources[0]!)];
    for(let n=1;n<100;n++){
      const linkId=id(1000+n),oldOrigin=`https://old-front-${n}.example`,endpointId=id(2000+n);
      await pool.query("INSERT INTO links(id,name,url) VALUES($1,$2,$3)",[linkId,"Existing Atlas "+n,oldOrigin]);await pool.query("INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)",[id(80),linkId]);
      const r:CloudResource={key:"bulk-"+n,role:"frontend",logicalId:linkId,originHost:"frontend.origin.example",previous:{id:endpointId,revision:3,distributionId:"EOLD12345"+n,accountId:id(40),url:oldOrigin}};resources.push(r);
      await pool.query("INSERT INTO hub_cloud_endpoints(id,role,logical_id,link_id,account_id,distribution_id,url,origin_host,revision,state) VALUES($1,'frontend',$2::text,$2::uuid,$3,$4,$5,$6,3,'active')",[endpointId,linkId,id(40),r.previous!.distributionId,oldOrigin,r.originHost]);
    }
    const plan=makePlan({id:id(50),expectedAccountId:"222222222222",region:"us-east-1"},resources),checkpoint={resources:Object.fromEntries(resources.map((r,n)=>[r.key,{id:"ENEWBULK"+n.toString().padStart(4,"0"),domain:"dnewbulk"+n+".cloudfront.net",status:"Deployed",caller:`atlas-hub-${id(3)}-${r.key}`,originHost:r.originHost}]))};
    await pool.query("INSERT INTO hub_cloud_jobs(id,plan,plan_hash,state,revision,checkpoint,approved_by,created_by) VALUES($1,$2,$3,'ready_for_activation',7,$4,$5,$5)",[id(3),JSON.stringify(plan),hashPlan(plan),JSON.stringify(checkpoint),id(10)]);
    const binding={...f.binding,jobId:id(3),planHash:hashPlan(plan)},before=await f.preserved(),r=await f.worker().stage(binding);expect(r.items).toHaveLength(100);expect(await f.preserved()).toBe(before);expect((await pool.query("SELECT count(*)::int FROM hub_branches")).rows[0].count).toBe(100);expect((await pool.query("SELECT count(*)::int FROM hub_branch_origins")).rows[0].count).toBe(200);expect((await pool.query("SELECT count(*)::int FROM links WHERE url LIKE 'https://old-%'")).rows[0].count).toBe(100);expect((await f.worker().stage(binding)).items).toEqual(r.items);
  });
  it("does not turn a revoked probe allocation or disabled branch into a deployment exemption",async()=>{
    const f=await fixture(),w=f.worker();await w.stage(f.binding);const q=await f.qualification();await pool.query("UPDATE link_assignments SET replaced_at=now() WHERE user_id=$1",[id(70)]);await expect(w.commit(f.binding,q)).rejects.toThrow("PROBE_ACCOUNT_ASSIGNMENT_CHANGED");expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://old-frontend.example");
  });
  it("rejects conflicting accepted-proof replay and continues durable resume after AWS login status changes", async () => {
    const f = await fixture(), w = f.worker({ fault: async p => { if (p === "after-database-commit") throw Error("fixture crash"); } }); await w.stage(f.binding); const q = await f.qualification(); await expect(w.commit(f.binding, q)).rejects.toThrow("fixture crash"); q.envelope.payload.assetManifestHash = "f".repeat(64); await expect(f.worker().commit(f.binding, q)).rejects.toThrow("ACCEPTANCE_REPLAY_CONFLICT"); await pool.query("UPDATE hub_cloud_accounts SET status='sign_in_required' WHERE id=$1", [id(50)]); expect((await f.worker().commit(f.binding)).phase).toBe("complete");
  });
  it("retains durable phase on private API failure and never dispatches arbitrary URLs or operations", async () => {
    const f = await fixture(), w = f.worker(); await w.stage(f.binding); const q = await f.qualification(); f.state.rejectPrivate = true; await expect(w.commit(f.binding, q)).rejects.toThrow("PRIVATE_COORDINATOR_OPERATION_FAILED"); expect((await pool.query("SELECT phase FROM hub_cloud_cutovers")).rows[0].phase).toBe("prepared"); expect((await pool.query("SELECT url FROM links")).rows[0].url).toBe("https://old-frontend.example");
  });
});
describe("explicit production cutover CLI arguments", () => {
  it("shows actual stage/commit/resume commands and requires explicit apply before reading private environment", () => {
    const script = new URL("./hubCloudCutoverExecutorMain.ts", import.meta.url).pathname;
    const help = spawnSync(process.execPath, ["--import", "tsx", script, "--help"], { encoding: "utf8" }); expect(help.status).toBe(0); expect(help.stdout).toContain("stage|commit|resume --apply");
    const denied = spawnSync(process.execPath, ["--import", "tsx", script, "stage", "--job", id(1)], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://do-not-print-secret@private.example/db" } }); expect(denied.status).toBe(1); expect(denied.stderr).toContain("EXPLICIT_APPLY_REQUIRED"); expect(denied.stderr).not.toContain("do-not-print-secret");
  });
});
