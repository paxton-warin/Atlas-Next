import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  cpSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const helperPath = fileURLToPath(
  new URL("../scripts/retarget-cloudfront.mjs", import.meta.url),
);
let module;
try {
  module = await import("../scripts/retarget-cloudfront.mjs");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
const id1 = "00000000-0000-4000-8000-000000000001",
  id2 = "00000000-0000-4000-8000-000000000002";
function helper() {
  assert.ok(module, "retarget helper exists");
  return module;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-retarget-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  const backup = join(root, "backups");
  const db = new DatabaseSync(join(data, "atlas.sqlite"));
  db.exec(
    "CREATE TABLE nodes(id TEXT PRIMARY KEY,name TEXT,endpoint TEXT,credential TEXT,state TEXT,weight INTEGER); CREATE TABLE browse_leases(hash TEXT,node TEXT); CREATE TABLE settings(key TEXT,value TEXT);",
  );
  db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?)").run(
    "local",
    "Main server",
    "",
    "",
    "active",
    1,
  );
  db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?)").run(
    id1,
    "Node 2",
    "https://dold2.cloudfront.net",
    "sealed-secret-2",
    "draining",
    2,
  );
  db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?)").run(
    id2,
    "Node 3",
    "https://dold3.cloudfront.net",
    "sealed-secret-3",
    "disabled",
    3,
  );
  db.prepare("INSERT INTO browse_leases VALUES (?,?)").run(
    "fixture-lease",
    id1,
  );
  db.prepare("INSERT INTO settings VALUES (?,?)").run("owner", "unchanged");
  db.close();
  writeFileSync(join(data, "master.key"), "fixture-master-key", {
    mode: 0o600,
  });
  writeFileSync(
    join(data, "node.json"),
    JSON.stringify({
      id: id1,
      secret: "fixture-node-secret",
      control: "https://doldmain.cloudfront.net",
      extra: { nested: true },
    }),
    { mode: 0o600 },
  );
  const plan = {
    changes: [
      {
        id: id1,
        from: "https://dold2.cloudfront.net",
        to: "https://dnew2.cloudfront.net",
      },
    ],
  };
  return { root, data, backup, plan };
}
function hashes(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(dir, name)))
          .digest("hex"),
      ]),
  );
}
function rows(data, table = "nodes") {
  const db = new DatabaseSync(join(data, "atlas.sqlite"), { readOnly: true });
  try {
    return db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((x) => ({ ...x }));
  } finally {
    db.close();
  }
}
test("inspect outputs only public node fields and dry run leaves bytes unchanged", (t) => {
  const f = fixture(t),
    before = hashes(f.data),
    h = helper();
  assert.deepEqual(Object.keys(h.inspectMain(f.data)[0]).sort(), [
    "endpoint",
    "id",
    "name",
    "state",
  ]);
  assert.deepEqual(h.inspectNode(f.data), {
    id: id1,
    control: "https://doldmain.cloudfront.net",
  });
  assert.equal(h.retargetMain({ data: f.data, plan: f.plan }).changed, 1);
  assert.deepEqual(hashes(f.data), before);
});
test("main apply changes endpoint only, backs up whole tree privately, rollback restores hashes", (t) => {
  const f = fixture(t),
    before = hashes(f.data),
    beforeRows = rows(f.data),
    leases = rows(f.data, "browse_leases");
  const result = helper().retargetMain({
    data: f.data,
    plan: f.plan,
    apply: true,
    offline: true,
    backupDir: f.backup,
  });
  const expected = beforeRows.map((row) =>
    row.id === id1 ? { ...row, endpoint: "https://dnew2.cloudfront.net" } : row,
  );
  assert.deepEqual(rows(f.data), expected);
  assert.deepEqual(rows(f.data, "browse_leases"), leases);
  assert.deepEqual(hashes(join(result.backup, "data")), before);
  assert.equal(statSync(result.backup).mode & 0o777, 0o700);
  const restored = join(f.root, "restored");
  cpSync(join(result.backup, "data"), restored, { recursive: true });
  assert.deepEqual(hashes(restored), before);
  const unchanged = hashes(f.data);
  assert.equal(
    helper().retargetMain({
      data: f.data,
      plan: f.plan,
      apply: true,
      offline: true,
      backupDir: f.backup,
    }).changed,
    0,
  );
  assert.deepEqual(hashes(f.data), unchanged);
});
test("node update preserves every other field and complete backup can restore original bytes", (t) => {
  const f = fixture(t),
    before = hashes(f.data),
    node = JSON.parse(readFileSync(join(f.data, "node.json")));
  const plan = {
    id: id1,
    fromControl: node.control,
    toControl: "https://dnewmain.cloudfront.net",
  };
  const result = helper().retargetNode({
    data: f.data,
    plan,
    apply: true,
    offline: true,
    backupDir: f.backup,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(f.data, "node.json"))), {
    ...node,
    control: plan.toControl,
  });
  assert.deepEqual(hashes(join(result.backup, "data")), before);
  const current = hashes(f.data);
  assert.equal(
    helper().retargetNode({
      data: f.data,
      plan,
      apply: true,
      offline: true,
      backupDir: f.backup,
    }).changed,
    0,
  );
  assert.deepEqual(hashes(f.data), current);
  const restored = join(f.root, "restore-node");
  cpSync(join(result.backup, "data"), restored, { recursive: true });
  assert.deepEqual(hashes(restored), before);
});
test("apply requires offline acknowledgement and external backup directory before writes", (t) => {
  const f = fixture(t),
    before = hashes(f.data);
  assert.throws(
    () =>
      helper().retargetMain({
        data: f.data,
        plan: f.plan,
        apply: true,
        backupDir: f.backup,
      }),
    /offline/,
  );
  assert.throws(
    () =>
      helper().retargetMain({
        data: f.data,
        plan: f.plan,
        apply: true,
        offline: true,
        backupDir: join(f.data, "backup"),
      }),
    /outside/,
  );
  assert.deepEqual(hashes(f.data), before);
});
for (const [label, mutate] of [
  ["local", (p) => (p.changes[0].id = "local")],
  [
    "missing",
    (p) => (p.changes[0].id = "00000000-0000-4000-8000-000000000099"),
  ],
  ["old mismatch", (p) => (p.changes[0].from = "https://wrong.cloudfront.net")],
  ["duplicates", (p) => p.changes.push({ ...p.changes[0] })],
  ["collision", (p) => (p.changes[0].to = "https://dold3.cloudfront.net")],
  ["HTTP", (p) => (p.changes[0].to = "http://dnew.cloudfront.net")],
  ["path", (p) => (p.changes[0].to = "https://dnew.cloudfront.net/path")],
  ["query", (p) => (p.changes[0].to = "https://dnew.cloudfront.net?x=1")],
  [
    "credential",
    (p) => (p.changes[0].to = "https://secret@dnew.cloudfront.net"),
  ],
])
  test(`main rejects ${label} with no writes`, (t) => {
    const f = fixture(t),
      before = hashes(f.data);
    mutate(f.plan);
    assert.throws(() =>
      helper().retargetMain({
        data: f.data,
        plan: f.plan,
        apply: true,
        offline: true,
        backupDir: f.backup,
      }),
    );
    assert.deepEqual(hashes(f.data), before);
  });
test("all main changes validate before writes", (t) => {
  const f = fixture(t),
    before = hashes(f.data);
  f.plan.changes.push({
    id: id2,
    from: "https://mismatch.cloudfront.net",
    to: "https://dnew3.cloudfront.net",
  });
  assert.throws(() =>
    helper().retargetMain({
      data: f.data,
      plan: f.plan,
      apply: true,
      offline: true,
      backupDir: f.backup,
    }),
  );
  assert.deepEqual(hashes(f.data), before);
});
test("node old-control and id mismatches do not touch credentials", (t) => {
  const f = fixture(t),
    before = hashes(f.data),
    h = helper();
  for (const plan of [
    {
      id: id2,
      fromControl: "https://doldmain.cloudfront.net",
      toControl: "https://dnewmain.cloudfront.net",
    },
    {
      id: id1,
      fromControl: "https://wrong.cloudfront.net",
      toControl: "https://dnewmain.cloudfront.net",
    },
  ])
    assert.throws(() =>
      h.retargetNode({
        data: f.data,
        plan,
        apply: true,
        offline: true,
        backupDir: f.backup,
      }),
    );
  assert.deepEqual(hashes(f.data), before);
});
test("CLI inspect prints no credentials, explicit apply defaults to dry run", (t) => {
  const f = fixture(t);
  helper();
  const planFile = join(f.root, "plan.json");
  writeFileSync(planFile, JSON.stringify(f.plan));
  const run = (...args) =>
    spawnSync(process.execPath, [helperPath, ...args], {
      encoding: "utf8",
    });
  const inspect = run("inspect-main", "--data", f.data);
  assert.equal(inspect.status, 0);
  assert.ok(!inspect.stdout.includes("secret"));
  assert.equal(JSON.parse(inspect.stdout).length, 3);
  const out = run("main", "--data", f.data, "--plan", planFile);
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).mode, "dry-run");
});

test("symlink backup paths into data and linked source files are rejected", (t) => {
  const f = fixture(t),
    h = helper(),
    before = hashes(f.data),
    alias = join(f.root, "backup-alias");
  symlinkSync(f.data, alias);
  assert.throws(
    () =>
      h.retargetMain({
        data: f.data,
        plan: f.plan,
        apply: true,
        offline: true,
        backupDir: join(alias, "backup"),
      }),
    /outside/,
  );
  assert.deepEqual(hashes(f.data), before);
  symlinkSync(join(f.root, "outside-secret"), join(f.data, "symlink"));
  assert.throws(
    () =>
      h.retargetMain({
        data: f.data,
        plan: f.plan,
        apply: true,
        offline: true,
        backupDir: f.backup,
      }),
    /symlinks/,
  );
});
test("nested stopped data files are backed up and secrets are absent from CLI output", (t) => {
  const f = fixture(t),
    nested = join(f.data, "nested");
  mkdirSync(nested, { mode: 0o755 });
  writeFileSync(join(nested, "extra"), "private-fixture-payload");
  const plan = {
    id: id1,
    fromControl: "https://doldmain.cloudfront.net",
    toControl: "https://dnewmain.cloudfront.net",
  };
  const result = helper().retargetNode({
    data: f.data,
    plan,
    apply: true,
    offline: true,
    backupDir: f.backup,
  });
  assert.equal(
    readFileSync(join(result.backup, "data/nested/extra"), "utf8"),
    "private-fixture-payload",
  );
  assert.equal(
    statSync(join(result.backup, "data/nested")).mode & 0o777,
    0o700,
  );
  assert.equal(
    statSync(join(result.backup, "data/nested/extra")).mode & 0o777,
    0o600,
  );
  const out = spawnSync(
    process.execPath,
    [helperPath, "inspect-node", "--data", f.data],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout), {
    id: id1,
    control: plan.toControl,
  });
  assert.ok(!out.stdout.includes("secret"));
  writeFileSync(
    join(f.data, "node.json"),
    '{"secret":"SENSITIVE_FIXTURE", broken',
  );
  const invalid = spawnSync(
    process.execPath,
    [helperPath, "inspect-node", "--data", f.data],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes("SENSITIVE_FIXTURE"));
});
