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
    "ROLLBACK.sh",
    "evidence/ORIGINAL-sw.js",
    "evidence/ui-refinement/original/server/index.mjs",
    "evidence/DIFF.patch",
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
