/** Explicit private operator worker. No AWS calls and no HTTP admin proxy.
 * stage registers callbacks/qualification aliases; commit requires real signed
 * runtime proof; resume replays only the durable already accepted operation. */
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { ProductionCutoverExecutor, CutoverExecutionError } from "./hubCloudCutoverExecutor.js";
import { CutoverReadinessError, type RuntimeAcceptanceEnvelope } from "./hubCloudCutover.js";
const usage = "Explicit worker: stage|commit|resume --apply --job UUID --revision N --plan-hash SHA256 --asset-manifest-hash SHA256 --operator UUID --out NEW_JSON [--probe-account UUID] [--initial-credentials PRIVATE_JSON] [--evidence SIGNED_JSON --probe-public-key TRUSTED_PUBLIC_PEM]. Coordinator, service/origin keys, database and encryption keys come only from private worker environment. Stage preserves canonical URLs; commit publishes only after actual runtime proof; resume uses durable exact operations.";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") process.stdout.write(usage + "\n");
else {
  let pool: Pool | undefined;
  try {
    const action = args.shift(); if (!["stage", "commit", "resume"].includes(action ?? "")) throw new CutoverExecutionError("EXPLICIT_WORKER_ACTION_REQUIRED");
    let apply = false; const flags = new Map<string, string>(), allowed = new Set(["--job", "--revision", "--plan-hash", "--asset-manifest-hash", "--operator", "--out", "--probe-account", "--initial-credentials", "--evidence", "--probe-public-key"]);
    for (let i = 0; i < args.length; i++) { const name = args[i]!; if (name === "--apply" && !apply) { apply = true; continue; } const value = args[++i]; if (!allowed.has(name) || flags.has(name) || !value || value.startsWith("--")) throw new CutoverExecutionError("INVALID_WORKER_ARGUMENTS"); flags.set(name, value); }
    if (!apply) throw new CutoverExecutionError("EXPLICIT_APPLY_REQUIRED");
    for (const name of ["--job", "--revision", "--plan-hash", "--asset-manifest-hash", "--operator", "--out"]) if (!flags.has(name)) throw new CutoverExecutionError("MISSING_WORKER_BINDING_ARGUMENTS");
    if (!/^\d+$/.test(flags.get("--revision")!)) throw new CutoverExecutionError("INVALID_JOB_REVISION");
    if (flags.has("--evidence") !== flags.has("--probe-public-key") || action === "commit" && !flags.has("--evidence") || action === "stage" && flags.has("--evidence")) throw new CutoverExecutionError("EXACT_SIGNED_QUALIFICATION_ARGUMENTS_REQUIRED");
    const env = (name: string) => { const v = process.env[name]?.trim(); if (!v) throw new CutoverExecutionError("PRIVATE_WORKER_ENVIRONMENT_REQUIRED"); return v; };
    const databaseURL = env("DATABASE_URL"), parsed = new URL(databaseURL); if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new CutoverExecutionError("POSTGRESQL_REQUIRED");
    let initialCredentials: Record<string, string> | undefined;
    if (flags.has("--initial-credentials")) { const path = resolve(flags.get("--initial-credentials")!), info = await stat(path); if (!info.isFile() || info.size > 1_000_000 || info.mode & 0o077) throw new CutoverExecutionError("PRIVATE_CREDENTIAL_FILE_REQUIRED"); initialCredentials = JSON.parse(await readFile(path, "utf8")); }
    let qualification: { envelope: RuntimeAcceptanceEnvelope; trustedProbePublicKey: string } | undefined;
    if (flags.has("--evidence")) { const bytes = await readFile(resolve(flags.get("--evidence")!)), key = await readFile(resolve(flags.get("--probe-public-key")!)); if (bytes.length > 4 * 1024 * 1024 || key.length > 16 * 1024) throw new CutoverExecutionError("QUALIFICATION_FILE_TOO_LARGE"); qualification = { envelope: JSON.parse(bytes.toString("utf8")), trustedProbePublicKey: key.toString("utf8") }; }
    pool = new Pool({ connectionString: databaseURL, max: 1, application_name: "atlas-production-cutover-worker", connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
    const worker = new ProductionCutoverExecutor({ pool, encryptionKey: env("DATA_ENCRYPTION_KEY"), sessionSecret: env("SESSION_SECRET"), coordinatorOrigin: env("ATLAS_COORDINATOR_ORIGIN"), serviceSecret: env("ATLAS_HUB_SERVICE_SECRET"), coordinatorOriginKey: process.env.ATLAS_COORDINATOR_ORIGIN_KEY?.trim(), probeUserId: flags.get("--probe-account"), initialCredentials });
    const binding = { jobId: flags.get("--job")!, expectedRevision: Number(flags.get("--revision")), planHash: flags.get("--plan-hash")!, assetManifestHash: flags.get("--asset-manifest-hash")!, operatorId: flags.get("--operator")! };
    const receipt = action === "stage" ? await worker.stage(binding) : await worker.commit(binding, qualification);
    await writeFile(resolve(flags.get("--out")!), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(`PRODUCTION_CUTOVER=${receipt.phase.toUpperCase()}; REGISTRY_STAGED=${receipt.registryStaged}; ACCEPTANCE=${receipt.acceptanceHash ? "DURABLE" : "PENDING_REAL_RUNTIME_PROOF"}; AWS_CALLS=0\n`);
  } catch (error) {
    const code = error instanceof CutoverExecutionError || error instanceof CutoverReadinessError ? error.code : "CUTOVER_OPERATION_INTERRUPTED";
    // Stage/commit may have persisted a durable phase before an output/network
    // failure. Never claim zero mutations or print raw driver/credential errors.
    process.stderr.write(`PRODUCTION_CUTOVER=INTERRUPTED; CODE=${code}; RETRY=EXACT_DURABLE_RECEIPT\n`); process.exitCode = 1;
  } finally { await pool?.end(); }
}
