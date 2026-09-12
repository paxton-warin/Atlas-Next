import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../server/store.mjs";
const library = JSON.parse(
  readFileSync(new URL("../server/catalog.json", import.meta.url)),
);
test("large catalog has distinct HTTPS destinations, local covers and explicit app/game types", () => {
  assert.ok(library.filter((r) => r.kind === "game").length >= 200);
  assert.ok(library.filter((r) => r.kind === "app").length >= 40);
  assert.equal(new Set(library.map((r) => r.id)).size, library.length);
  assert.equal(
    new Set(library.map((r) => r.kind + ":" + r.url)).size,
    library.length,
  );
  for (const row of library) {
    const url = new URL(row.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.ok(row.description.length <= 180);
    if (row.thumbnail) {
      assert.match(
        row.thumbnail,
        /^\/catalog-art\/lib-[a-f0-9]+\.(webp|png|jpg|jpeg|gif|ico)$/,
      );
      assert.ok(
        readFileSync(new URL("../web/public" + row.thumbnail, import.meta.url))
          .length > 0,
      );
    }
  }
});
test("catalog migration upgrades old schema once and preserves owner changes and disabled entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-catalog-"));
  let store;
  try {
    const old = new DatabaseSync(join(dir, "atlas.sqlite"));
    old.exec(
      "CREATE TABLE catalog (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,artwork TEXT NOT NULL,category TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1)",
    );
    old
      .prepare("INSERT INTO catalog VALUES (?,?,?,?,?,?,?)")
      .run(
        "2048",
        "Owner title",
        "Owner description",
        "/games/2048.html",
        "numbers",
        "Puzzle",
        0,
      );
    old.close();
    store = openStore(dir);
    const count = store.db.prepare("SELECT count(*) n FROM catalog").get().n;
    assert.equal(count, library.length + 6);
    assert.equal(
      store.db.prepare("SELECT name FROM catalog WHERE id='2048'").get().name,
      "Owner title",
    );
    store.db
      .prepare("UPDATE catalog SET name=?,enabled=0 WHERE id=?")
      .run("Owner changed app", library.find((r) => r.kind === "app").id);
    store.db.close();
    store = openStore(dir);
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM catalog").get().n,
      count,
    );
    const row = store.db
      .prepare("SELECT * FROM catalog WHERE name=?")
      .get("Owner changed app");
    assert.equal(row.enabled, 0);
    assert.equal(row.kind, "app");
    assert.equal(
      store.db.prepare("SELECT enabled FROM catalog WHERE id='2048'").get()
        .enabled,
      0,
    );
  } finally {
    store?.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
