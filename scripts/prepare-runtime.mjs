import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
for (const old of ["scramjet", "controller", "utils"])
  await rm(join(root, "vendor", old), { recursive: true, force: true });
const hashes = {};
for (const [file, asset] of Object.entries(fork.assets)) {
  const target = join(root, asset.path);
  await mkdir(resolve(target, ".."), { recursive: true });
  await cp(join(fork.directory, "app/vendor", file), target);
  hashes[asset.path] = hash(await readFile(target));
}
for (const [source, name] of [
  ["node_modules/@titaniumnetwork-dev/ultraviolet/dist", "uv"],
  ["node_modules/@mercuryworkshop/bare-mux/dist", "baremux"],
  ["node_modules/uv-epoxy/dist", "epoxy"],
])
  await cp(source, join(root, "vendor", name), { recursive: true });
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(js|mjs|wasm)$/.test(path))
      hashes[path.slice(root.length + 1)] = hash(await readFile(path));
  }
}
await walk(join(root, "vendor"));
await writeFile(
  join(root, "manifest.json"),
  JSON.stringify(
    {
      source: fork.source,
      commit: fork.commit,
      packaging: "unchanged committed app/vendor artifacts",
      core: "2.0.67-alpha.2",
      controller: "0.0.14",
      ultraviolet: "3.2.10",
      hashes,
    },
    null,
    2,
  ),
);
console.log(
  `FORK_ASSETS_VERIFIED=8; RUNTIME_HASHES=${Object.keys(hashes).length}; COMMIT=${fork.commit}`,
);
