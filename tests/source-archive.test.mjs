import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

const deploymentFiles = [
  "Caddyfile",
  "Caddyfile.cloudfront",
  "Caddyfile.node",
  "compose.yaml",
  "compose.cloudfront.yaml",
  "compose.node.yaml",
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-source-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    "web/public/source",
    "runtime",
    "server",
    "scripts",
    "tests",
    "docs",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  for (const name of [
    ...deploymentFiles,
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "vite.config.ts",
    "vite.runtime.config.ts",
    "playwright.config.ts",
    ".env.example",
    ".gitignore",
    ".prettierignore",
    "Dockerfile",
    ".dockerignore",
    "Dockerfile.node",
    ".env.node.example",
    "LICENSE",
    "THIRD_PARTY.md",
    "README.md",
    "maintenance/history/original-sw.js",
    "maintenance/history/original-server-index.mjs",
    "maintenance/history/DIFF.patch",
  ]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), `original ${name}\n`);
  }
  copyFileSync(
    new URL("../scripts/source-archive.mjs", import.meta.url),
    join(root, "scripts/source-archive.mjs"),
  );
  const upstream = Buffer.from("fixture corresponding source\n");
  writeFileSync(
    join(root, "web/public/source/scramjet-source.tar.gz"),
    upstream,
  );
  writeFileSync(
    join(root, "scripts/runtime-fork.json"),
    JSON.stringify({
      directory: "absent-upstream",
      commit: "fixture",
      archiveSha256: createHash("sha256").update(upstream).digest("hex"),
    }),
  );
  const archive = join(root, "web/public/source/atlas-source.tar.gz");
  return {
    root,
    archive,
    run: () =>
      spawnSync(process.execPath, ["scripts/source-archive.mjs"], {
        cwd: root,
        encoding: "utf8",
      }),
    read: (name) =>
      execFileSync("tar", ["-xOf", archive, name], { encoding: "utf8" }),
  };
}

test("local source archives retain canonical deployment files without staging", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "SOURCE_ARCHIVES_READY");
  for (const name of deploymentFiles)
    assert.equal(f.read(name), `original ${name}\n`);
});

test("deployed source archives use pristine templates, never live Caddy or Compose overrides", (t) => {
  const f = fixture(t);
  const secret = `CUSTOM_DEPLOYMENT_${randomUUID()}`;
  mkdirSync(join(f.root, "deployment-templates"));
  for (const name of deploymentFiles) {
    writeFileSync(join(f.root, name), `${secret} ${name}\n`);
    writeFileSync(
      join(f.root, "deployment-templates", name),
      `pristine ${name}\n`,
    );
  }
  for (const name of [".env", "Caddyfile.node.bak", "compose.override.yaml"])
    writeFileSync(join(f.root, name), secret);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of deploymentFiles) {
    assert.equal(f.read(name), `pristine ${name}\n`);
    assert.equal(
      readFileSync(join(f.root, name), "utf8"),
      `${secret} ${name}\n`,
    );
  }
  assert.ok(!gunzipSync(readFileSync(f.archive)).includes(Buffer.from(secret)));
  const names = execFileSync("tar", ["-tzf", f.archive], {
    encoding: "utf8",
  }).split("\n");
  assert.ok(!names.some((name) => name.startsWith("deployment-templates/")));
  for (const name of [".env", "Caddyfile.node.bak", "compose.override.yaml"])
    assert.ok(!names.includes(name));
});

test("incomplete deployment templates fail before replacing the existing public archive", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "deployment-templates"));
  for (const name of deploymentFiles.filter(
    (name) => name !== "compose.node.yaml",
  ))
    writeFileSync(join(f.root, "deployment-templates", name), "pristine\n");
  writeFileSync(f.archive, "previous verified archive\n");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing regular deployment template: deployment-templates\/compose\.node\.yaml/,
  );
  assert.equal(readFileSync(f.archive, "utf8"), "previous verified archive\n");
});

test("deployment templates reject symlinks rather than falling back to live files", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "deployment-templates"));
  for (const name of deploymentFiles)
    writeFileSync(join(f.root, "deployment-templates", name), "pristine\n");
  rmSync(join(f.root, "deployment-templates/Caddyfile.node"));
  symlinkSync(
    "../Caddyfile.node",
    join(f.root, "deployment-templates/Caddyfile.node"),
  );
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing regular deployment template: deployment-templates\/Caddyfile\.node/,
  );
});

test("combined source archive includes Hub and tooling source without private/generated files or evidence", (t) => {
  const f = fixture(t);
  const source = [
    "dispenser/package.json", "dispenser/pnpm-lock.yaml", "dispenser/pnpm-workspace.yaml",
    "dispenser/apps/server/src/app.ts", "dispenser/packages/database/migrations/0026_catalog.sql",
    "dispenser/scripts/production-bootstrap.mjs", "dispenser/.env.example",
    "tools/diagnostics/probe.mjs", "scripts/workspace.config.json", "CONTRIBUTING.md", ".gitattributes",
  ];
  const secret = `PRIVATE_LOCAL_ONLY_${randomUUID()}`;
  const privateFiles = [
    ".env", "dispenser/.env", "dispenser/apps/server/.env.secret", "dispenser/.git/config",
    "dispenser/.codex/old.txt", "dispenser/evidence/report.txt", "dispenser/backups/snapshot.txt",
    "dispenser/apps/server/node_modules/private.txt", "dispenser/apps/server/dist/built.js",
    "dispenser/apps/server/private.key", "dispenser/packages/database/state.sqlite",
    "tools/diagnostics/__pycache__/probe.pyc", "local-retained/dispenser.git/config",
    "evidence/private.txt", "scripts/.aws/config", "server/.ssh/identity",
    "tools/.pnpm-store/state.txt", "tools/._finder-metadata",
  ];
  for (const name of source) {
    mkdirSync(dirname(join(f.root, name)), { recursive: true });
    writeFileSync(join(f.root, name), `source ${name}\n`);
  }
  for (const name of privateFiles) {
    mkdirSync(dirname(join(f.root, name)), { recursive: true });
    writeFileSync(join(f.root, name), secret);
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const names = execFileSync("tar", ["-tzf", f.archive], { encoding: "utf8" }).split("\n");
  for (const name of source) assert.ok(names.includes(name), `Missing source: ${name}`);
  for (const name of privateFiles) assert.ok(!names.includes(name), `Private source leak: ${name}`);
  assert.ok(!gunzipSync(readFileSync(f.archive)).includes(Buffer.from(secret)));
});

test("source symlinks fail before replacing the last complete archive", (t) => {
  const f = fixture(t);
  writeFileSync(f.archive, "previous verified archive\n");
  symlinkSync("../README.md", join(f.root, "server/external.mjs"));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Source symlink is not packaged/);
  assert.equal(readFileSync(f.archive, "utf8"), "previous verified archive\n");
});

test("macOS extended metadata is not copied into the public source archive", { skip: process.platform !== "darwin" }, (t) => {
  const f = fixture(t);
  const marker = `PRIVATE_FINDER_METADATA_${randomUUID()}`;
  const tagged = spawnSync("xattr", ["-w", "com.atlas.source-archive-fixture", marker, join(f.root, "README.md")], { encoding: "utf8" });
  assert.equal(tagged.status, 0, tagged.stderr);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const names = execFileSync("tar", ["-tzf", f.archive], { encoding: "utf8" }).split("\n");
  assert.ok(!names.some((name) => name.split("/").some((part) => part.startsWith("._"))));
  assert.ok(!gunzipSync(readFileSync(f.archive)).includes(Buffer.from(marker)));
});
