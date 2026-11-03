/** Explicit operator worker: durable production cutover, fixed private APIs,
 * immutable acceptance, and no AWS commands or public privileged API proxy. */
import { createHash, createPublicKey, verify } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { encrypt, decrypt, hashSecret, randomToken, safeEqual } from "./security.js";
import { hashPlan, type CloudResource } from "./hubCloudWorker.js";
import { canonicalCutoverJSON, createCutoverReadiness, cutoverDigest, verifyRuntimeAcceptance, corroborateRuntimeAcceptance, type CutoverJob, type CutoverEndpoint, type CutoverBranch, type CoordinatorReadinessSnapshot, type RuntimeAcceptanceEnvelope, type RuntimeAcceptanceBody } from "./hubCloudCutover.js";

export class CutoverExecutionError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new CutoverExecutionError(code); };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const origin = (v: string) => { let u: URL; try { u = new URL(v); } catch { return fail("INVALID_COORDINATOR_ORIGIN"); } if (u.protocol !== "https:" || u.origin !== v || u.username || u.password) return fail("INVALID_COORDINATOR_ORIGIN"); return v; };
export type CutoverBinding = { jobId: string; expectedRevision: number; planHash: string; assetManifestHash: string; operatorId: string };
type PreparedItem = { resource: CloudResource; distributionId: string; origin: string; revision: number; branchId?: string; branchSecret?: string; oldRegistryGeneration?: number; newRegistryGeneration?: number; oldTransitionRevision?: number; oldTransitionActive?: boolean; branchCreated?: boolean };
type Prepared = { format: "atlas-production-cutover-prepared-v1"; job: CutoverJob; coordinatorOrigin: string; coordinator: CoordinatorReadinessSnapshot; probeUserId?: string; items: PreparedItem[] };
type EndpointOperation = { generation: number; hubOrigin?: string; previousHubOrigin?: string; nodes: Array<{ id: string; previousEndpoint: string; endpoint: string }> };
type Accepted = { format: "atlas-production-cutover-accepted-v1"; evidence: RuntimeAcceptanceBody; endpointOperation: EndpointOperation | null; transitions: Array<{ origin: string; expectedGeneration: number; revision: number; active: true }> };
type Receipt = { job_id: string; id: string; phase: "prepared" | "database_committed" | "complete"; prepared_job_revision: number; plan_hash: string; checkpoint_hash: string; asset_manifest_hash: string; binding_hash: string; encrypted_payload: string; staged_at: string | null; acceptance_hash: string | null; encrypted_acceptance: string | null; acceptance_key_hash: string | null };
export type ProductionCutoverOptions = {
  pool: Pool; encryptionKey: string; sessionSecret: string; coordinatorOrigin: string; serviceSecret: string; coordinatorOriginKey?: string;
  probeUserId?: string; initialCredentials?: Record<string, string>; fetch?: typeof fetch;
  /** Test-only fault adapter; no CLI/env access. */ fault?: (point: string) => Promise<void>;
};
export class ProductionCutoverExecutor {
  constructor(private options: ProductionCutoverOptions) {
    origin(options.coordinatorOrigin);
    if (!options.encryptionKey || options.sessionSecret.length < 32 || options.serviceSecret.length < 32 || options.probeUserId && !uuid(options.probeUserId)) fail("PRIVATE_WORKER_CONFIGURATION_REQUIRED");
  }
  private async call(path: "/api/internal/hub/endpoints" | "/api/internal/hub/branches" | "/api/internal/hub/branch-transitions" | "/api/internal/hub/qualification-aliases", method: "GET" | "POST" | "DELETE", body?: unknown) {
    let r: Response;
    try { r = await (this.options.fetch ?? fetch)(this.options.coordinatorOrigin + path, { method, headers: { authorization: "Bearer " + this.options.serviceSecret, ...(this.options.coordinatorOriginKey ? { "X-Atlas-Origin-Key": this.options.coordinatorOriginKey } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { return fail("PRIVATE_COORDINATOR_UNAVAILABLE"); }
    if (!r.ok) return fail(r.status === 409 ? "COORDINATOR_REVISION_CONFLICT" : "PRIVATE_COORDINATOR_OPERATION_FAILED");
    try { const text = await r.text(); if (text.length > 8_000_000) return fail("COORDINATOR_RESPONSE_TOO_LARGE"); return JSON.parse(text); } catch (e) { if (e instanceof CutoverExecutionError) throw e; return fail("COORDINATOR_RESPONSE_INVALID"); }
  }
  private async snapshot(): Promise<CoordinatorReadinessSnapshot> {
    const c = await this.call("/api/internal/hub/endpoints", "GET");
    if (!c || c.format !== "atlas-coordinator-endpoint-snapshot-v1" || c.origin !== this.options.coordinatorOrigin || !Number.isSafeInteger(c.generation) || c.generation < 0 || !Array.isArray(c.nodes) || !Array.isArray(c.branches) || !Number.isFinite(Date.parse(c.observedAt)) || Math.abs(Date.now() - Date.parse(c.observedAt)) > 30_000) return fail("AUTHORITATIVE_COORDINATOR_SNAPSHOT_REQUIRED");
    origin(c.hubOrigin); const nodes = new Set<string>(), branches = new Set<string>();
    for (const n of c.nodes) { if (!n || typeof n.id !== "string" || !n.id || nodes.has(n.id)) return fail("COORDINATOR_SNAPSHOT_INVALID"); nodes.add(n.id); origin(n.endpoint); }
    for (const b of c.branches) { if (!b || !uuid(b.id) || !Number.isSafeInteger(b.generation) || b.generation < 1 || !Number.isSafeInteger(b.transitionRevision) || b.transitionRevision < 0 || typeof b.transitionActive !== "boolean" || branches.has(b.origin)) return fail("COORDINATOR_SNAPSHOT_INVALID"); branches.add(origin(b.origin)); }
    return c;
  }
  private async locked<T>(b: CutoverBinding, run: (c: PoolClient) => Promise<T>) {
    if (!uuid(b.jobId) || !uuid(b.operatorId) || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 0 || !sha(b.planHash) || !sha(b.assetManifestHash)) return fail("INVALID_CUTOVER_BINDING");
    const c = await this.options.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", ["atlas-production-cutover:" + b.jobId]);
      const actor = (await c.query("SELECT id FROM users WHERE id=$1 AND role='admin' AND status='active'", [b.operatorId])).rows[0]; if (!actor) return fail("ACTIVE_ADMINISTRATOR_REQUIRED");
      return await run(c);
    } finally { await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["atlas-production-cutover:" + b.jobId]).catch(() => {}); c.release(); }
  }
  private async transaction<T>(c: PoolClient, run: () => Promise<T>) { await c.query("BEGIN"); try { const v = await run(); await c.query("COMMIT"); return v; } catch (e) { await c.query("ROLLBACK"); throw e; } }
  private async loadJob(c: PoolClient, b: CutoverBinding, lock = false, requireConnected = true): Promise<CutoverJob & { approved_by: string | null; lease_owner: string | null }> {
    const j = (await c.query('SELECT id,state,revision,plan,plan_hash AS "planHash",checkpoint,approved_by,lease_owner FROM hub_cloud_jobs WHERE id=$1' + (lock ? " FOR UPDATE" : ""), [b.jobId])).rows[0];
    if (!j || hashPlan(j.plan) !== j.planHash || j.planHash !== b.planHash) return fail("IMMUTABLE_JOB_PLAN_CONFLICT");
    const account = (await c.query("SELECT expected_account_id,verified_account_id,status FROM hub_cloud_accounts WHERE id=$1", [j.plan.accountId])).rows[0];
    if (!account || requireConnected && account.status !== "connected" || account.expected_account_id !== j.plan.accountIdentity || account.verified_account_id !== j.plan.accountIdentity) return fail("VERIFIED_TARGET_ACCOUNT_REQUIRED");
    if (!uuid(j.approved_by)) return fail("APPROVED_PROVISIONING_JOB_REQUIRED");
    return j;
  }
  private async rows(c: PoolClient, j: CutoverJob) {
    const ids = j.plan.resources.flatMap(r => r.previous ? [r.previous.id] : []), keys = j.plan.resources.map(r => r.role + ":" + r.logicalId);
    const endpoints = (await c.query('SELECT id,role,logical_id AS "logicalId",account_id AS "accountId",distribution_id AS "distributionId",url,origin_host AS "originHost",revision,state FROM hub_cloud_endpoints WHERE id=ANY($1::uuid[]) OR role||\':\'||logical_id=ANY($2::text[])', [ids, keys])).rows as CutoverEndpoint[];
    const linkIds = j.plan.resources.filter(r => r.role === "frontend").map(r => r.logicalId); if (linkIds.some(x => !uuid(x))) return fail("INVALID_STABLE_LINK_ID");
    const branches = (await c.query('SELECT b.id,b.link_id AS "linkId",b.origin,b.enabled,l.url AS "linkURL",EXISTS(SELECT 1 FROM hub_cloud_branch_credentials x WHERE x.branch_id=b.id) AS "credentialStored" FROM hub_branches b JOIN links l ON l.id=b.link_id WHERE b.link_id=ANY($1::uuid[])', [linkIds])).rows as CutoverBranch[];
    const history = (await c.query('SELECT branch_id AS "branchId",origin,state FROM hub_branch_origins WHERE branch_id=ANY($1::uuid[])', [branches.map(x => x.id)])).rows;
    for (const branch of branches) branch.origins = history.filter(x => x.branchId === branch.id).map(({ origin, state }) => ({ origin, state }));
    return { endpoints, branches };
  }
  private decode(r: Receipt, b: CutoverBinding): Prepared {
    let p: Prepared; try { p = JSON.parse(decrypt(r.encrypted_payload, this.options.encryptionKey)); } catch { return fail("PREPARED_RECEIPT_UNREADABLE"); }
    if (p.format !== "atlas-production-cutover-prepared-v1" || cutoverDigest(p) !== r.binding_hash || p.coordinatorOrigin !== this.options.coordinatorOrigin || p.job.id !== b.jobId || p.job.revision !== b.expectedRevision || r.prepared_job_revision !== b.expectedRevision || r.plan_hash !== b.planHash || r.asset_manifest_hash !== b.assetManifestHash || cutoverDigest(p.job.checkpoint) !== r.checkpoint_hash || hashPlan(p.job.plan) !== b.planHash || p.probeUserId !== this.options.probeUserId) return fail("PREPARED_RECEIPT_BINDING_CONFLICT");
    return p;
  }
  private publicReceipt(r: Receipt, p: Prepared) {
    return { format: "atlas-production-cutover-stage-v1", jobId: r.job_id, jobRevision: r.prepared_job_revision, phase: r.phase, planHash: r.plan_hash, checkpointHash: r.checkpoint_hash, assetManifestHash: r.asset_manifest_hash, accountIdentity: p.job.plan.accountIdentity, coordinatorOrigin: p.coordinatorOrigin, probeUserId: p.probeUserId, registryStaged: !!r.staged_at, acceptanceHash: r.acceptance_hash, items: p.items.map(i => ({ resourceKey: i.resource.key, role: i.resource.role, logicalId: i.resource.logicalId, distributionId: i.distributionId, origin: i.origin, revision: i.revision, ...(i.branchId ? { branchId: i.branchId } : {}), ...(i.resource.previous ? { previousOrigin: i.resource.previous.url } : {}) })) };
  }
  private acceptedReceipt(r: Receipt, qualification?: { envelope: RuntimeAcceptanceEnvelope; trustedProbePublicKey: string }): Accepted {
    let accepted: Accepted; try { accepted = JSON.parse(decrypt(r.encrypted_acceptance!, this.options.encryptionKey)); } catch { return fail("ACCEPTANCE_RECEIPT_UNREADABLE"); }
    if (accepted.format !== "atlas-production-cutover-accepted-v1" || cutoverDigest(accepted) !== r.acceptance_hash) return fail("ACCEPTANCE_RECEIPT_INTEGRITY_FAILED");
    if (qualification) {
      const key = createPublicKey(qualification.trustedProbePublicKey), keyHash = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
      if (keyHash !== r.acceptance_key_hash || cutoverDigest(qualification.envelope.payload) !== cutoverDigest(accepted.evidence) || !verify(null, Buffer.from(canonicalCutoverJSON(qualification.envelope.payload)), key, Buffer.from(qualification.envelope.signature, "base64url"))) return fail("ACCEPTANCE_REPLAY_CONFLICT");
    }
    return accepted;
  }
  private async corroborate(c: PoolClient, evidence: RuntimeAcceptanceBody) {
    await corroborateRuntimeAcceptance(c, evidence);
    for (const proof of evidence.endpoints) if (proof.auth) {
      // Match the existing Hub assignment/eligibility boundary, not a special
      // probe-account exemption. Staging never creates these allocations.
      const allowed = await c.query("SELECT 1 FROM hub_branches b JOIN links l ON l.id=b.link_id JOIN link_assignments a ON a.link_id=l.id WHERE b.id=$1 AND a.user_id=$2 AND a.replaced_at IS NULL AND b.enabled AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now()) LIMIT 1", [proof.auth.branchId, proof.auth.userId]);
      if (!allowed.rowCount) return fail("PROBE_ACCOUNT_ASSIGNMENT_CHANGED");
    }
  }
  async stage(b: CutoverBinding) {
    return this.locked(b, async c => {
      let receipt = (await c.query("SELECT * FROM hub_cloud_cutovers WHERE job_id=$1", [b.jobId])).rows[0] as Receipt | undefined, prepared: Prepared;
      if (receipt) prepared = this.decode(receipt, b);
      else {
        const snapshot = await this.snapshot();
        prepared = await this.transaction(c, async () => {
          const j = await this.loadJob(c, b, true);
          if (j.state !== "ready_for_activation" || j.revision !== b.expectedRevision) return fail("JOB_REVISION_OR_STATE_CONFLICT");
          if (j.plan.resources.filter(r => r.role === "node").length > 1) return fail("QUALIFY_ONE_NODE_PER_OPERATION");
          const rows = await this.rows(c, j);
          createCutoverReadiness({ job: j, expectedRevision: b.expectedRevision, expectedPlanHash: b.planHash, assetManifestHash: b.assetManifestHash, coordinatorOrigin: this.options.coordinatorOrigin, ...rows });
          // Cancelled, never-committed attempts do not hold unrelated future
          // operations forever. Their receipt/callback backups remain retained.
          await c.query("UPDATE hub_cloud_cutover_targets t SET released=true FROM hub_cloud_cutovers x JOIN hub_cloud_jobs j ON j.id=x.job_id WHERE t.job_id=x.job_id AND x.phase='prepared' AND j.state='cancelled' AND NOT t.released");
          const items: PreparedItem[] = [];
          for (const resource of j.plan.resources) {
            const d = j.checkpoint.resources![resource.key]!, item: PreparedItem = { resource, distributionId: d.id, origin: "https://" + d.domain, revision: (resource.previous?.revision ?? 0) + 1 };
            if (resource.role === "frontend") {
              if (!resource.previous) return fail("NEW_FRONTEND_REQUIRES_EXPLICIT_STABLE_LINK_MAPPING");
              const link = (await c.query("SELECT id,url,enabled FROM links WHERE id=$1 FOR UPDATE", [resource.logicalId])).rows[0];
              if (!link || !link.enabled || link.url !== resource.previous.url) return fail("STABLE_LINK_CHANGED");
              let branch = (await c.query("SELECT * FROM hub_branches WHERE link_id=$1 FOR UPDATE", [resource.logicalId])).rows[0];
              if (!branch) {
                const secret = randomToken(); branch = (await c.query("INSERT INTO hub_branches(link_id,origin,secret_hash) VALUES($1,$2,$3) RETURNING *", [resource.logicalId, resource.previous.url, hashSecret(secret, this.options.sessionSecret)])).rows[0]; item.branchCreated = true;
                await c.query("INSERT INTO hub_cloud_branch_credentials(branch_id,encrypted_secret) VALUES($1,$2)", [branch.id, encrypt(secret, this.options.encryptionKey)]);
              }
              if (!branch.enabled || branch.origin !== resource.previous.url) return fail("STABLE_BRANCH_CHANGED");
              const stored = (await c.query("SELECT encrypted_secret FROM hub_cloud_branch_credentials WHERE branch_id=$1", [branch.id])).rows[0];
              let secret: string; try { secret = stored ? decrypt(stored.encrypted_secret, this.options.encryptionKey) : this.options.initialCredentials?.[branch.id] ?? ""; } catch { return fail("EXISTING_BRANCH_CREDENTIAL_UNREADABLE"); }
              if (!token(secret) || !safeEqual(hashSecret(secret, this.options.sessionSecret), branch.secret_hash)) return fail("EXACT_EXISTING_BRANCH_CREDENTIAL_REQUIRED");
              if (!stored) await c.query("INSERT INTO hub_cloud_branch_credentials(branch_id,encrypted_secret) VALUES($1,$2)", [branch.id, encrypt(secret, this.options.encryptionKey)]);
              const oldRegistry = snapshot.branches.find(x => x.origin === resource.previous!.url), newRegistry = snapshot.branches.find(x => x.origin === item.origin);
              if (oldRegistry && oldRegistry.id !== branch.id || newRegistry && newRegistry.id !== branch.id) return fail("BRANCH_REGISTRY_IDENTITY_CONFLICT");
              if (!oldRegistry && Number((await c.query("SELECT count(*) FROM hub_branch_sessions WHERE branch_id=$1 AND revoked_at IS NULL AND expires_at>now()", [branch.id])).rows[0].count)) return fail("ACTIVE_OLD_BRANCH_REGISTRY_REQUIRED");
              Object.assign(item, { branchId: branch.id, branchSecret: secret, oldRegistryGeneration: oldRegistry?.generation ?? 1, newRegistryGeneration: newRegistry?.generation ?? item.revision, oldTransitionRevision: oldRegistry?.transitionRevision ?? 0, oldTransitionActive: oldRegistry?.transitionActive ?? false });
              // Callback staging enables real auth qualification without changing
              // the canonical URL or granting another allocation.
              for (const [url, state] of [[resource.previous.url, "active"], [item.origin, "transition"]]) {
                const prior = (await c.query("SELECT state FROM hub_branch_origins WHERE branch_id=$1 AND origin=$2 FOR UPDATE", [branch.id, url])).rows[0];
                if (prior && prior.state !== state) return fail("CALLBACK_ORIGIN_STATE_CONFLICT");
                if (!prior) await c.query("INSERT INTO hub_branch_origins(branch_id,origin,state) VALUES($1,$2,$3)", [branch.id, url, state]);
              }
            }
            if (resource.role === "node" && (!this.options.probeUserId || !snapshot.nodes.some(n => n.id === resource.logicalId && (!resource.previous || n.endpoint === resource.previous.url)))) return fail("DEDICATED_PROBE_ACCOUNT_AND_STABLE_NODE_REQUIRED");
            // Initial V1→Hub bootstrap may configure Main directly with the new
            // Hub before old Dispenser endpoint history is recorded here. That
            // is an observed already-target binding, not a fictitious rotation.
            if (resource.role === "hub" && resource.previous && snapshot.hubOrigin !== resource.previous.url && snapshot.hubOrigin !== item.origin) return fail("PREVIOUS_HUB_ENDPOINT_CHANGED");
            items.push(item);
          }
          const p: Prepared = { format: "atlas-production-cutover-prepared-v1", job: j, coordinatorOrigin: this.options.coordinatorOrigin, coordinator: snapshot, probeUserId: this.options.probeUserId, items };
          await c.query("INSERT INTO hub_cloud_cutovers(job_id,prepared_job_revision,plan_hash,checkpoint_hash,asset_manifest_hash,binding_hash,operator_id,encrypted_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [b.jobId, b.expectedRevision, b.planHash, cutoverDigest(j.checkpoint), b.assetManifestHash, cutoverDigest(p), b.operatorId, encrypt(JSON.stringify(p), this.options.encryptionKey)]);
          for (const item of items) {
            try { await c.query("INSERT INTO hub_cloud_cutover_targets(job_id,role,logical_id) VALUES($1,$2,$3)", [b.jobId, item.resource.role, item.resource.logicalId]); }
            catch (e: any) { if (e.code === "23505") return fail("LOGICAL_TARGET_ALREADY_PREPARED"); throw e; }
          }
          await c.query("INSERT INTO hub_cloud_events(job_id,stage,code) VALUES($1,'cutover_prepared','PRODUCTION_CUTOVER_PREPARED')", [b.jobId]);
          return p;
        });
        receipt = (await c.query("SELECT * FROM hub_cloud_cutovers WHERE job_id=$1", [b.jobId])).rows[0];
      }
      if (receipt!.phase !== "prepared") return this.publicReceipt(receipt!, prepared);
      const currentJob = await this.loadJob(c, b);
      if (currentJob.state !== "ready_for_activation" || currentJob.revision !== b.expectedRevision) return fail("JOB_REVISION_OR_STATE_CONFLICT");
      for (const item of prepared.items) if (item.branchId) {
        for (const [url, generation] of [[item.resource.previous!.url, item.oldRegistryGeneration!], [item.origin, item.newRegistryGeneration!]] as Array<[string, number]>) {
          const reply = await this.call("/api/internal/hub/branches", "POST", { origin: url, id: item.branchId, secret: item.branchSecret, generation });
          if (reply?.ok !== true || reply.generation !== generation) return fail("BRANCH_REGISTRY_ACK_INVALID");
        }
      }
      for (const item of prepared.items) if (item.resource.role === "node") {
        const node = prepared.coordinator.nodes.find(n => n.id === item.resource.logicalId)!;
        const response = await this.call("/api/internal/hub/qualification-aliases", "POST", { jobId: b.jobId, planHash: b.planHash, probeAccountId: prepared.probeUserId, stableNodeId: item.resource.logicalId, expectedCurrentEndpoint: node.endpoint, candidateEndpoint: item.origin, expiresAt: new Date(Date.now() + 14 * 60_000).toISOString() });
        if (response?.ok !== true) return fail("QUALIFICATION_ALIAS_ACK_INVALID");
      }
      await this.options.fault?.("after-registry-staging");
      await c.query("UPDATE hub_cloud_cutovers SET staged_at=COALESCE(staged_at,now()),updated_at=now() WHERE job_id=$1", [b.jobId]);
      receipt = (await c.query("SELECT * FROM hub_cloud_cutovers WHERE job_id=$1", [b.jobId])).rows[0];
      return this.publicReceipt(receipt!, prepared);
    });
  }
  async commit(b: CutoverBinding, qualification?: { envelope: RuntimeAcceptanceEnvelope; trustedProbePublicKey: string }) {
    return this.locked(b, async c => {
      let receipt = (await c.query("SELECT * FROM hub_cloud_cutovers WHERE job_id=$1", [b.jobId])).rows[0] as Receipt | undefined;
      if (!receipt) return fail("STAGE_CUTOVER_BEFORE_QUALIFICATION");
      const prepared = this.decode(receipt, b);
      if (receipt.phase === "complete") { this.acceptedReceipt(receipt, qualification); return this.publicReceipt(receipt, prepared); }
      let accepted: Accepted;
      if (receipt.phase === "prepared") {
        if (!receipt.staged_at || !qualification) return fail("REAL_RUNTIME_QUALIFICATION_REQUIRED");
        const evidence = verifyRuntimeAcceptance(qualification.envelope, qualification.trustedProbePublicKey, { job: prepared.job, assetManifestHash: b.assetManifestHash, coordinatorOrigin: this.options.coordinatorOrigin });
        await this.corroborate(c, evidence);
        const authoritative = await this.snapshot();
        if (cutoverDigest({ ...authoritative, observedAt: "" }) !== cutoverDigest({ ...evidence.coordinator, observedAt: "" })) return fail("QUALIFIED_COORDINATOR_SNAPSHOT_CHANGED");
        const nodes: EndpointOperation["nodes"] = [], transitions: Accepted["transitions"] = [];
        let hubOrigin: string | undefined;
        for (const item of prepared.items) {
          const proof = evidence.endpoints.find(e => e.resourceKey === item.resource.key)!;
          if (item.branchId) {
            const old = authoritative.branches.find(x => x.origin === item.resource.previous!.url), next = authoritative.branches.find(x => x.origin === item.origin);
            if (proof.auth?.branchId !== item.branchId || !old || !next || old.id !== item.branchId || next.id !== item.branchId || old.generation !== item.oldRegistryGeneration || next.generation !== item.newRegistryGeneration) return fail("QUALIFIED_BRANCH_REGISTRY_CHANGED");
            transitions.push({ origin: item.resource.previous!.url, expectedGeneration: old.generation, revision: old.transitionActive ? old.transitionRevision : old.transitionRevision + 1, active: true });
          }
          if (item.resource.role === "hub") { if (authoritative.hubOrigin !== prepared.coordinator.hubOrigin) return fail("PREVIOUS_HUB_ENDPOINT_CHANGED"); if (authoritative.hubOrigin !== item.origin) hubOrigin = item.origin; }
          if (item.resource.role === "node") { const old = authoritative.nodes.find(n => n.id === item.resource.logicalId), before = prepared.coordinator.nodes.find(n => n.id === item.resource.logicalId); if (!old || !before || old.endpoint !== before.endpoint) return fail("PREVIOUS_NODE_ENDPOINT_CHANGED"); nodes.push({ id: old.id, previousEndpoint: old.endpoint, endpoint: item.origin }); }
        }
        const endpointOperation: EndpointOperation | null = hubOrigin || nodes.length ? { generation: authoritative.generation + 1, ...(hubOrigin ? { hubOrigin, previousHubOrigin: authoritative.hubOrigin } : {}), nodes } : null;
        accepted = { format: "atlas-production-cutover-accepted-v1", evidence, endpointOperation, transitions };
        await this.transaction(c, async () => {
          const j = await this.loadJob(c, b, true);
          if (j.state !== "ready_for_activation" || j.revision !== b.expectedRevision || cutoverDigest(j.checkpoint) !== receipt!.checkpoint_hash) return fail("JOB_REVISION_OR_STATE_CONFLICT");
          // A slow coordinator request must not turn an expired observation or
          // freshly revoked test session into accepted production evidence.
          verifyRuntimeAcceptance(qualification.envelope, qualification.trustedProbePublicKey, { job: prepared.job, assetManifestHash: b.assetManifestHash, coordinatorOrigin: this.options.coordinatorOrigin });
          await this.corroborate(c, evidence);
          // Recheck every endpoint/link under real row locks immediately before
          // publication. No account write, profile row or allocation is restored.
          for (const item of prepared.items) {
            const resource = item.resource;
            if (resource.previous) {
              const previous = (await c.query("SELECT * FROM hub_cloud_endpoints WHERE id=$1 FOR UPDATE", [resource.previous.id])).rows[0];
              if (!previous || previous.revision !== resource.previous.revision || !["active", "staged"].includes(previous.state) || previous.account_id !== resource.previous.accountId || previous.distribution_id !== resource.previous.distributionId || previous.url !== resource.previous.url || previous.logical_id !== resource.logicalId || previous.role !== resource.role || previous.origin_host !== resource.originHost) return fail("ENDPOINT_REVISION_CONFLICT");
              await c.query("UPDATE hub_cloud_endpoints SET state='transition' WHERE id=$1", [previous.id]);
            }
            if (item.branchId) {
              const branch = (await c.query("SELECT b.id,b.origin,l.url FROM hub_branches b JOIN links l ON l.id=b.link_id WHERE b.id=$1 AND b.link_id=$2 AND b.enabled AND l.enabled AND (l.expires_at IS NULL OR l.expires_at>now()) FOR UPDATE OF b,l", [item.branchId, resource.logicalId])).rows[0];
              if (!branch || branch.origin !== resource.previous!.url || branch.url !== resource.previous!.url) return fail("STABLE_LINK_OR_BRANCH_CHANGED");
              const callback = (await c.query("SELECT state FROM hub_branch_origins WHERE branch_id=$1 AND origin=$2 FOR UPDATE", [item.branchId, item.origin])).rows[0]; if (!callback || callback.state !== "transition") return fail("QUALIFIED_CALLBACK_STATE_CHANGED");
              await c.query("UPDATE links SET url=$2,updated_at=now() WHERE id=$1", [resource.logicalId, item.origin]);
              await c.query("UPDATE hub_branches SET origin=$2 WHERE id=$1", [item.branchId, item.origin]);
              await c.query("UPDATE hub_branch_origins SET state='transition' WHERE branch_id=$1 AND state='active'", [item.branchId]);
              await c.query("UPDATE hub_branch_origins SET state='active' WHERE branch_id=$1 AND origin=$2", [item.branchId, item.origin]);
            }
            await c.query("INSERT INTO hub_cloud_endpoints(role,logical_id,link_id,account_id,distribution_id,url,origin_host,revision,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')", [resource.role, resource.logicalId, resource.role === "frontend" ? resource.logicalId : null, prepared.job.plan.accountId, item.distributionId, item.origin, resource.originHost, item.revision]);
            if (resource.role === "hub") await c.query("INSERT INTO app_settings(key,value) VALUES('hub_current_origin',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(item.origin)]);
          }
          const keyHash = createHash("sha256").update(createPublicKey(qualification.trustedProbePublicKey).export({ type: "spki", format: "der" })).digest("hex");
          await c.query("UPDATE hub_cloud_cutovers SET phase='database_committed',acceptance_hash=$2,encrypted_acceptance=$3,acceptance_key_hash=$4,database_committed_at=now(),updated_at=now() WHERE job_id=$1 AND phase='prepared'", [b.jobId, cutoverDigest(accepted), encrypt(JSON.stringify(accepted), this.options.encryptionKey), keyHash]);
          await c.query("UPDATE hub_cloud_jobs SET state='running',revision=revision+1,lease_owner=$2,lease_until='infinity',updated_at=now() WHERE id=$1", [b.jobId, receipt!.id]);
          await c.query("INSERT INTO hub_cloud_events(job_id,stage,code) VALUES($1,'cutover_database_committed','RUNTIME_ACCEPTANCE_VERIFIED')", [b.jobId]);
        });
        await this.options.fault?.("after-database-commit");
        receipt = (await c.query("SELECT * FROM hub_cloud_cutovers WHERE job_id=$1", [b.jobId])).rows[0];
      } else {
        accepted = this.acceptedReceipt(receipt, qualification);
      }
      // Exact replay of these persisted bodies is the only retry operation.
      // Expired pre-cutover browser proof is not fabricated or rerun after the
      // atomic publication; its immutable positive acknowledgement is retained.
      if (accepted.endpointOperation) {
        const result = await this.call("/api/internal/hub/endpoints", "POST", accepted.endpointOperation);
        if (result?.ok !== true || result.generation !== accepted.endpointOperation.generation) return fail("COORDINATOR_ENDPOINT_ACK_INVALID");
      }
      await this.options.fault?.("after-endpoint-rotation");
      for (const transition of accepted.transitions) {
        const result = await this.call("/api/internal/hub/branch-transitions", "POST", transition);
        if (result?.ok !== true || result.generation !== transition.expectedGeneration || result.revision !== transition.revision || result.active !== true) return fail("COORDINATOR_TRANSITION_ACK_INVALID");
      }
      for (const item of prepared.items) if (item.resource.role === "node") {
        const reply = await this.call("/api/internal/hub/qualification-aliases", "DELETE", { jobId: b.jobId, planHash: b.planHash, probeAccountId: prepared.probeUserId, stableNodeId: item.resource.logicalId });
        if (reply?.ok !== true) return fail("QUALIFICATION_ALIAS_RELEASE_ACK_INVALID");
      }
      await this.options.fault?.("before-complete");
      await this.transaction(c, async () => {
        const latest = (await c.query("SELECT phase FROM hub_cloud_cutovers WHERE job_id=$1 FOR UPDATE", [b.jobId])).rows[0];
        if (latest.phase !== "database_committed") return fail("CUTOVER_PHASE_CHANGED");
        const j = await this.loadJob(c, b, true, false);
        if (j.state !== "running" || j.revision !== b.expectedRevision + 1 || j.lease_owner !== receipt!.id || cutoverDigest(j.checkpoint) !== receipt!.checkpoint_hash) return fail("COMMITTED_JOB_CHANGED");
        await c.query("UPDATE hub_cloud_cutovers SET phase='complete',completed_at=now(),updated_at=now() WHERE job_id=$1", [b.jobId]);
        await c.query("UPDATE hub_cloud_jobs SET state='complete',revision=revision+1,lease_owner=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=$1", [b.jobId]);
        await c.query("UPDATE hub_cloud_cutover_targets SET released=true WHERE job_id=$1", [b.jobId]);
        await c.query("INSERT INTO hub_cloud_events(job_id,stage,code) VALUES($1,'complete','PRODUCTION_CUTOVER_ACTIVATED')", [b.jobId]);
      });
      receipt = (await c.query("SELECT * FROM hub_cloud_cutovers WHERE job_id=$1", [b.jobId])).rows[0];
      return this.publicReceipt(receipt!, prepared);
    });
  }
}
