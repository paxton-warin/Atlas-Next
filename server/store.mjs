import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
export function openStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = resolve(dir, "master.key");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const key = readFileSync(keyPath);
  const db = new DatabaseSync(resolve(dir, "atlas.sqlite"));
  chmodSync(resolve(dir, "atlas.sqlite"), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, secret TEXT NOT NULL, subject TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, author TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, target TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, artwork TEXT NOT NULL, category TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
  `);
  const catalogColumns = db
    .prepare("PRAGMA table_info(catalog)")
    .all()
    .map((c) => c.name);
  if (!catalogColumns.includes("kind"))
    db.exec("ALTER TABLE catalog ADD COLUMN kind TEXT NOT NULL DEFAULT 'game'");
  if (!catalogColumns.includes("thumbnail"))
    db.exec(
      "ALTER TABLE catalog ADD COLUMN thumbnail TEXT NOT NULL DEFAULT ''",
    );
  const get = (name) => {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(name);
    return row ? JSON.parse(row.value) : null;
  };
  const set = (name, value) =>
    db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(name, JSON.stringify(value));
  const audit = (action, target = "") =>
    db
      .prepare("INSERT INTO audit(action,target,created) VALUES (?,?,?)")
      .run(action, target, Date.now());
  const seal = (value) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url");
  };
  const unseal = (value) => {
    const b = Buffer.from(value, "base64url"),
      decipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([
      decipher.update(b.subarray(12, -16)),
      decipher.final(),
    ]).toString();
  };
  if (!get("catalogSeeded")) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO catalog (id,name,description,url,artwork,category,enabled) VALUES (?,?,?,?,?,?,1)",
    );
    for (const row of [
      [
        "2048",
        "2048",
        "A little strategy. One more move.",
        "/games/2048.html",
        "numbers",
        "Puzzle",
      ],
      [
        "snake",
        "Snake",
        "The classic, with a fresh coat of green.",
        "/games/snake.html",
        "snake",
        "Arcade",
      ],
      [
        "tic",
        "Tic Tac Toe",
        "A quick match for two.",
        "/games/tic.html",
        "tic",
        "Strategy",
      ],
      [
        "hextris",
        "Hextris",
        "Keep the colors moving.",
        "https://hextris.io/",
        "hex",
        "Puzzle",
      ],
      [
        "alchemy",
        "Little Alchemy 2",
        "Start small. Discover something new.",
        "https://littlealchemy2.com/",
        "alchemy",
        "Creative",
      ],
      [
        "chess",
        "Lichess",
        "Your next brilliant move.",
        "https://lichess.org/",
        "chess",
        "Strategy",
      ],
    ])
      insert.run(...row);
    set("catalogSeeded", true);
  }
  if (!get("catalogLibrary20260912")) {
    const library = JSON.parse(
      readFileSync(new URL("./catalog.json", import.meta.url), "utf8"),
    );
    db.exec("BEGIN");
    try {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO catalog (id,name,description,url,artwork,category,enabled,kind,thumbnail) VALUES (?,?,?,?,?,?,1,?,?)",
      );
      for (const row of library)
        insert.run(
          row.id,
          row.name,
          row.description,
          row.url,
          row.artwork,
          row.category,
          row.kind,
          row.thumbnail,
        );
      set("catalogLibrary20260912", true);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { db, get, set, audit, seal, unseal };
}
