import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { makePlan, type CloudResource } from "./hubCloudWorker.js";
import { canonicalCutoverJSON, cutoverDigest, verifyRuntimeAcceptance, corroborateRuntimeAcceptance, createCutoverReadiness, type CutoverJob, type CutoverEndpoint, type CutoverBranch, type RuntimeAcceptanceBody, type RuntimeAcceptanceEnvelope } from "./hubCloudCutover.js";

const id = (n: number) => n.toString(16).padStart(8, "0") + "-1111-4111-8111-111111111111";
const now = Date.parse("2026-10-21T23:00:00Z"), at = (delta = 0) => new Date(now + delta).toISOString();
const hash = "a".repeat(64), valueHash = "b".repeat(64), asset = "c".repeat(64);
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const resources: CloudResource[] = ["frontend", "hub", "node"].map((role, i) => ({ key: "resource-" + i, role: role as CloudResource["role"], logicalId: role === "frontend" ? id(20) : role === "node" ? "node-two" : "hub-main", originHost: role + ".origin.example", previous: { id: id(30 + i), revision: 3, distributionId: "EOLD12345" + i, accountId: id(40), url: "https://old-" + role + ".example" } }));
  const plan = makePlan({ id: id(50), expectedAccountId: "222222222222", region: "us-east-1" }, resources);
  const job: CutoverJob = { id: id(1), state: "ready_for_activation", revision: 7, plan, planHash: "", checkpoint: { resources: Object.fromEntries(resources.map((r, i) => [r.key, { id: "ENEW12345" + i, domain: "dnew" + i + ".cloudfront.net", status: "Deployed", caller: "atlas-hub-" + id(1) + "-" + r.key, originHost: r.originHost }])) } };
  // Same immutable canonical hashing as the actual queued worker plan.
  job.planHash = cutoverDigest(plan);
  const endpoints: CutoverEndpoint[] = resources.map(r => ({ id: r.previous!.id, role: r.role, logicalId: r.logicalId, accountId: r.previous!.accountId, distributionId: r.previous!.distributionId, url: r.previous!.url, originHost: r.originHost, revision: 3, state: "active" }));
  const branches: CutoverBranch[] = [{ id: id(60), linkId: id(20), origin: resources[0]!.previous!.url, enabled: true, linkURL: resources[0]!.previous!.url, credentialStored: true, origins: [{ origin: resources[0]!.previous!.url, state: "active" }, { origin: "https://dnew0.cloudfront.net", state: "transition" }] }];
  const cookieAttributes = ["Secure", "HttpOnly", "HostOnly", "Path=/", "SameSite=Lax"];
  const evidence: RuntimeAcceptanceBody = { format: "atlas-runtime-acceptance-v1", jobId: job.id, jobRevision: job.revision, planHash: job.planHash, checkpointHash: cutoverDigest(job.checkpoint), accountIdentity: plan.accountIdentity, assetManifestHash: asset, observedAt: at(), expiresAt: at(10 * 60_000), coordinator: { format: "atlas-coordinator-endpoint-snapshot-v1", origin: "https://coordinator.example", observedAt: at(), generation: 5, hubOrigin: "https://old-hub.example", nodes: [{ id: "node-two", endpoint: "https://old-node.example" }], branches: [{ origin: "https://old-frontend.example", id: id(60), generation: 9, transitionRevision: 2, transitionActive: false }, { origin: "https://dnew0.cloudfront.net", id: id(60), generation: 4, transitionRevision: 0, transitionActive: false }] }, endpoints: [
    { resourceKey: "resource-0", role: "frontend", distributionId: "ENEW123450", origin: "https://dnew0.cloudfront.net", assetManifestHash: asset, auth: { kind: "account-bound-handoff", branchId: id(60), userId: id(70), profileId: id(71), sessionId: id(72), callbackOrigin: "https://dnew0.cloudfront.net", redeemedCodeHash: hash, redeemedAt: at(), replayHTTPStatus: 409, cookieAttributes }, profile: { profileId: id(71), namespace: ["local", "https://save.example", ""], idempotencyKey: "probe-save-0000000000000001", revision: 1, payloadHash: hash, sourceValueHash: valueHash, restoredValueHash: valueHash, acknowledgedAt: at(1000), restoredAt: at(2000) }, websocket: { url: "wss://dnew2.cloudfront.net/wisp/probe", sessionId: id(72), openedAt: at(1000), closedAt: at(3000), sentSHA256: valueHash, receivedSHA256: valueHash, sentBytes: 32, receivedBytes: 32 } },
    { resourceKey: "resource-1", role: "hub", distributionId: "ENEW123451", origin: "https://dnew1.cloudfront.net", assetManifestHash: asset, hubSession: { sessionId: id(73), userId: id(70), HTTPStatus: 200, cookieAttributes } },
    { resourceKey: "resource-2", role: "node", distributionId: "ENEW123452", origin: "https://dnew2.cloudfront.net", assetManifestHash: asset, nodeIdentity: { expectedId: "node-two", observedId: "node-two" }, websocket: { url: "wss://dnew2.cloudfront.net/wisp/probe", sessionId: id(72), openedAt: at(1000), closedAt: at(3000), sentSHA256: valueHash, receivedSHA256: valueHash, sentBytes: 32, receivedBytes: 32 } },
  ] };
  const envelope = (): RuntimeAcceptanceEnvelope => ({ format: "atlas-runtime-acceptance-envelope-v1", payload: evidence, signature: sign(null, Buffer.from(canonicalCutoverJSON(evidence)), privateKey).toString("base64url") });
  const corroboration = () => ({ evidenceHash: cutoverDigest(evidence), observedAt: at(), frontendSessions: [id(72)], profileReceipts: [id(71) + ":probe-save-0000000000000001"], hubSessions: [id(73)] });
  const input = () => ({ job, expectedRevision: 7, expectedPlanHash: job.planHash, assetManifestHash: asset, coordinatorOrigin: "https://coordinator.example", endpoints, branches, now });
  const verified = () => verifyRuntimeAcceptance(envelope(), pub, { job, assetManifestHash: asset, coordinatorOrigin: "https://coordinator.example", now });
  const ready = () => createCutoverReadiness({ ...input(), envelope: envelope(), trustedProbePublicKey: pub, corroboration: corroboration() });
  return { job, endpoints, branches, evidence, pub, envelope, corroboration, input, verified, ready };
}
describe("production operator readiness only; no activation capability", () => {
  it("emits exact stage/transition/endpoint operations but never claims activation", () => {
    const f = fixture(), m = f.ready();
    expect(m.evidenceProvenanceVerified).toBe(true); expect(m.liveHubCorroborated).toBe(true); expect(m.activationImplemented).toBe(false); expect(m.productionMutationsPerformed).toBe(false);
    expect(m.blockers).toEqual(["PRODUCTION_DURABLE_EXECUTOR_AND_ACCEPTANCE_RECEIPT_CONSUMER_NOT_IMPLEMENTED"]);
    const stage = m.operations.find(o => o.operation === "hub.callback-origin.stage")!;
    expect(JSON.stringify(stage)).toContain("'transition'"); expect(JSON.stringify(stage)).toContain("preserveOldActiveOrigin"); expect(JSON.stringify(stage)).not.toContain("UPDATE links");
    const transition = m.operations.find(o => o.operation === "atlas.old-origin.sync-transition")!;
    expect(transition.body).toEqual({ origin: "https://old-frontend.example", expectedGeneration: 9, revision: 3, active: true });
    const rotation = m.operations.find(o => o.operation === "atlas.endpoint.rotate")!;
    expect(rotation.body).toEqual({ generation: 6, previousHubOrigin: "https://old-hub.example", hubOrigin: "https://dnew1.cloudfront.net", nodes: [{ id: "node-two", previousEndpoint: "https://old-node.example", endpoint: "https://dnew2.cloudfront.net" }] });
    expect(m.operations.find(o => o.operation === "hub.stable-link.replace-endpoint")).toMatchObject({ logicalLinkId: id(20), branchId: id(60), retainQuotaUsage: true, retainAssignments: true, retainProfiles: true, retainOldDistribution: true });
    const { manifestHash, ...body } = m; expect(cutoverDigest(body)).toBe(manifestHash);
  });
  it("unsigned health-only status cannot become acceptance", () => {
    const f = fixture(), m = createCutoverReadiness(f.input()); expect(m.evidenceProvenanceVerified).toBe(false); expect(m.blockers).toContain("REAL_SIGNED_AUTH_PROFILE_WSS_ACCEPTANCE_REQUIRED"); expect(m.activationImplemented).toBe(false);
    (f.evidence.endpoints[0] as any) = { resourceKey: "resource-0", distributionId: "ENEW123450", role: "frontend", origin: "https://dnew0.cloudfront.net", assetManifestHash: asset, healthy: true, passed: true };
    expect(f.verified).toThrow("AUTH_HANDOFF_REPLAY_COOKIE_EVIDENCE_REQUIRED");
  });
  it("rejects altered signature, untrusted keys and per-job replay", () => {
    const f = fixture(), e = f.envelope(); e.payload.assetManifestHash = "d".repeat(64); expect(() => verifyRuntimeAcceptance(e, f.pub, { ...f.input(), now })).toThrow("RUNTIME_EVIDENCE_SIGNATURE_INVALID");
    expect(() => verifyRuntimeAcceptance(f.envelope(), fixture().pub, { ...f.input(), now })).toThrow("RUNTIME_EVIDENCE_SIGNATURE_INVALID");
    f.evidence.jobId = id(999); expect(f.verified).toThrow("RUNTIME_EVIDENCE_BINDING_MISMATCH");
  });
  it.each(["jobRevision", "planHash", "checkpointHash", "accountIdentity", "assetManifestHash"])("binds signed evidence to %s", field => {
    const f = fixture(); (f.evidence as any)[field] = field === "jobRevision" ? 8 : "e".repeat(64); expect(f.verified).toThrow("RUNTIME_EVIDENCE_BINDING_MISMATCH");
  });
  it("rejects expired, old, future and overlong acceptance windows", () => {
    for (const patch of [{ expiresAt: at(-1) }, { observedAt: at(-16 * 60_000) }, { observedAt: at(31_000) }, { expiresAt: at(16 * 60_000) }]) { const f = fixture(); Object.assign(f.evidence, patch); expect(f.verified).toThrow("RUNTIME_EVIDENCE_EXPIRED"); }
  });
  it("requires exactly all planned endpoints and consistent served asset hashes", () => {
    const f = fixture(); f.evidence.endpoints.pop(); expect(f.verified).toThrow("ENDPOINT_EVIDENCE_INCOMPLETE");
    const g = fixture(); g.evidence.endpoints[2]!.assetManifestHash = "f".repeat(64); expect(g.verified).toThrow("ENDPOINT_EVIDENCE_BINDING_MISMATCH");
  });
  it("requires replay rejection, host-only secure cookies and destination-bound handoff", () => {
    for (const change of ["replay", "cookie", "origin"]) { const f = fixture(), a = f.evidence.endpoints[0]!.auth!; if (change === "replay") a.replayHTTPStatus = 200; if (change === "cookie") a.cookieAttributes = ["Secure"]; if (change === "origin") a.callbackOrigin = "https://other.example"; expect(f.verified).toThrow("AUTH_HANDOFF_REPLAY_COOKIE_EVIDENCE_REQUIRED"); }
  });
  it("requires a real acknowledged profile revision and exact restored value hash", () => {
    for (const change of ["revision", "hash", "time"]) { const f = fixture(), s = f.evidence.endpoints[0]!.profile!; if (change === "revision") s.revision = 0; if (change === "hash") s.restoredValueHash = "f".repeat(64); if (change === "time") s.restoredAt = at(-1000); expect(f.verified).toThrow("ACKNOWLEDGED_PROFILE_ROUNDTRIP_REQUIRED"); }
  });
  it("requires authenticated WSS nonce round trip, not just upgrade or open", () => {
    for (const change of ["hash", "ws", "session", "foreign", "bytes"]) { const f = fixture(), w = f.evidence.endpoints[0]!.websocket!; if (change === "hash") w.receivedSHA256 = "f".repeat(64); if (change === "ws") w.url = "ws://dnew2.cloudfront.net/wisp"; if (change === "session") w.sessionId = id(998); if (change === "foreign") w.url = "wss://other.example/wisp"; if (change === "bytes") w.receivedBytes = 0; expect(f.verified).toThrow("AUTHENTICATED_WSS_ROUNDTRIP_REQUIRED"); }
  });
  it("rejects replaced node identities and Hub health without a session", () => {
    const f = fixture(); f.evidence.endpoints[2]!.nodeIdentity!.observedId = "other-node"; expect(f.verified).toThrow("STABLE_NODE_IDENTITY_EVIDENCE_REQUIRED");
    const g = fixture(); delete g.evidence.endpoints[1]!.hubSession; expect(g.verified).toThrow("HUB_SESSION_EVIDENCE_REQUIRED");
  });
  it("requires signed fresh coordinator state and rejects duplicate registry keys", () => {
    const f = fixture(); f.evidence.coordinator.observedAt = at(-31_000); expect(f.verified).toThrow("COORDINATOR_SNAPSHOT_REQUIRED");
    const g = fixture(); g.evidence.coordinator.branches.push(g.evidence.coordinator.branches[0]!); expect(g.verified).toThrow("COORDINATOR_SNAPSHOT_INVALID");
  });
  it("refuses stale job revision and mutated immutable plan", () => {
    const f = fixture(); f.job.revision++; expect(f.ready).toThrow("JOB_PLAN_OR_REVISION_CONFLICT");
    const g = fixture(); g.job.plan.resources[0]!.originHost = "different.example"; expect(g.ready).toThrow("JOB_PLAN_OR_REVISION_CONFLICT");
  });
  it("requires exact deployed AWS resources with no simulator artifacts or extra checkpoint", () => {
    for (const change of ["status", "id", "origin", "caller", "extra"]) { const f = fixture(), d = f.job.checkpoint.resources!["resource-0"]!; if (change === "status") d.status = "InProgress"; if (change === "id") d.id = "FAKE000001"; if (change === "origin") d.originHost = "other.example"; if (change === "caller") d.caller = "foreign"; if (change === "extra") f.job.checkpoint.resources!.extra = d; expect(() => createCutoverReadiness(f.input())).toThrow(change === "extra" ? "CHECKPOINT_RESOURCE_SET_MISMATCH" : "EXACT_DEPLOYED_CHECKPOINT_REQUIRED"); }
  });
  it("refuses endpoint, stable branch and current link conflicts without producing an executable plan", () => {
    const f = fixture(); f.endpoints[0]!.revision++; expect(f.ready).toThrow("ENDPOINT_REVISION_CONFLICT");
    const g = fixture(); g.branches[0]!.linkURL = "https://changed.example"; expect(g.ready).toThrow("STABLE_BRANCH_OR_LINK_CONFLICT");
  });
  it("never claims pre-cutover authentication if the new callback was not actually staged", () => {
    const f = fixture(); f.branches[0]!.origins.pop(); expect(f.ready).toThrow("ACCEPTANCE_CALLBACK_NOT_REGISTERED");
  });
  it("does not silently rotate missing branch credentials or guess old registry generations", () => {
    const f = fixture(); f.branches[0]!.credentialStored = false; f.evidence.coordinator.branches.shift(); const m = f.ready(); expect(m.blockers).toContain("EXACT_EXISTING_BRANCH_CREDENTIAL_REQUIRED:resource-0"); expect(m.blockers).toContain("VERIFIED_OLD_BRANCH_REGISTRY_REQUIRED:resource-0"); expect(JSON.stringify(m.operations)).toContain("VERIFIED_STORED_GENERATION");
  });
  it("keeps already active transition replay at its exact revision", () => {
    const f = fixture(); f.evidence.coordinator.branches[0]!.transitionActive = true; const m = f.ready(); expect((m.operations.find(o => o.operation === "atlas.old-origin.sync-transition")!.body as any).revision).toBe(2);
  });
  it("retains the observed staged destination generation and rejects another registered branch", () => {
    const f = fixture(); f.evidence.coordinator.branches[1]!.generation = 17; const m = f.ready(); expect((m.operations.find(o => o.operation === "atlas.branch.register")!.body as any).generation).toBe(17);
    const g = fixture(); g.evidence.coordinator.branches[1]!.id = id(999); expect(g.ready).toThrow("DESTINATION_BRANCH_REGISTRY_CONFLICT");
  });
  it("never treats not-yet-observed future actions as completed runtime acceptance", () => {
    for (const which of ["handoff", "ack", "restore", "socket"]){const f=fixture(),p=f.evidence.endpoints[0]!;if(which==="handoff")p.auth!.redeemedAt=at(31_000);if(which==="ack")p.profile!.acknowledgedAt=at(31_000);if(which==="restore")p.profile!.restoredAt=at(31_000);if(which==="socket")p.websocket!.closedAt=at(31_000);expect(f.verified).toThrow(/EVIDENCE_REQUIRED|ROUNDTRIP_REQUIRED/);}
  });
  it("cannot invent a new unassigned link/branch to qualify an unsupported new frontend", () => {
    const f = fixture(); f.branches.length = 0; const m = f.ready(); expect(m.blockers).toContain("NEW_FRONTEND_STABLE_LINK_AND_BRANCH_STAGING_REQUIRED:resource-0"); expect(m.operations.some(o => o.operation === "hub.stable-link.replace-endpoint")).toBe(false);
  });
  it("requires exact fresh database corroboration even after signature verification", () => {
    const f = fixture(), m = createCutoverReadiness({ ...f.input(), envelope: f.envelope(), trustedProbePublicKey: f.pub }); expect(m.liveHubCorroborated).toBe(false); expect(m.blockers).toContain("LIVE_HUB_DATABASE_CORROBORATION_REQUIRED");
    const c = f.corroboration(); c.profileReceipts = []; expect(() => createCutoverReadiness({ ...f.input(), envelope: f.envelope(), trustedProbePublicKey: f.pub, corroboration: c })).toThrow("DATABASE_CORROBORATION_SET_MISMATCH");
  });
  it("only issues SELECTs while corroborating live sessions, exact receipts and redeemed callback", async () => {
    const f = fixture(), calls: string[] = [];
    const db = { async query(sql: string) { calls.push(sql); return { rows: sql.includes("hub_commits") ? [{ revision: 1, payload_hash: hash }] : [{ id: id(1), code_hash: hash }] }; } };
    const c = await corroborateRuntimeAcceptance(db, f.verified()); expect(c.evidenceHash).toBe(cutoverDigest(f.evidence)); expect(c.frontendSessions).toEqual([id(72)]); expect(c.profileReceipts).toHaveLength(1); expect(c.hubSessions).toEqual([id(73)]); expect(calls.length).toBe(4); expect(calls.every(sql => sql.startsWith("SELECT "))).toBe(true);
  });
  it.each(["session", "receipt", "handoff", "hub"])("holds for failed real database %s corroboration", async kind => {
    const f = fixture(); const db = { async query(sql: string) { const missing = kind === "session" && sql.includes("hub_branch_sessions") || kind === "receipt" && sql.includes("hub_commits") || kind === "handoff" && sql.includes("hub_handoffs") || kind === "hub" && sql.startsWith("SELECT s.id"); return { rows: missing ? [] : sql.includes("hub_commits") ? [{ revision: 1, payload_hash: hash }] : [{ id: id(1), code_hash: hash }] }; } };
    await expect(corroborateRuntimeAcceptance(db, f.verified())).rejects.toThrow(/CORROBORATION_FAILED/);
  });
  it("CLI has no execute/AWS/deploy path and describes read-only operation", () => {
    const source = readFileSync(new URL("./hubCloudCutoverMain.ts", import.meta.url), "utf8"); expect(source).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); expect(source).toContain('flag: "wx"'); expect(source).not.toContain("spawn("); expect(source).not.toContain("execFile(");
    const r = spawnSync(process.execPath, ["--import", "tsx", new URL("./hubCloudCutoverMain.ts", import.meta.url).pathname, "--help"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } }); expect(r.status).toBe(0); expect(r.stdout).toContain("No AWS commands or deployment/activation writes.");
    const execute = spawnSync(process.execPath, ["--import", "tsx", new URL("./hubCloudCutoverMain.ts", import.meta.url).pathname, "--execute", "yes"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://user:must-not-print@private.example/db" } }); expect(execute.status).toBe(1); expect(execute.stderr).toContain("INVALID_READ_ONLY_ARGUMENTS"); expect(execute.stderr).not.toContain("must-not-print");
  });
});
