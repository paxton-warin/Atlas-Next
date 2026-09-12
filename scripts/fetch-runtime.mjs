import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
run("-C", fork.directory, "fetch", "origin", fork.commit);
run("-C", fork.directory, "checkout", "--detach", fork.commit);
console.log("FORK_SOURCE_READY=" + fork.commit);
