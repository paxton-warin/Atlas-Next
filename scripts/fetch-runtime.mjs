import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const fork = JSON.parse(
  readFileSync(new URL("./runtime-fork.json", import.meta.url)),
);
const run = (...args) => execFileSync("git", args, { stdio: "inherit" });
if (!existsSync(fork.directory)) run("clone", fork.source, fork.directory);
const status = execFileSync(
  "git",
  ["-C", fork.directory, "status", "--porcelain", "--untracked-files=no"],
  { encoding: "utf8" },
);
if (status.trim())
  throw Error("Preserve local fork changes before fetching the pin.");
const hasCommit = () =>
  spawnSync(
    "git",
    ["-C", fork.directory, "cat-file", "-e", fork.commit + "^{commit}"],
    { stdio: "ignore" },
  ).status === 0;
if (!hasCommit()) {
  if (fork.bundle && existsSync(fork.bundle)) {
    const actual = createHash("sha256")
      .update(readFileSync(fork.bundle))
      .digest("hex");
    if (actual !== fork.bundleSha256)
      throw Error("Runtime source bundle hash mismatch.");
    run("-C", fork.directory, "fetch", resolve(fork.bundle), "HEAD");
    if (!hasCommit()) throw Error("Runtime bundle does not contain the pin.");
  } else run("-C", fork.directory, "fetch", "origin", fork.commit);
}
run("-C", fork.directory, "checkout", "--detach", fork.commit);
console.log("FORK_SOURCE_READY=" + fork.commit);
