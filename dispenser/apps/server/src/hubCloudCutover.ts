/** Operator READINESS only. This module never provisions, mutates registry rows,
 * assigns links, redirects browsers, or marks a cloud job complete. An observed
 * health response is deliberately insufficient runtime acceptance. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { hashPlan, type CloudPlan, type CloudCheckpoint, type CloudRole } from "./hubCloudWorker.js";

export class CutoverReadinessError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new CutoverReadinessError(code); };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
export function canonicalCutoverJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalCutoverJSON).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ":" + canonicalCutoverJSON(v)).join(",") + "}";
  return JSON.stringify(value);
}
export const cutoverDigest = (value: unknown) => createHash("sha256").update(canonicalCutoverJSON(value)).digest("hex");
function origin(value: unknown, protocols = ["https:"]): string {
  if (typeof value !== "string") return fail("INVALID_ORIGIN");
  let u: URL; try { u = new URL(value); } catch { return fail("INVALID_ORIGIN"); }
  if (!protocols.includes(u.protocol) || u.origin !== value || u.username || u.password) return fail("INVALID_ORIGIN");
  return u.origin;
}
function date(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fail("INVALID_OBSERVATION_TIME");
  return Date.parse(value);
}
export type CutoverJob = { id: string; state: string; revision: number; plan: CloudPlan; planHash: string; checkpoint: CloudCheckpoint };
export type CutoverEndpoint = { id: string; role: CloudRole; logicalId: string; accountId: string; distributionId: string; url: string; originHost: string; revision: number; state: string };
export type CutoverBranch = { id: string; linkId: string; origin: string; enabled: boolean; linkURL: string; credentialStored: boolean; origins: Array<{ origin: string; state: string }> };
export type CoordinatorReadinessSnapshot = {
  format: "atlas-coordinator-endpoint-snapshot-v1";
  origin: string; observedAt: string; generation: number; hubOrigin: string;
  nodes: Array<{ id: string; endpoint: string }>;
  branches: Array<{ origin: string; id: string; generation: number; transitionRevision: number; transitionActive: boolean }>;
};
type WebSocketObservation = { url: string; openedAt: string; closedAt: string; sentSHA256: string; receivedSHA256: string; sentBytes: number; receivedBytes: number; sessionId: string };
export type RuntimeEndpointObservation = {
  resourceKey: string; distributionId: string; origin: string; role: CloudRole; assetManifestHash: string;
  auth?: { kind: "account-bound-handoff"; branchId: string; userId: string; profileId: string; sessionId: string; callbackOrigin: string; redeemedCodeHash: string; redeemedAt: string; replayHTTPStatus: number; cookieAttributes: string[] };
  profile?: { profileId: string; namespace: [string, string, string]; idempotencyKey: string; revision: number; payloadHash: string; sourceValueHash: string; restoredValueHash: string; acknowledgedAt: string; restoredAt: string };
  websocket?: WebSocketObservation;
  hubSession?: { sessionId: string; userId: string; HTTPStatus: number; cookieAttributes: string[] };
  nodeIdentity?: { expectedId: string; observedId: string };
};
export type RuntimeAcceptanceBody = {
  format: "atlas-runtime-acceptance-v1"; jobId: string; jobRevision: number; planHash: string; checkpointHash: string;
  accountIdentity: string; assetManifestHash: string; observedAt: string; expiresAt: string;
  coordinator: CoordinatorReadinessSnapshot; endpoints: RuntimeEndpointObservation[];
};
export type RuntimeAcceptanceEnvelope = { format: "atlas-runtime-acceptance-envelope-v1"; payload: RuntimeAcceptanceBody; signature: string };
function cookieAttributes(value: unknown) {
  return Array.isArray(value) && ["Secure", "HttpOnly", "Path=/", "HostOnly"].every(v => value.includes(v)) && value.some(v => v === "SameSite=Lax" || v === "SameSite=Strict");
}
/** The public key MUST come from operator-controlled configuration, not from the
 * envelope. A signature proves producer provenance, not that health is auth.
 * Detailed actual event/receipt claims and database corroboration remain required. */
export function verifyRuntimeAcceptance(envelope: RuntimeAcceptanceEnvelope, publicKey: string, expected: { job: CutoverJob; assetManifestHash: string; coordinatorOrigin: string; now?: number }): RuntimeAcceptanceBody {
  const now = expected.now ?? Date.now();
  if (!envelope || envelope.format !== "atlas-runtime-acceptance-envelope-v1" || typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) return fail("SIGNED_RUNTIME_EVIDENCE_REQUIRED");
  let key; try { key = createPublicKey(publicKey); } catch { return fail("TRUSTED_PROBE_KEY_INVALID"); }
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(canonicalCutoverJSON(envelope.payload)), key, Buffer.from(envelope.signature, "base64url"))) return fail("RUNTIME_EVIDENCE_SIGNATURE_INVALID");
  const p = envelope.payload, j = expected.job;
  if (!p || p.format !== "atlas-runtime-acceptance-v1" || p.jobId !== j.id || p.jobRevision !== j.revision || p.planHash !== j.planHash || p.checkpointHash !== cutoverDigest(j.checkpoint) || p.accountIdentity !== j.plan.accountIdentity || p.assetManifestHash !== expected.assetManifestHash) return fail("RUNTIME_EVIDENCE_BINDING_MISMATCH");
  const observed = date(p.observedAt), expires = date(p.expiresAt);
  if (observed > now + 30_000 || observed < now - 15 * 60_000 || expires <= now || expires <= observed || expires - observed > 15 * 60_000) return fail("RUNTIME_EVIDENCE_EXPIRED");
  const c = p.coordinator;
  if (!c || c.format !== "atlas-coordinator-endpoint-snapshot-v1" || origin(c.origin) !== expected.coordinatorOrigin || !integer(c.generation) || !Array.isArray(c.nodes) || !Array.isArray(c.branches) || date(c.observedAt) < observed - 30_000 || date(c.observedAt) > now + 30_000) return fail("COORDINATOR_SNAPSHOT_REQUIRED");
  origin(c.hubOrigin);
  const nodeIds = new Set<string>(), branchOrigins = new Set<string>();
  for (const n of c.nodes) { if (!n || typeof n.id !== "string" || !n.id || nodeIds.has(n.id)) return fail("COORDINATOR_SNAPSHOT_INVALID"); nodeIds.add(n.id); origin(n.endpoint); }
  for (const b of c.branches) { if (!b || !uuid(b.id) || !integer(b.generation, 1) || !integer(b.transitionRevision) || typeof b.transitionActive !== "boolean" || branchOrigins.has(origin(b.origin))) return fail("COORDINATOR_SNAPSHOT_INVALID"); branchOrigins.add(b.origin); }
  if (!Array.isArray(p.endpoints) || p.endpoints.length !== j.plan.resources.length) return fail("ENDPOINT_EVIDENCE_INCOMPLETE");
  const seen = new Set<string>();
  const permittedRelayOrigins = new Set([...c.nodes.map(n => n.endpoint), ...Object.values(j.checkpoint.resources ?? {}).map(d => "https://" + d.domain)]);
  for (const proof of p.endpoints) {
    const resource = j.plan.resources.find(r => r.key === proof.resourceKey), distribution = j.checkpoint.resources?.[proof.resourceKey];
    if (!resource || !distribution || seen.has(proof.resourceKey) || proof.role !== resource.role || proof.distributionId !== distribution.id || proof.origin !== "https://" + distribution.domain || proof.assetManifestHash !== expected.assetManifestHash) return fail("ENDPOINT_EVIDENCE_BINDING_MISMATCH");
    seen.add(proof.resourceKey); origin(proof.origin);
    if (proof.role === "frontend") {
      const a = proof.auth, s = proof.profile;
      if (!a || a.kind !== "account-bound-handoff" || !uuid(a.branchId) || !uuid(a.userId) || !uuid(a.profileId) || !uuid(a.sessionId) || a.callbackOrigin !== proof.origin || !digest(a.redeemedCodeHash) || ![400, 409].includes(a.replayHTTPStatus) || !cookieAttributes(a.cookieAttributes) || date(a.redeemedAt) < observed - 30_000 || date(a.redeemedAt) > Math.min(expires, now + 30_000)) return fail("AUTH_HANDOFF_REPLAY_COOKIE_EVIDENCE_REQUIRED");
      if (!s || s.profileId !== a.profileId || !Array.isArray(s.namespace) || s.namespace.length !== 3 || !["local", "idb", "cookies"].includes(s.namespace[0]) || typeof s.namespace[1] !== "string" || typeof s.namespace[2] !== "string" || !/^[A-Za-z0-9_-]{16,96}$/.test(s.idempotencyKey) || !integer(s.revision, 1) || !digest(s.payloadHash) || !digest(s.sourceValueHash) || s.sourceValueHash !== s.restoredValueHash || date(s.acknowledgedAt) < observed - 30_000 || date(s.acknowledgedAt) > now + 30_000 || date(s.restoredAt) < date(s.acknowledgedAt) || date(s.restoredAt) > Math.min(expires, now + 30_000)) return fail("ACKNOWLEDGED_PROFILE_ROUNDTRIP_REQUIRED");
      origin(s.namespace[1], ["http:", "https:"]);
    }
    if (proof.role === "hub") {
      const s = proof.hubSession;
      if (!s || !uuid(s.sessionId) || !uuid(s.userId) || s.HTTPStatus !== 200 || !cookieAttributes(s.cookieAttributes)) return fail("HUB_SESSION_EVIDENCE_REQUIRED");
    }
    if (proof.role === "node" && (!proof.nodeIdentity || proof.nodeIdentity.expectedId !== resource.logicalId || proof.nodeIdentity.observedId !== resource.logicalId)) return fail("STABLE_NODE_IDENTITY_EVIDENCE_REQUIRED");
    if (proof.role !== "hub") {
      const w = proof.websocket; let relayOrigin: string;
      try { const u = new URL(w?.url ?? ""); if (u.protocol !== "wss:" || u.username || u.password || u.hash) return fail("AUTHENTICATED_WSS_ROUNDTRIP_REQUIRED"); relayOrigin = "https://" + u.host; } catch { return fail("AUTHENTICATED_WSS_ROUNDTRIP_REQUIRED"); }
      if (!w || !permittedRelayOrigins.has(relayOrigin) || proof.role === "node" && relayOrigin !== proof.origin || !uuid(w.sessionId) || proof.auth && w.sessionId !== proof.auth.sessionId || !digest(w.sentSHA256) || w.sentSHA256 !== w.receivedSHA256 || !integer(w.sentBytes, 16) || w.receivedBytes !== w.sentBytes || date(w.openedAt) < observed - 30_000 || date(w.openedAt) > now + 30_000 || date(w.closedAt) < date(w.openedAt) || date(w.closedAt) > Math.min(expires, now + 30_000)) return fail("AUTHENTICATED_WSS_ROUNDTRIP_REQUIRED");
    }
  }
  return p;
}
export type RuntimeDatabaseCorroboration = { evidenceHash: string; observedAt: string; frontendSessions: string[]; profileReceipts: string[]; hubSessions: string[] };
/** Read-only corroboration against real Hub rows; no synthetic writer, sign-in,
 * import, allocation or commit is manufactured to make the report green. */
export async function corroborateRuntimeAcceptance(db: { query(sql: string, values: unknown[]): Promise<{ rows: any[] }> }, evidence: RuntimeAcceptanceBody): Promise<RuntimeDatabaseCorroboration> {
  const frontendSessions: string[] = [], profileReceipts: string[] = [], hubSessions: string[] = [];
  for (const proof of evidence.endpoints) {
    if (proof.role === "frontend") {
      const a = proof.auth!, s = proof.profile!;
      const session = (await db.query("SELECT bs.id FROM hub_branch_sessions bs JOIN sessions ps ON ps.id=bs.parent_session_id JOIN users u ON u.id=bs.user_id JOIN hub_profiles p ON p.id=bs.profile_id WHERE bs.id=$1 AND bs.branch_id=$2 AND bs.user_id=$3 AND bs.profile_id=$4 AND p.user_id=u.id AND bs.revoked_at IS NULL AND bs.expires_at>now() AND ps.revoked_at IS NULL AND ps.expires_at>now() AND u.status='active'", [a.sessionId, a.branchId, a.userId, a.profileId])).rows[0];
      if (!session) return fail("LIVE_ACCOUNT_SESSION_CORROBORATION_FAILED");
      const receipt = (await db.query("SELECT revision,payload_hash FROM hub_commits WHERE profile_id=$1 AND idempotency_key=$2 AND namespace=$3", [s.profileId, s.idempotencyKey, JSON.stringify(s.namespace)])).rows[0];
      if (!receipt || Number(receipt.revision) !== s.revision || receipt.payload_hash !== s.payloadHash) return fail("IMMUTABLE_PROFILE_RECEIPT_CORROBORATION_FAILED");
      const handoff = (await db.query("SELECT code_hash FROM hub_handoffs WHERE code_hash=$1 AND branch_id=$2 AND user_id=$3 AND callback_origin=$4 AND used_at IS NOT NULL", [a.redeemedCodeHash, a.branchId, a.userId, proof.origin])).rows[0];
      if (!handoff) return fail("REDEEMED_HANDOFF_CORROBORATION_FAILED");
      frontendSessions.push(a.sessionId); profileReceipts.push(s.profileId + ":" + s.idempotencyKey);
    }
    if (proof.role === "hub") {
      const s = proof.hubSession!, row = (await db.query("SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'", [s.sessionId, s.userId])).rows[0];
      if (!row) return fail("LIVE_HUB_SESSION_CORROBORATION_FAILED"); hubSessions.push(s.sessionId);
    }
  }
  return { evidenceHash: cutoverDigest(evidence), observedAt: new Date().toISOString(), frontendSessions, profileReceipts, hubSessions };
}
export function createCutoverReadiness(input: {
  job: CutoverJob; expectedRevision: number; expectedPlanHash: string; assetManifestHash: string; coordinatorOrigin: string;
  endpoints: CutoverEndpoint[]; branches: CutoverBranch[]; envelope?: RuntimeAcceptanceEnvelope; trustedProbePublicKey?: string;
  corroboration?: RuntimeDatabaseCorroboration; now?: number;
}) {
  const { job: j } = input, now = input.now ?? Date.now();
  if (!uuid(j.id) || !integer(j.revision) || j.revision !== input.expectedRevision || j.state !== "ready_for_activation" || hashPlan(j.plan) !== j.planHash || j.planHash !== input.expectedPlanHash || !digest(input.assetManifestHash)) return fail("JOB_PLAN_OR_REVISION_CONFLICT");
  origin(input.coordinatorOrigin);
  if (!Array.isArray(j.plan.resources) || !j.plan.resources.length || !/^\d{12}$/.test(j.plan.accountIdentity) || !uuid(j.plan.accountId)) return fail("INVALID_CLOUD_PLAN");
  if (j.plan.resources.filter(r => r.role === "hub").length > 1) return fail("MULTIPLE_HUB_DESTINATIONS_UNSUPPORTED");
  const keys = new Set<string>(), targetOrigins = new Set<string>();
  for (const resource of j.plan.resources) {
    const d = j.checkpoint.resources?.[resource.key];
    if (keys.has(resource.key) || !d || d.status !== "Deployed" || !/^[A-Z0-9]{8,64}$/.test(d.id) || d.id.startsWith("FAKE") || !/^d[a-z0-9]+\.cloudfront\.net$/.test(d.domain) || d.caller !== `atlas-hub-${j.id}-${resource.key}` || d.originHost !== resource.originHost || targetOrigins.has(d.domain)) return fail("EXACT_DEPLOYED_CHECKPOINT_REQUIRED");
    keys.add(resource.key); targetOrigins.add(d.domain);
    const active = input.endpoints.filter(e => e.role === resource.role && e.logicalId === resource.logicalId && e.state === "active");
    if (resource.previous) {
      const p = resource.previous, row = input.endpoints.find(e => e.id === p.id);
      if (!row || !["active", "staged"].includes(row.state) || row.revision !== p.revision || row.accountId !== p.accountId || row.distributionId !== p.distributionId || row.url !== p.url || row.role !== resource.role || row.logicalId !== resource.logicalId || row.originHost !== resource.originHost || active.some(e => e.id !== row.id)) return fail("ENDPOINT_REVISION_CONFLICT");
    } else if (active.length) return fail("LOGICAL_ENDPOINT_ALREADY_ACTIVE");
  }
  if (Object.keys(j.checkpoint.resources ?? {}).length !== keys.size) return fail("CHECKPOINT_RESOURCE_SET_MISMATCH");
  let evidence: RuntimeAcceptanceBody | undefined;
  const blockers: string[] = [];
  if (input.envelope) {
    if (!input.trustedProbePublicKey) return fail("TRUSTED_PROBE_KEY_REQUIRED");
    evidence = verifyRuntimeAcceptance(input.envelope, input.trustedProbePublicKey, { job: j, assetManifestHash: input.assetManifestHash, coordinatorOrigin: input.coordinatorOrigin, now });
    if (!input.corroboration || input.corroboration.evidenceHash !== cutoverDigest(evidence) || Math.abs(now - date(input.corroboration.observedAt)) > 30_000) blockers.push("LIVE_HUB_DATABASE_CORROBORATION_REQUIRED");
    else {
      for (const p of evidence.endpoints) {
        if (p.auth && !input.corroboration.frontendSessions.includes(p.auth.sessionId) || p.profile && !input.corroboration.profileReceipts.includes(p.profile.profileId + ":" + p.profile.idempotencyKey) || p.hubSession && !input.corroboration.hubSessions.includes(p.hubSession.sessionId)) return fail("DATABASE_CORROBORATION_SET_MISMATCH");
      }
    }
  } else blockers.push("REAL_SIGNED_AUTH_PROFILE_WSS_ACCEPTANCE_REQUIRED", "TRUSTED_COORDINATOR_ENDPOINT_SNAPSHOT_REQUIRED");
  const operations: Array<Record<string, unknown>> = [];
  for (const resource of j.plan.resources) {
    const distribution = j.checkpoint.resources![resource.key]!, nextOrigin = "https://" + distribution.domain;
    if (resource.role === "frontend") {
      const branch = input.branches.find(b => b.linkId === resource.logicalId);
      if (!resource.previous || !branch) { blockers.push("NEW_FRONTEND_STABLE_LINK_AND_BRANCH_STAGING_REQUIRED:" + resource.key); continue; }
      if (!uuid(branch.id) || !branch.enabled || branch.origin !== resource.previous.url || branch.linkURL !== resource.previous.url) return fail("STABLE_BRANCH_OR_LINK_CONFLICT");
      if (branch.origins.some(o => o.origin === nextOrigin && !["active", "transition"].includes(o.state))) return fail("DESTINATION_CALLBACK_STATE_CONFLICT");
      if (!branch.credentialStored) blockers.push("EXACT_EXISTING_BRANCH_CREDENTIAL_REQUIRED:" + resource.key);
      const oldRegistry = evidence?.coordinator.branches.find(b => b.origin === resource.previous!.url);
      const newRegistry = evidence?.coordinator.branches.find(b => b.origin === nextOrigin);
      if (newRegistry && newRegistry.id !== branch.id) return fail("DESTINATION_BRANCH_REGISTRY_CONFLICT");
      if (!oldRegistry || oldRegistry.id !== branch.id) blockers.push("VERIFIED_OLD_BRANCH_REGISTRY_REQUIRED:" + resource.key);
      const observed = evidence?.endpoints.find(p => p.resourceKey === resource.key);
      if (observed?.auth && observed.auth.branchId !== branch.id) return fail("ACCEPTANCE_BRANCH_IDENTITY_CONFLICT");
      if (observed?.auth && !branch.origins.some(o => o.origin === nextOrigin && ["active", "transition"].includes(o.state))) return fail("ACCEPTANCE_CALLBACK_NOT_REGISTERED");
      operations.push({ phase: "stage_before_runtime_probes", operation: "hub.callback-origin.stage", branchId: branch.id, linkId: branch.linkId,
        guard: { branchOrigin: resource.previous.url, linkURL: resource.previous.url, endpointId: resource.previous.id, endpointRevision: resource.previous.revision, jobRevision: j.revision, planHash: j.planHash },
        transaction: [
          { sql: "SELECT b.id FROM hub_branches b JOIN links l ON l.id=b.link_id JOIN hub_cloud_endpoints e ON e.link_id=l.id WHERE b.id=$1 AND b.link_id=$2 AND b.origin=$3 AND l.url=$3 AND e.id=$4 AND e.revision=$5 AND e.state IN ('active','staged') FOR UPDATE OF b,l,e", values: [branch.id, branch.linkId, resource.previous.url, resource.previous.id, resource.previous.revision], requiredRows: 1 },
          { sql: "INSERT INTO hub_branch_origins(branch_id,origin,state) VALUES($1,$2,'transition') ON CONFLICT(branch_id,origin) DO NOTHING", values: [branch.id, nextOrigin], requiredStateAfter: "transition-or-already-active", preserveOldActiveOrigin: true },
        ], requiresExplicitOperatorTransaction: true });
      operations.push({ phase: "stage_before_runtime_probes", operation: "atlas.branch.register", endpoint: input.coordinatorOrigin + "/api/internal/hub/branches", method: "POST", body: { origin: nextOrigin, id: branch.id, secret: { privateCredentialRef: "hub_cloud_branch_credentials:" + branch.id }, generation: newRegistry?.generation ?? resource.previous.revision + 1 }, noCredentialRotation: true });
      operations.push({ phase: "after_all_real_runtime_receipts", operation: "atlas.old-origin.sync-transition", endpoint: input.coordinatorOrigin + "/api/internal/hub/branch-transitions", method: "POST", body: { origin: resource.previous.url, expectedGeneration: oldRegistry?.generation ?? "VERIFIED_STORED_GENERATION", revision: oldRegistry ? oldRegistry.transitionActive ? oldRegistry.transitionRevision : oldRegistry.transitionRevision + 1 : "NEXT_VERIFIED_TRANSITION_REVISION", active: true }, oldSessionsRemainValid: true });
      operations.push({ phase: "operator_revision_checked_cutover", operation: "hub.stable-link.replace-endpoint", logicalLinkId: branch.linkId, branchId: branch.id, previousOrigin: resource.previous.url, nextOrigin, expectedEndpointId: resource.previous.id, expectedEndpointRevision: resource.previous.revision, nextEndpointRevision: resource.previous.revision + 1, retainAssignments: true, retainQuotaUsage: true, retainProfiles: true, retainOldDistribution: true, receiptPhasesRequired: ["prepared", "database_committed", "coordinator_committed"], atomicHubTables: ["links.url", "hub_branches.origin", "hub_branch_origins.state", "hub_cloud_endpoints.state"] });
    }
  }
  const coordinator = evidence?.coordinator, mutation: Record<string, unknown> = { generation: coordinator ? coordinator.generation + 1 : "NEXT_VERIFIED_ENDPOINT_GENERATION", nodes: [] };
  for (const resource of j.plan.resources) {
    const next = "https://" + j.checkpoint.resources![resource.key]!.domain;
    if (resource.role === "hub") {
      if (!resource.previous || coordinator && coordinator.hubOrigin !== resource.previous.url) blockers.push("VERIFIED_PREVIOUS_HUB_ENDPOINT_REQUIRED:" + resource.key);
      mutation.hubOrigin = next; mutation.previousHubOrigin = resource.previous?.url ?? "VERIFIED_PREVIOUS_HUB_ORIGIN";
      operations.push({ phase: "operator_revision_checked_cutover", operation: "hub.discovery.replace-origin", previousOrigin: resource.previous?.url, nextOrigin: next, settingsKey: "hub_current_origin", stableLogicalHubId: resource.logicalId, retainOldHubSessionsAndOrigin: true });
    }
    if (resource.role === "node") {
      const old = coordinator?.nodes.find(n => n.id === resource.logicalId);
      if (!old || resource.previous && old.endpoint !== resource.previous.url) blockers.push("VERIFIED_STABLE_NODE_ENDPOINT_REQUIRED:" + resource.key);
      (mutation.nodes as unknown[]).push({ id: resource.logicalId, previousEndpoint: old?.endpoint ?? "VERIFIED_PREVIOUS_NODE_ENDPOINT", endpoint: next });
    }
  }
  if (mutation.hubOrigin || (mutation.nodes as unknown[]).length) operations.push({ phase: "durable_database_commit_then_idempotent_coordinator_commit", operation: "atlas.endpoint.rotate", endpoint: input.coordinatorOrigin + "/api/internal/hub/endpoints", method: "POST", body: mutation, retainNodeCredentialsAndIds: true, expectedReplay: "same-generation-and-exact-body-hash-only" });
  // A readiness manifest is immutable by content hash, not a durable execution
  // receipt. Existing hub_cloud_activation is simulation-only; production has
  // no reviewed executor/immutable acceptance receipt consumer yet.
  blockers.push("PRODUCTION_DURABLE_EXECUTOR_AND_ACCEPTANCE_RECEIPT_CONSUMER_NOT_IMPLEMENTED");
  const manifest = { format: "atlas-cloud-cutover-readiness-v1", createdAt: new Date(now).toISOString(), jobId: j.id, jobRevision: j.revision, planHash: j.planHash, checkpointHash: cutoverDigest(j.checkpoint), assetManifestHash: input.assetManifestHash, accountIdentity: j.plan.accountIdentity, evidenceHash: evidence ? cutoverDigest(evidence) : null, evidenceProvenanceVerified: !!evidence, liveHubCorroborated: !!evidence && !blockers.includes("LIVE_HUB_DATABASE_CORROBORATION_REQUIRED"), activationImplemented: false, productionMutationsPerformed: false, status: "held_for_explicit_operator_cutover" as const, blockers: [...new Set(blockers)], operations, rollbackRules: ["Retain both old origins and distributions until browser-only saves are acknowledged and independently restored.", "Restore presentation/routing with a new checked revision; never replace databases with old snapshots over subsequent writes.", "Do not delete browser stores, profile records, assignments, allocation counters, node identities, keys or credentials."], scope: "Readiness only; this manifest neither runs its described operations nor marks a job accepted/complete." };
  return { ...manifest, manifestHash: cutoverDigest(manifest) };
}
