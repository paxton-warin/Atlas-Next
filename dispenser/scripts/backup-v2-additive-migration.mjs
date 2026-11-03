#!/usr/bin/env node
/** Fixed additive0026 runner. Dry-run by default; no application startup dependency.
 * Pass a connected pg client to reuse from a controlled SSH deployment script.
 * A lost COMMIT response is resolved by re-running with a fresh connection. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const BACKUP_CATALOG_MIGRATION =
  "0026_hub_backup_catalog_scalability.sql";
export const BACKUP_CATALOG_PREVIOUS = "0025_hub_backups_v2.sql";
const migrationURL = new URL(
  "../packages/database/migrations/" + BACKUP_CATALOG_MIGRATION,
  import.meta.url,
);
const fail = (code) => Object.assign(new Error(code), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function applyBackupCatalogMigration(
  client,
  { apply = false, maxAttempts = 3, retryDelayMs = 100, onAttempt } = {},
) {
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 4 ||
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > 1000
  )
    throw fail("MIGRATION_BOUNDS_INVALID");
  const sql = await readFile(migrationURL, "utf8"),
    sha256 = createHash("sha256").update(sql).digest("hex");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let inTransaction = false,
      committing = false;
    try {
      await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
      inTransaction = true;
      await client.query(
        "SET LOCAL lock_timeout='2000ms'; SET LOCAL statement_timeout='15000ms'; SET LOCAL idle_in_transaction_session_timeout='15000ms'",
      );
      if (apply) {
        const lock = await client.query(
          "SELECT pg_try_advisory_xact_lock(hashtext(current_database()),hashtext(current_schema()||':atlas-schema-migration')) AS held",
        );
        if (!lock.rows[0]?.held) throw fail("55P03");
        await client.query(
          "LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE",
        );
      }
      const latest = (
        await client.query(
          "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
        )
      ).rows[0]?.id;
      if (latest === BACKUP_CATALOG_MIGRATION) {
        const receipt = (
          await client.query(
            "SELECT source_sha256 FROM hub_backup_migration_receipts WHERE id=$1",
            [BACKUP_CATALOG_MIGRATION],
          )
        ).rows[0]?.source_sha256;
        if (receipt !== sha256) throw fail("MIGRATION_RECEIPT_MISMATCH");
        committing = true;
        await client.query("COMMIT");
        inTransaction = false;
        return {
          ok: true,
          applied: false,
          alreadyApplied: true,
          migration: BACKUP_CATALOG_MIGRATION,
          sha256,
          attempts: attempt,
        };
      }
      if (latest !== BACKUP_CATALOG_PREVIOUS)
        throw fail("MIGRATION_EXACT_PRIOR_REQUIRED");
      onAttempt?.({ attempt, apply, sha256 });
      if (!apply) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return {
          ok: true,
          applied: false,
          alreadyApplied: false,
          migration: BACKUP_CATALOG_MIGRATION,
          sha256,
          attempts: attempt,
        };
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO hub_backup_migration_receipts(id,source_sha256) VALUES($1,$2)",
        [BACKUP_CATALOG_MIGRATION, sha256],
      );
      await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [
        BACKUP_CATALOG_MIGRATION,
      ]);
      committing = true;
      await client.query("COMMIT");
      inTransaction = false;
      return {
        ok: true,
        applied: true,
        alreadyApplied: false,
        migration: BACKUP_CATALOG_MIGRATION,
        sha256,
        attempts: attempt,
      };
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => {});
      // An uncertain COMMIT is never replayed as a fresh mutation on this connection.
      // Re-entry validates the durable source hash before returning alreadyApplied.
      if (committing)
        throw Object.assign(fail("MIGRATION_COMMIT_UNCERTAIN"), {
          cause: error,
        });
      if (!["55P03", "57014"].includes(error?.code) || attempt === maxAttempts)
        throw error;
      await sleep(retryDelayMs);
    }
  }
  throw fail("MIGRATION_ATTEMPTS_EXHAUSTED");
}
async function main() {
  const { Client } = createRequire(
    new URL("../apps/server/package.json", import.meta.url),
  )("pg");
  if (!process.env.DATABASE_URL) throw fail("DATABASE_URL_REQUIRED");
  if (process.argv.slice(2).some((v) => v !== "--apply"))
    throw fail("MIGRATION_ARGUMENT_INVALID");
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    application_name: "atlas-backup-additive0026",
  });
  try {
    await c.connect();
    console.log(
      JSON.stringify(
        await applyBackupCatalogMigration(c, {
          apply: process.argv.includes("--apply"),
        }),
      ),
    );
  } finally {
    await c.end().catch(() => {});
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          typeof error?.code === "string" &&
          /^[A-Z0-9_]{1,80}$/.test(error.code)
            ? error.code
            : "MIGRATION_FAILED",
      }),
    );
    process.exitCode = 1;
  });
