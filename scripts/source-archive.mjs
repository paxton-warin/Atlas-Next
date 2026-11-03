// Explicit allowlist: never package databases, environment secrets, browser results, or node_modules.
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  readFileSync,
  lstatSync,
  readdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
// Deployments can keep custom root Caddy/Compose files, including private site
// details. Package only the six pristine templates uploaded with this release.
// Validate the entire set before touching an existing public source archive.
const deploymentFiles = [
  "Caddyfile",
  "Caddyfile.cloudfront",
  "Caddyfile.node",
  "compose.yaml",
  "compose.cloudfront.yaml",
  "compose.node.yaml",
];
const templates = resolve("deployment-templates");
let templateStat;
try {
  templateStat = lstatSync(templates);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (templateStat) {
  if (!templateStat.isDirectory())
    throw Error(
      "deployment-templates must be a directory of pristine release files.",
    );
  for (const name of deploymentFiles) {
    let stat;
    try {
      stat = lstatSync(resolve(templates, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!stat?.isFile())
      throw Error(
        `Missing regular deployment template: deployment-templates/${name}`,
      );
  }
}
const fork = JSON.parse(
  readFileSync(new URL("./runtime-fork.json", import.meta.url)),
);
const out = resolve("web/public/source");
mkdirSync(out, { recursive: true });
const upstream = resolve(out, "scramjet-source.tar.gz");
if (existsSync(fork.directory + "/.git"))
  execFileSync("git", [
    "-C",
    fork.directory,
    "archive",
    "--format=tar.gz",
    "--output=" + upstream,
    fork.commit,
  ]);
else if (!existsSync(upstream))
  throw Error(
    "Run the source build before packaging; corresponding upstream source archive is required.",
  );
const sourceHash = createHash("sha256")
  .update(readFileSync(upstream))
  .digest("hex");
if (sourceHash !== fork.archiveSha256)
  throw Error("Corresponding fork source archive hash mismatch.");
copyFileSync("LICENSE", resolve(out, "LICENSE.txt"));
copyFileSync("THIRD_PARTY.md", resolve(out, "THIRD_PARTY.txt"));
// Package only source roots. Component-only browser images intentionally omit
// dispenser/; a complete checkout includes both components in the same archive.
// Never walk symlinks or depend on disposable audit output.
const sourceRoots = ["web", "runtime", "server", "scripts", "tests", "docs", "tools", "maintenance"];
const hubRoots = ["dispenser/apps", "dispenser/packages", "dispenser/scripts", "dispenser/docs", "dispenser/deployment"];
const privateSegments = new Set([
  ".git", ".codex", ".aws", ".ssh", ".pnpm-store", "node_modules", "dist", "data", "node-data", "backups",
  "evidence", "test-results", "playwright-report", "coverage", ".cache", "__pycache__",
]);
const generatedPrefixes = [
  "web/public/source", "runtime/public/vendor", "runtime/public/bootstrap",
  "runtime/public/runtime", "runtime/public/controller", "runtime/public/clients",
];
const sourceFiles = [];
function excluded(path) {
  const parts = path.split("/");
  const name = parts.at(-1);
  return parts.some((part) => privateSegments.has(part)) ||
    generatedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/")) ||
    path === "runtime/public/manifest.json" ||
    name === ".DS_Store" || name.startsWith("._") || name === ".origin-key" || name === ".npmrc" ||
    name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example")) ||
    /\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|pyc|pyo|log|tsbuildinfo)$/.test(name);
}
function collect(path) {
  if (excluded(path)) return;
  if (/[\r\n\0]/.test(path)) throw Error("Unsupported source filename");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw Error(`Source symlink is not packaged: ${path}`);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) collect(path + "/" + name);
  } else if (stat.isFile()) sourceFiles.push(path);
  else throw Error(`Source entry must be a regular file: ${path}`);
}
for (const path of sourceRoots) if (existsSync(path)) collect(path);
for (const path of hubRoots) if (existsSync(path)) collect(path);
const rootFiles = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
  "vite.config.ts", "vite.runtime.config.ts", "playwright.config.ts",
  ".env.example", ".env.node.example", ".gitignore", ".prettierignore",
  "Dockerfile", ".dockerignore", "Dockerfile.node", "LICENSE", "THIRD_PARTY.md", "README.md",
];
for (const path of rootFiles) collect(path);
for (const path of ["CONTRIBUTING.md", ".gitattributes"]) if (existsSync(path)) collect(path);
if (existsSync("dispenser")) {
  for (const path of [
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json",
    "Dockerfile", "Dockerfile.cloud-worker", "docker-compose.yml", "docker-compose.test.yml",
    "compose.cloud-worker.yaml", "compose.backup-v2-worker.yaml", ".env.example",
    ".gitignore", ".dockerignore", ".prettierignore", "README.md",
  ]) if (existsSync("dispenser/" + path)) collect("dispenser/" + path);
}
const archive = resolve(out, "atlas-source.tar.gz");
const pending = archive + `.pending-${process.pid}`;
const list = archive + `.list-${process.pid}`;
const staging = mkdtempSync(resolve(out, ".atlas-source-stage-"));
try {
  // A single private staging root gives BSD and GNU tar identical -C semantics.
  // Never copy pristine templates over server-owned live configuration.
  for (const path of sourceFiles) {
    const target = resolve(staging, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
  }
  for (const name of deploymentFiles)
    copyFileSync(templateStat ? resolve(templates, name) : name, resolve(staging, name));
  const names = [...sourceFiles, ...deploymentFiles].sort();
  writeFileSync(list, Buffer.from(names.join("\0") + "\0"), { mode: 0o600 });
  execFileSync("tar", ["-czf", pending, "-C", staging, "--null", "-T", list], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  renameSync(pending, archive);
} finally {
  rmSync(pending, { force: true });
  rmSync(list, { force: true });
  rmSync(staging, { recursive: true, force: true });
}
console.log("SOURCE_ARCHIVES_READY");
