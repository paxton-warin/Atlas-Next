import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
const fork = JSON.parse(
  await readFile(new URL("./runtime-fork.json", import.meta.url)),
);
const root = resolve("runtime/public");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (existsSync(join(fork.directory, ".git"))) {
  const commit = execFileSync(
    "git",
    ["-C", fork.directory, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  if (commit !== fork.commit)
    throw Error("Runtime fork commit differs from the pin.");
}
// Validate everything BEFORE replacing any live prepared asset.
for (const [file, asset] of Object.entries(fork.assets)) {
  const bytes = await readFile(join(fork.directory, "app/vendor", file));
  if (hash(bytes) !== asset.sha256)
    throw Error(`Fork artifact hash mismatch: ${file}`);
}
for (const old of ["scramjet", "controller", "utils", "uv", "baremux", "epoxy"])
  await rm(join(root, "vendor", old), { recursive: true, force: true });
const hashes = {};
for (const [file, asset] of Object.entries(fork.assets)) {
  const target = join(root, asset.path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(fork.directory, "app/vendor", file), target);
  const bytes = await readFile(target);
  hashes[asset.path] = hash(bytes);
  // CloudFront's dynamic/no-cache behavior need not perform edge compression.
  // Build variants once; do not compress on the browsing request's critical path.
  // The pinned source asset and its recorded hash remain byte-for-byte unchanged.
  for (const [suffix, compress] of [
    [".br", brotliCompressSync],
    [".gz", gzipSync],
  ]) {
    const compressed = bytes.length >= 1024 ? compress(bytes) : null;
    if (compressed && compressed.length < bytes.length)
      await writeFile(target + suffix, compressed);
    else await rm(target + suffix, { force: true });
  }
}
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(js|mjs|wasm)$/.test(path))
      hashes[path.slice(root.length + 1)] = hash(await readFile(path));
  }
}
// Fresh clones have no legacy vendor directory; the pinned fork writes its
// artifacts to the paths above instead.
if (existsSync(join(root, "vendor"))) await walk(join(root, "vendor"));
await writeFile(
  join(root, "manifest.json"),
  JSON.stringify(
    {
      source: fork.source,
      commit: fork.commit,
      packaging: "unchanged committed app/vendor artifacts",
      core: "2.0.67-alpha.2",
      controller: "0.0.14",
      hashes,
    },
    null,
    2,
  ),
);
console.log(
  `FORK_ASSETS_VERIFIED=8; RUNTIME_HASHES=${Object.keys(hashes).length}; COMMIT=${fork.commit}`,
);
