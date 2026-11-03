/** Read-only operator manifest launcher; deliberately no --execute option.
 * pnpm --filter @atlas-link-dispenser/server exec tsx src/hubCloudCutoverMain.ts --help
 * Never invoke production CLI automatically while qualifying this source. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createCutoverReadiness, verifyRuntimeAcceptance, corroborateRuntimeAcceptance, CutoverReadinessError, type CutoverJob, type CutoverEndpoint, type CutoverBranch, type RuntimeAcceptanceEnvelope } from "./hubCloudCutover.js";

const usage = "Read-only: --job UUID --revision N --plan-hash SHA256 --asset-manifest-hash SHA256 --coordinator https://HOST --out NEW_FILE [--evidence SIGNED_JSON --probe-public-key TRUSTED_ED25519_PUBLIC_PEM]. No AWS commands or deployment/activation writes.";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") { process.stdout.write(usage + "\n"); }
else {
  let pool: Pool | undefined;
  try {
    const allowed = new Set(["--job", "--revision", "--plan-hash", "--asset-manifest-hash", "--coordinator", "--out", "--evidence", "--probe-public-key"]), flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i], value = args[i + 1];
      if (!allowed.has(name!) || flags.has(name!) || !value || value.startsWith("--")) throw new CutoverReadinessError("INVALID_READ_ONLY_ARGUMENTS"); flags.set(name!, value);
    }
    for (const name of ["--job", "--revision", "--plan-hash", "--asset-manifest-hash", "--coordinator", "--out"]) if (!flags.has(name)) throw new CutoverReadinessError("MISSING_READ_ONLY_ARGUMENTS");
    if (!/^[a-f0-9-]{36}$/i.test(flags.get("--job")!) || !/^\d+$/.test(flags.get("--revision")!) || !/^[a-f0-9]{64}$/.test(flags.get("--plan-hash")!) || !/^[a-f0-9]{64}$/.test(flags.get("--asset-manifest-hash")!)) throw new CutoverReadinessError("INVALID_JOB_BINDING_ARGUMENTS");
    if (flags.has("--evidence") !== flags.has("--probe-public-key")) throw new CutoverReadinessError("SIGNED_EVIDENCE_AND_TRUSTED_KEY_PAIR_REQUIRED");
    const databaseURL = process.env.DATABASE_URL;
    if (!databaseURL) throw new CutoverReadinessError("DATABASE_URL_REQUIRED_FOR_READ_ONLY_SNAPSHOT");
    const u = new URL(databaseURL); if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new CutoverReadinessError("POSTGRESQL_DATABASE_REQUIRED");
    let envelope: RuntimeAcceptanceEnvelope | undefined, trustedProbePublicKey: string | undefined;
    if (flags.has("--evidence")) {
      const bytes = await readFile(resolve(flags.get("--evidence")!)); if (bytes.length > 4 * 1024 * 1024) throw new CutoverReadinessError("EVIDENCE_FILE_TOO_LARGE"); envelope = JSON.parse(bytes.toString("utf8"));
      const key = await readFile(resolve(flags.get("--probe-public-key")!)); if (key.length > 16 * 1024) throw new CutoverReadinessError("PUBLIC_KEY_FILE_TOO_LARGE"); trustedProbePublicKey = key.toString("utf8");
    }
    pool = new Pool({ connectionString: databaseURL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
    const db = await pool.connect(); let manifest;
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const job = (await db.query('SELECT id,state,revision,plan,plan_hash AS "planHash",checkpoint FROM hub_cloud_jobs WHERE id=$1', [flags.get("--job")])).rows[0] as CutoverJob | undefined;
      if (!job) throw new CutoverReadinessError("CLOUD_JOB_NOT_FOUND");
      const account = (await db.query("SELECT expected_account_id,verified_account_id,status FROM hub_cloud_accounts WHERE id=$1", [job.plan.accountId])).rows[0];
      if (!account || account.status !== "connected" || account.expected_account_id !== job.plan.accountIdentity || account.verified_account_id !== job.plan.accountIdentity) throw new CutoverReadinessError("CLOUD_ACCOUNT_NOT_STS_VERIFIED");
      const endpointIds = job.plan.resources.flatMap(r => r.previous ? [r.previous.id] : []), logicalKeys = job.plan.resources.map(r => r.role + ":" + r.logicalId);
      const endpoints = (await db.query('SELECT id,role,logical_id AS "logicalId",account_id AS "accountId",distribution_id AS "distributionId",url,origin_host AS "originHost",revision,state FROM hub_cloud_endpoints WHERE id=ANY($1::uuid[]) OR role||\':\'||logical_id=ANY($2::text[])', [endpointIds, logicalKeys])).rows as CutoverEndpoint[];
      const linkIds = job.plan.resources.filter(r => r.role === "frontend" && /^[a-f0-9-]{36}$/i.test(r.logicalId)).map(r => r.logicalId);
      const branches = (await db.query('SELECT b.id,b.link_id AS "linkId",b.origin,b.enabled,l.url AS "linkURL",EXISTS(SELECT 1 FROM hub_cloud_branch_credentials c WHERE c.branch_id=b.id) AS "credentialStored" FROM hub_branches b JOIN links l ON l.id=b.link_id WHERE b.link_id=ANY($1::uuid[])', [linkIds])).rows as CutoverBranch[];
      const branchOrigins = (await db.query('SELECT branch_id AS "branchId",origin,state FROM hub_branch_origins WHERE branch_id=ANY($1::uuid[])', [branches.map(b => b.id)])).rows;
      for (const branch of branches) branch.origins = branchOrigins.filter(o => o.branchId === branch.id).map(({ origin, state }) => ({ origin, state }));
      const expected = { job, assetManifestHash: flags.get("--asset-manifest-hash")!, coordinatorOrigin: flags.get("--coordinator")! };
      const evidence = envelope ? verifyRuntimeAcceptance(envelope, trustedProbePublicKey!, expected) : undefined;
      const corroboration = evidence ? await corroborateRuntimeAcceptance(db, evidence) : undefined;
      manifest = createCutoverReadiness({ ...expected, expectedRevision: Number(flags.get("--revision")), expectedPlanHash: flags.get("--plan-hash")!, endpoints, branches, envelope, trustedProbePublicKey, corroboration });
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
    finally { db.release(); }
    await writeFile(resolve(flags.get("--out")!), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(`CUTOVER_READINESS=RECORDED; ACTIVATION=NOT_IMPLEMENTED; DATABASE_MODE=READ_ONLY; MUTATIONS=0; BLOCKERS=${manifest.blockers.length}; MANIFEST_SHA256=${manifest.manifestHash}\n`);
  } catch (error) {
    // Never echo database URLs, driver errors, credentials, cookies or raw proof.
    process.stderr.write(`CUTOVER_READINESS=HELD; CODE=${error instanceof CutoverReadinessError ? error.code : "READ_ONLY_SNAPSHOT_OR_OUTPUT_FAILED"}; MUTATIONS=0\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
