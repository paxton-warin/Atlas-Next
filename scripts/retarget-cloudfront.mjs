#!/usr/bin/env node
// Offline CloudFront URL migration. Never starts Atlas or alters pairing secrets.
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  chmodSync,
  chownSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import {
  resolve,
  join,
  dirname,
  basename,
  relative,
  isAbsolute,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const fail = (message) => {
  throw new Error(message);
};
const idPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`Invalid ${label}.`);
  return value;
}
function id(value) {
  if (typeof value !== "string" || !idPattern.test(value))
    fail("Use an existing remote node ID, not local.");
  return value;
}
function origin(value) {
  if (typeof value !== "string")
    fail("Use exact HTTPS origins without a trailing slash.");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Invalid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value !== url.origin
  )
    fail(
      "Use exact HTTPS origins without a trailing slash, path, query or credentials.",
    );
  return value;
}
function directory(value) {
  if (typeof value !== "string" || !value) fail("--data is required.");
  const path = resolve(value);
  if (
    !existsSync(path) ||
    !lstatSync(path).isDirectory() ||
    lstatSync(path).isSymbolicLink()
  )
    fail("Data directory must already exist and must not be a symlink.");
  return realpathSync(path);
}
function regular(path) {
  if (
    !existsSync(path) ||
    !lstatSync(path).isFile() ||
    lstatSync(path).isSymbolicLink()
  )
    fail("Required data file is missing or is not a regular file.");
}
function parseFile(path, label) {
  regular(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`Invalid ${label} JSON; file contents were not printed.`);
  }
}
function openDb(data, readOnly = true) {
  const path = join(data, "atlas.sqlite");
  regular(path);
  return new DatabaseSync(path, { readOnly, timeout: 1000 });
}
function mainRows(db) {
  return db
    .prepare("SELECT id,name,endpoint,state FROM nodes ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
}
export function inspectMain(data) {
  data = directory(data);
  const db = openDb(data);
  try {
    return mainRows(db);
  } finally {
    db.close();
  }
}
function nodeRecord(data) {
  const record = object(parseFile(join(data, "node.json"), "node"), "node");
  id(record.id);
  origin(record.control);
  if (typeof record.secret !== "string" || !record.secret)
    fail("Existing node pairing credentials are missing.");
  return record;
}
export function inspectNode(data) {
  data = directory(data);
  const record = nodeRecord(data);
  return { id: record.id, control: record.control };
}
function mainPlan(plan, rows) {
  object(plan, "main plan");
  if (
    !Array.isArray(plan.changes) ||
    !plan.changes.length ||
    plan.changes.length > 5000
  )
    fail("Plan changes must contain 1–5,000 remote nodes.");
  const seen = new Set(),
    records = new Map(rows.map((row) => [row.id, row]));
  const changes = plan.changes.map((change) => {
    object(change, "change");
    id(change.id);
    origin(change.from);
    origin(change.to);
    if (seen.has(change.id)) fail("Duplicate node ID in plan.");
    seen.add(change.id);
    const current = records.get(change.id);
    if (!current) fail("A planned node ID does not exist.");
    if (current.endpoint !== change.from && current.endpoint !== change.to)
      fail(
        "An existing endpoint does not exactly match its planned old or new value.",
      );
    return {
      id: change.id,
      from: change.from,
      to: change.to,
      changed: current.endpoint !== change.to,
    };
  });
  const updates = new Map(changes.map((change) => [change.id, change.to])),
    endpoints = new Set();
  for (const row of rows) {
    if (row.id === "local") continue;
    const endpoint = updates.get(row.id) ?? row.endpoint;
    if (endpoints.has(endpoint))
      fail(
        "Endpoint collision: remote nodes must have distinct resulting endpoints.",
      );
    endpoints.add(endpoint);
  }
  return changes;
}
function nodePlan(plan, record) {
  object(plan, "node plan");
  id(plan.id);
  origin(plan.fromControl);
  origin(plan.toControl);
  if (record.id !== plan.id)
    fail("The node ID does not match this data directory.");
  if (record.control !== plan.fromControl && record.control !== plan.toControl)
    fail(
      "Existing node control does not exactly match its planned old or new value.",
    );
  return {
    id: plan.id,
    fromControl: plan.fromControl,
    toControl: plan.toControl,
    changed: record.control !== plan.toControl,
  };
}
function projectedPath(path) {
  let cursor = resolve(path),
    tails = [];
  while (!existsSync(cursor)) {
    tails.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) fail("Invalid backup path.");
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...tails);
}
function outside(data, path) {
  const diff = relative(data, path);
  return (
    diff !== "" && (diff === ".." || diff.startsWith("../") || isAbsolute(diff))
  );
}
function writeOptions({ apply, offline, backupDir }, data) {
  if (!apply) return;
  if (offline !== true)
    fail("--apply requires --offline after stopping the service.");
  if (typeof backupDir !== "string" || !backupDir)
    fail("--apply requires --backup-dir outside the data directory.");
  const destination = projectedPath(backupDir);
  if (!outside(data, destination))
    fail("Backup directory must be outside the data directory.");
  if (existsSync(destination) && !lstatSync(destination).isDirectory())
    fail("Backup path must be a directory.");
  return destination;
}
function manifestTree(dir, prefix = "") {
  const result = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name),
      info = lstatSync(path),
      rel = prefix ? `${prefix}/${name}` : name;
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      fail(
        "Data backups accept only regular files and directories; remove symlinks or special files first.",
      );
    if (info.isDirectory()) {
      result.push({
        path: rel,
        type: "directory",
        mode: info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
      });
      result.push(...manifestTree(path, rel));
    } else
      result.push({
        path: rel,
        type: "file",
        mode: info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      });
  }
  return result;
}
function hashesOnly(manifest) {
  return JSON.stringify(
    manifest
      .filter((row) => row.type === "file")
      .map((row) => ({ path: row.path, sha256: row.sha256 })),
  );
}
function privateTree(dir) {
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) privateTree(path);
    else chmodSync(path, 0o600);
  }
}
function backup(data, base, kind, plan) {
  // Every source file is checked before creating a destination or opening writable SQLite.
  const manifest = manifestTree(data);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const saved = mkdtempSync(join(base, "atlas-retarget-"));
  chmodSync(saved, 0o700);
  cpSync(data, join(saved, "data"), {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  privateTree(join(saved, "data"));
  // Preserve source ownership for an offline cp -a restoration. The outer
  // backup directory remains owned by the operator and private (0700).
  const sourceRoot = lstatSync(data);
  chownSync(join(saved, "data"), sourceRoot.uid, sourceRoot.gid);
  for (const entry of manifest)
    chownSync(join(saved, "data", entry.path), entry.uid, entry.gid);
  if (
    hashesOnly(manifestTree(data)) !== hashesOnly(manifest) ||
    hashesOnly(manifestTree(join(saved, "data"))) !== hashesOnly(manifest)
  )
    fail(
      "Data changed while making the backup. Stop every writer and retry; nothing was retargeted.",
    );
  writeFileSync(
    join(saved, "manifest.json"),
    JSON.stringify(
      {
        format: "atlas-retarget-backup-v1",
        kind,
        createdAt: new Date().toISOString(),
        dataRootMode: sourceRoot.mode & 0o777,
        dataRootUid: sourceRoot.uid,
        dataRootGid: sourceRoot.gid,
        plan,
        files: manifest,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return saved;
}
export function retargetMain(options) {
  const data = directory(options.data),
    backupDir = writeOptions(options, data);
  const initial = inspectMain(data),
    changes = mainPlan(options.plan, initial),
    changed = changes.filter((change) => change.changed).length;
  const result = {
    mode: options.apply ? "apply" : "dry-run",
    kind: "main",
    changed,
    unchanged: changes.length - changed,
    changes: changes.map(({ changed, ...change }) => change),
  };
  if (!options.apply || !changed) return result;
  const saved = backup(data, backupDir, "main", options.plan),
    db = openDb(data, false);
  try {
    db.exec("BEGIN IMMEDIATE");
    const fresh = mainPlan(options.plan, mainRows(db));
    if (JSON.stringify(fresh) !== JSON.stringify(changes))
      fail(
        "The node endpoints changed after preview. Stop every writer and retry.",
      );
    const update = db.prepare(
      "UPDATE nodes SET endpoint=? WHERE id=? AND endpoint=?",
    );
    for (const change of fresh.filter((change) => change.changed))
      if (update.run(change.to, change.id, change.from).changes !== 1)
        fail("Endpoint update precondition failed.");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
  const verified = mainPlan(options.plan, inspectMain(data));
  if (verified.some((change) => change.changed))
    fail("Post-update verification failed; retain the backup.");
  return { ...result, backup: saved };
}
export function retargetNode(options) {
  const data = directory(options.data),
    backupDir = writeOptions(options, data),
    file = join(data, "node.json");
  const record = nodeRecord(data),
    change = nodePlan(options.plan, record),
    result = {
      mode: options.apply ? "apply" : "dry-run",
      kind: "node",
      changed: change.changed ? 1 : 0,
      unchanged: change.changed ? 0 : 1,
      id: change.id,
      fromControl: change.fromControl,
      toControl: change.toControl,
    };
  if (!options.apply || !change.changed) return result;
  const original = readFileSync(file),
    saved = backup(data, backupDir, "node", options.plan);
  if (!readFileSync(file).equals(original))
    fail("Node data changed after preview. Stop every writer and retry.");
  const info = lstatSync(file),
    temporary = join(data, `.node-retarget-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", info.mode & 0o777);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ ...record, control: change.toControl }, null, 2) +
          "\n",
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, info.mode & 0o777);
    chownSync(temporary, info.uid, info.gid);
    if (!readFileSync(file).equals(original))
      fail(
        "Node data changed before replacement. Stop every writer and retry.",
      );
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const verified = nodeRecord(data);
  if (
    verified.id !== record.id ||
    verified.control !== change.toControl ||
    JSON.stringify({ ...verified, control: record.control }) !==
      JSON.stringify(record)
  )
    fail("Post-update verification failed; retain the backup.");
  return { ...result, backup: saved };
}
export function cli(args) {
  const [command, ...rest] = args,
    options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (["--apply", "--offline"].includes(key)) {
      if (options[key.slice(2)] !== undefined) fail("Duplicate option.");
      options[key.slice(2)] = true;
      continue;
    }
    const names = {
      "--data": "data",
      "--plan": "planFile",
      "--backup-dir": "backupDir",
    };
    if (
      !names[key] ||
      !rest[i + 1] ||
      rest[i + 1].startsWith("--") ||
      options[names[key]] !== undefined
    )
      fail("Unknown, duplicate or missing command option.");
    options[names[key]] = rest[++i];
  }
  if (command === "inspect-main" || command === "inspect-node") {
    if (
      options.apply ||
      options.offline ||
      options.planFile ||
      options.backupDir
    )
      fail("Inspect accepts only --data.");
    return command === "inspect-main"
      ? inspectMain(options.data)
      : inspectNode(options.data);
  }
  if (!["main", "node"].includes(command) || !options.planFile)
    fail(
      "Usage: retarget-cloudfront.mjs inspect-main|inspect-node --data DIR; or main|node --data DIR --plan FILE [--apply --offline --backup-dir DIR]",
    );
  options.plan = parseFile(resolve(options.planFile), "plan");
  return command === "main" ? retargetMain(options) : retargetNode(options);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
