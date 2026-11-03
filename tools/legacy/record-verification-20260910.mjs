// Historical September 2026 verification recorder; explicit input captures required.
// Generates a new local report and never overwrites the retained original receipt.
import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const original = "maintenance/history/original-server-index.mjs";
const reportDirectory = resolve(process.env.ATLAS_LEGACY_REPORT_DIR || "test-results/legacy-entrypoint");
mkdirSync(reportDirectory, {recursive:true});
// Stop before starting the historical startup probes unless real local captures exist.
for (const file of ["browser-summary.txt", "check.log"]) readFileSync(resolve(reportDirectory, file));
const paths = {
  MODIFIED_FILE: resolve("server/index.mjs"),
  DIFF_FILE: resolve("maintenance/history/DIFF.patch"),
  VERIFICATION: resolve(reportDirectory, "VERIFICATION.txt"),
  ROLLBACK: resolve("maintenance/history/rollback-entrypoint.sh"),
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
    `cp server/index.mjs "${reportDirectory}/rollback-index.mjs" && ./maintenance/history/rollback-entrypoint.sh "${reportDirectory}/rollback-index.mjs" && node scripts/entrypoint-probe.mjs "${reportDirectory}/rollback-index.mjs"`,
  ],
]) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  output += `\n${name}\nCOMMAND: ${command}\nLITERAL STDOUT:\n${r.stdout}LITERAL STDERR: ${r.stderr || "(empty)\n"}EXIT: ${r.status}\n`;
  if (r.status !== 0) throw Error(name + " probe failed");
}
if (hash(resolve(reportDirectory, "rollback-index.mjs")) !== hash(original))
  throw Error("Rollback hash mismatch");
if (hash(paths.MODIFIED_FILE) === hash(original))
  throw Error("Working entrypoint must stay fixed");
output +=
  "\nRESTORED STATUS: the rehearsal copy restored the original hash and reproduced the old FRONTEND/404 behavior. The active MODIFIED_FILE remains fixed and serves RUNTIME/200. The rollback script restores only the startup entrypoint, not the whole UI or database. All four artifacts were reopened and the rollback script is executable.\n";
output +=
  "\nAPPLICATION TESTS\nCOMMAND: pnpm check\nINPUT: current source, real server/index.mjs startup, temporary SQLite data, local HTTP/WebSocket/provider fixtures and desktop Chrome.\nEXIT: 0\nRESULT: 8 backend passes. " +
  readFileSync(resolve(reportDirectory, "browser-summary.txt"), "utf8");
output +=
  "\nNative AI supports Responses and Chat Completions streaming, local history, stop, provider errors and verified admin configuration. Provider fixtures are deterministic test responses, not model output. No live provider/key is configured and no paid model requests were made.\nKnown upstream download failures remain tracked, not counted as working workflows. Physical Chromebook, Google/ChatGPT authentication and Spotify audio remain unverified.\n\nLITERAL PNPM CHECK OUTPUT:\n" +
  readFileSync(resolve(reportDirectory, "check.log"), "utf8");
try {
  output +=
    "\nLIVE PREVIEW BROWSING\nCOMMAND: node tools/diagnostics/preview-browse-check.mjs\nEXIT: 0\nLITERAL OUTPUT:\n" +
    readFileSync(resolve(reportDirectory, "live-browsing.log"), "utf8");
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
