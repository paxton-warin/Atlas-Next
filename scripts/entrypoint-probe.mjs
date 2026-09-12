// Boots a selected startup file against the real server modules in a disposable copy.
import {
  mkdtempSync,
  cpSync,
  symlinkSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const file = process.argv[2];
if (!file) throw Error("Provide an entrypoint file.");
const root = resolve("."),
  dir = mkdtempSync(join(tmpdir(), "atlas-entrypoint-"));
cpSync("server", join(dir, "server"), { recursive: true });
cpSync(file, join(dir, "server/index.mjs"));
symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
symlinkSync(join(root, "dist"), join(dir, "dist"), "dir");
cpSync("package.json", join(dir, "package.json"));
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: dir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "4280",
    RUNTIME_PORT: "4281",
    APP_ORIGIN: "http://localhost:4280",
    RUNTIME_ORIGIN: "http://127.0.0.1:4281",
    DATA_DIR: join(dir, "data"),
    NODE_ENV: "test",
    ATLAS_TEST_FIXTURE: "0",
  },
  stdio: "ignore",
});
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("Entrypoint exited early.");
    try {
      if ((await fetch("http://localhost:4280/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) throw Error("Startup timeout");
  const response = await fetch("http://127.0.0.1:4281/");
  const html = await response.text();
  const controller = await fetch(
    "http://127.0.0.1:4281/controller/controller.api.js",
  );
  console.log(
    `RUNTIME_DOCUMENT=${html.includes('id="frames"') ? "RUNTIME" : html.includes('id="root"') ? "FRONTEND" : "UNKNOWN"}; CONTROLLER_HTTP=${controller.status}`,
  );
} finally {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  rmSync(dir, { recursive: true, force: true });
}
