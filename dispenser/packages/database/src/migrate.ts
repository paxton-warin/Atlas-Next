import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = new Client({ connectionString: url });
await client.connect();
await client.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations (id text primary key, applied_at timestamptz not null default now())",
);
for (const name of (await readdir(join(import.meta.dirname, "../migrations")))
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  if (
    (
      await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
        name,
      ])
    ).rowCount
  )
    continue;
  await client.query("BEGIN");
  try {
    await client.query(
      await readFile(join(import.meta.dirname, "../migrations", name), "utf8"),
    );
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
      name,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
await client.end();
