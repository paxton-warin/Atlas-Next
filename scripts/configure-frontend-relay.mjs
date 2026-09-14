#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  constants,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function configureFrontendRelay(filename = ".env") {
  const target = resolve(filename);
  const source = readFileSync(target, "utf8");
  const lines = source.split(/\r?\n/);
  const assignments = new Map();
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
      line,
    );
    if (match)
      assignments.set(match[1], match[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  // Never echo values: this file contains the origin key and may contain AI keys.
  for (const key of ["APP_ORIGIN", "ORIGIN_HOST", "ORIGIN_KEY"])
    if (!assignments.get(key))
      throw Error(`Set ${key} in .env before configuring the main relay.`);
  let app;
  try {
    app = new URL(assignments.get("APP_ORIGIN"));
  } catch {
    /* reported below */
  }
  if (
    !app ||
    app.protocol !== "https:" ||
    app.username ||
    app.password ||
    app.pathname !== "/" ||
    app.search ||
    app.hash
  )
    throw Error(
      "APP_ORIGIN must be a plain HTTPS origin, not a Markdown link.",
    );
  const removed = new Set([
    "LOCAL_BROWSING",
    "LOCAL_RELAY_MODE",
    "RUNTIME_HOST",
    "RUNTIME_ORIGIN",
  ]);
  const kept = lines
    .filter((line) => {
      const key = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
      return !removed.has(key);
    })
    .join("\n")
    .trimEnd();
  const updated = kept + "\nLOCAL_BROWSING=true\nLOCAL_RELAY_MODE=frontend\n";
  if (updated === source) return { changed: false, backup: null };
  const backup = `${target}.before-frontend-relay-${Date.now()}`;
  copyFileSync(target, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  writeFileSync(target, updated, { mode: 0o600 });
  chmodSync(target, 0o600);
  return { changed: true, backup };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { changed, backup } = configureFrontendRelay(process.argv[2]);
    console.log(
      changed
        ? `Main frontend relay configured. Backup: ${backup}`
        : "Main frontend relay already configured.",
    );
    console.log(
      "Recreate app and edge with compose.cloudfront.yaml, then set Main server Active in the owner panel.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
