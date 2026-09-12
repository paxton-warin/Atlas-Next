// Explicit allowlist: never package databases, environment secrets, browser results, or node_modules.
import { mkdirSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
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
execFileSync("tar", [
  "--exclude=web/public/source",
  "--exclude=runtime/public/vendor",
  "--exclude=runtime/public/manifest.json",
  "--exclude=runtime/public/bootstrap",
  "--exclude=runtime/public/runtime",
  "--exclude=runtime/public/controller",
  "--exclude=runtime/public/clients",
  "-czf",
  resolve(out, "atlas-source.tar.gz"),
  "web",
  "runtime",
  "server",
  "scripts",
  "tests",
  "docs",
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
  "compose.yaml",
  "Caddyfile",
  "Caddyfile.cloudfront",
  "Caddyfile.node",
  "Dockerfile.node",
  "compose.node.yaml",
  ".env.node.example",
  "LICENSE",
  "THIRD_PARTY.md",
  "README.md",
  "ROLLBACK.sh",
  "evidence/ORIGINAL-sw.js",
  "evidence/ui-refinement/original/server/index.mjs",
  "evidence/DIFF.patch",
]);
console.log("SOURCE_ARCHIVES_READY");
