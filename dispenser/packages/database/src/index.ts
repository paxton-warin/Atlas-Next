import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
export * from "./schema.js";
export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString });
  return { db: drizzle({ client: pool }), pool };
}
