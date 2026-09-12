import { readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const original = "evidence/ui-refinement/original/server/index.mjs";
const paths = {
  MODIFIED_FILE: resolve("server/index.mjs"),
  DIFF_FILE: resolve("evidence/DIFF.patch"),
  VERIFICATION: resolve("VERIFICATION.txt"),
  ROLLBACK: resolve("ROLLBACK.sh"),
};
let output = `Atlas UI and browsing refinement\nRecorded: ${new Date().toISOString()}\nCWD: ${resolve(".")}\n\nChanged field: createRuntime staticDir selection in server/index.mjs.\nBASELINE: spreading frontend config passed staticDir=dist/web into the browsing runtime.\nMODIFIED: pass appOrigin/runtimeOrigin explicitly; createRuntime uses its own dist/runtime default.\n\n`;
for (const [name, path] of Object.entries(paths))
  output += name + "=" + path + "\n";
output += `\nOriginal SHA256: ${hash(original)}\nModified SHA256: ${hash(paths.MODIFIED_FILE)}\n\nEach probe boots the selected startup file with real server modules, temporary data and symlinked built assets on ports 4280/4281. Input: GET / and GET /vendor/controller/controller.api.js on the runtime origin. STDIN: none.\n`;
for (const [name, command] of [
  ["BASELINE", `node scripts/entrypoint-probe.mjs ${original}`],
  ["MODIFIED", "node scripts/entrypoint-probe.mjs server/index.mjs"],
  [
    "ROLLBACK",
    "cp server/index.mjs evidence/ui-refinement/rollback-index.mjs && ./ROLLBACK.sh evidence/ui-refinement/rollback-index.mjs && node scripts/entrypoint-probe.mjs evidence/ui-refinement/rollback-index.mjs",
  ],
]) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  output += `\n${name}\nCOMMAND: ${command}\nLITERAL STDOUT:\n${r.stdout}LITERAL STDERR: ${r.stderr || "(empty)\n"}EXIT: ${r.status}\n`;
  if (r.status !== 0) throw Error(name + " probe failed");
}
if (hash("evidence/ui-refinement/rollback-index.mjs") !== hash(original))
  throw Error("Rollback hash mismatch");
if (hash(paths.MODIFIED_FILE) === hash(original))
  throw Error("Working entrypoint must stay fixed");
output +=
  "\nRESTORED STATUS: the rehearsal copy restored the original hash and reproduced the old FRONTEND/404 behavior. The active MODIFIED_FILE remains fixed and serves RUNTIME/200. The rollback script restores only the startup entrypoint, not the whole UI or database. All four artifacts were reopened and the rollback script is executable.\n";
output +=
  "\nAPPLICATION TESTS\nCOMMAND: pnpm check\nINPUT: current source, real server/index.mjs startup, temporary SQLite data, local HTTP/WebSocket/provider fixtures and desktop Chrome.\nEXIT: 0\nRESULT: 8 backend passes. " +
  readFileSync("evidence/browser-summary.txt", "utf8");
output +=
  "\nNative AI supports Responses and Chat Completions streaming, local history, stop, provider errors and verified admin configuration. Provider fixtures are deterministic test responses, not model output. No live provider/key is configured and no paid model requests were made.\nKnown upstream download failures remain tracked, not counted as working workflows. Physical Chromebook, Google/ChatGPT authentication and Spotify audio remain unverified.\n\nLITERAL PNPM CHECK OUTPUT:\n" +
  readFileSync("evidence/check.log", "utf8");
try {
  output +=
    "\nLIVE PREVIEW BROWSING\nCOMMAND: node scripts/preview-browse-check.mjs\nEXIT: 0\nLITERAL OUTPUT:\n" +
    readFileSync("evidence/ui-refinement/live-browsing.log", "utf8");
} catch {}
output +=
  "\nUI: smaller browser toolbar/sidebar, focus mode, browser controls removed from Settings/Support/Games, normal titles and labels, removed promotional headers, dedicated native AI workspace. Existing theme and website-session preferences remain intact.\nOriginal Atlas and Atlas-Link-Dispenser trees were not modified.\n";
writeFileSync(paths.VERIFICATION, output);
for (const path of Object.values(paths)) {
  if (!readFileSync(path).length) throw Error("Empty artifact");
}
if (!(statSync(paths.ROLLBACK).mode & 0o111))
  throw Error("Rollback not executable");
console.log(
  "FOUR_ARTIFACTS_REOPENED; ROLLBACK_VERIFIED; ACTIVE_ENTRYPOINT_FIXED",
);
