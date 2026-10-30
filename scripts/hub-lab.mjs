#!/usr/bin/env node
/** Private local-only combined Hub laboratory. Never reads project .env files. */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hub = resolve(root, "../Atlas-Link-Dispenser");
export const ports = {
  hub: 4300,
  hubInternal: 4301,
  atlas: 4280,
  runtime: 4281,
  nodes: [4282, 4283, 4284],
  atlasInternal: 4286,
  runtimeInternal: 4287,
  nodeInternal: [4288, 4289, 4290],
  fixture: 4299,
};
export function validateLabDatabase(value) {
  const u = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/atlas_hub_lab_test" ||
    u.search ||
    u.hash
  )
    throw Error(
      "Lab database must be localhost /atlas_hub_lab_test with no options.",
    );
  return u;
}
export function validateLabRedis(value) {
  const u = new URL(value);
  if (
    u.protocol !== "redis:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/14" ||
    u.search ||
    u.hash
  )
    throw Error("Lab Redis must be localhost database 14.");
  return u;
}
export function cleanEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    ...extra,
    NODE_ENV: "test",
  };
}
const token = () => randomBytes(32).toString("base64url");
const stateDir = join(tmpdir(), `atlas-hub-lab-${userInfo().uid}`);
const stateFile = join(stateDir, "state.json");
const save = (s) => {
  writeFileSync(stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(stateFile, 0o600);
};
function requireHub() {
  return createRequire(join(hub, "apps/server/package.json"));
}
function poolFor(url) {
  const { Pool } = requireHub()("pg");
  return new Pool({ connectionString: url });
}
const baseUrl = () =>
  process.env.ATLAS_LAB_DATABASE_URL ||
  `postgres://${encodeURIComponent(userInfo().username)}@localhost:5432/atlas_hub_lab_test`;
async function freePort(port) {
  await new Promise((ok, bad) => {
    const server = createServer();
    server.once("error", () =>
      bad(
        Error(
          `Local port ${port} is occupied; stop the conflicting lab before starting.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(ok));
  });
}
async function database(s) {
  const target = validateLabDatabase(s.databaseUrl);
  const maintenance = new URL(target);
  maintenance.pathname = "/postgres";
  const db = poolFor(maintenance.href);
  try {
    if (
      !(
        await db.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          "atlas_hub_lab_test",
        ])
      ).rowCount
    )
      await db.query("CREATE DATABASE atlas_hub_lab_test");
  } finally {
    await db.end();
  }
  const p = poolFor(target.href);
  try {
    const tables = (
      await p.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")
    ).rows.map((r) => r.tablename);
    if (tables.length && !tables.includes("atlas_lab_identity"))
      throw Error(
        "Existing lab database lacks its lab identity marker; refusing to modify it.",
      );
    await p.query(
      "CREATE TABLE IF NOT EXISTS atlas_lab_identity(id text PRIMARY KEY)",
    );
    const marker = (await p.query("SELECT id FROM atlas_lab_identity")).rows[0];
    if (marker && marker.id !== s.id)
      throw Error("Lab identity does not match private state.");
    if (!marker)
      await p.query("INSERT INTO atlas_lab_identity(id) VALUES($1)", [s.id]);
    await p.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (
      await readdir(join(hub, "packages/database/migrations"))
    )
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (await p.query("SELECT 1 FROM schema_migrations WHERE id=$1", [name]))
          .rowCount
      )
        continue;
      await p.query("BEGIN");
      try {
        await p.query(
          await readFile(
            join(hub, "packages/database/migrations", name),
            "utf8",
          ),
        );
        await p.query("INSERT INTO schema_migrations(id) VALUES($1)", [name]);
        await p.query("COMMIT");
      } catch (e) {
        await p.query("ROLLBACK");
        throw e;
      }
    }
    await p.query(
      "INSERT INTO users(id,email,normalized_email,verified_at) VALUES($1,'student@atlas-lab.example','student@atlas-lab.example',now()) ON CONFLICT(normalized_email) DO NOTHING",
      [s.userId],
    );
    await p.query(
      "INSERT INTO links(id,name,url,health_status,health_monitoring) VALUES($1,'Atlas Lab','https://localhost:4280','healthy',false) ON CONFLICT(id) DO NOTHING",
      [s.linkId],
    );
    await p.query(
      "INSERT INTO hub_branches(id,link_id,origin,secret_hash) VALUES($1,$2,'https://localhost:4280',$3) ON CONFLICT(id) DO NOTHING",
      [
        s.branchId,
        s.linkId,
        require("node:crypto")
          .createHmac("sha256", s.sessionSecret)
          .update(s.branchSecret)
          .digest("hex"),
      ],
    );
    await p.query(
      "INSERT INTO link_assignments(user_id,link_id) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=$2)",
      [s.userId, s.linkId],
    );
    for (const [label, id] of [
      ["Old local fixture", "111111111111"],
      ["New local fixture", "222222222222"],
    ])
      await p.query(
        "INSERT INTO hub_cloud_accounts(label,expected_account_id,verified_account_id,status) SELECT $1,$2,$2,'connected' WHERE NOT EXISTS(SELECT 1 FROM hub_cloud_accounts WHERE expected_account_id=$2)",
        [label, id],
      );
    const oldCloudAccount = (
      await p.query(
        "SELECT id FROM hub_cloud_accounts WHERE expected_account_id='111111111111' ORDER BY created_at LIMIT 1",
      )
    ).rows[0].id;
    for (const entry of [
      {
        id: "LABFRONT",
        role: "frontend",
        logicalId: s.linkId,
        linkId: s.linkId,
        url: "https://localhost:4280",
        originHost: "atlas.lab.example",
      },
      {
        id: "LABHUB",
        role: "hub",
        logicalId: "hub",
        linkId: null,
        url: "https://localhost:4300",
        originHost: "hub.lab.example",
      },
      ...[2, 3, 4].map((n) => ({
        id: "LABNODE" + n,
        role: "node",
        logicalId: "node" + n,
        linkId: null,
        url: "https://127.0.0.1:" + String(4280 + n),
        originHost: "node" + n + ".lab.example",
      })),
    ]) {
      await p.query(
        "INSERT INTO hub_cloud_endpoints(role,logical_id,link_id,account_id,distribution_id,url,origin_host,state) VALUES($1,$2,$3,$4,$5,$6,$7,'active') ON CONFLICT(account_id,distribution_id) DO NOTHING",
        [
          entry.role,
          entry.logicalId,
          entry.linkId,
          oldCloudAccount,
          entry.id,
          entry.url,
          entry.originHost,
        ],
      );
      await p.query(
        "INSERT INTO hub_cloud_simulator_resources(account_id,id,resource) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          oldCloudAccount,
          entry.id,
          JSON.stringify({
            id: entry.id,
            domain: new URL(entry.url).host,
            status: "Deployed",
            caller: "local-existing-" + entry.id,
            originHost: entry.originHost,
          }),
        ],
      );
    }
    await p.query(
      "UPDATE app_settings SET value='{\"enabled\":false}' WHERE key='health'",
    );
    await p.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{rateLimitPerHour}','1000') WHERE key='registration'",
    );
    await p.query(
      "UPDATE app_settings SET value=jsonb_set(value,'{resendCooldownSeconds}','0') WHERE key='verification'",
    );
  } finally {
    await p.end();
  }
}
function launch(s, label, file, env, tsx = false) {
  const log = join(stateDir, `${label}.log`);
  const fs = createRequire(import.meta.url)("node:fs");
  const fd = fs.openSync(log, "a", 0o600);
  const args = [
    "--import",
    join(root, "scripts/hub-lab-dns.mjs"),
    ...(tsx ? [join(hub, "apps/server/node_modules/tsx/dist/cli.mjs")] : []),
    file,
    `--lab-state=${stateFile}`,
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: cleanEnvironment({
      ...env,
      ATLAS_LAB_STATE: stateFile,
      NODE_EXTRA_CA_CERTS: join(stateDir, "cert.pem"),
    }),
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  fs.closeSync(fd);
  child.unref();
  s.processes.push({ label, pid: child.pid });
  save(s);
}
async function ready(port, path = "/health/live") {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(
    `Lab did not become ready on internal port ${port}. Inspect ${stateDir}/*.log.`,
  );
}
async function stop(s) {
  for (const item of [...s.processes].reverse()) {
    try {
      const command = execFileSync(
        "ps",
        ["-p", String(item.pid), "-o", "command="],
        { encoding: "utf8" },
      );
      if (!command.includes(`--lab-state=${stateFile}`)) continue;
      process.kill(-item.pid, "SIGTERM");
    } catch {}
  }
  s.processes = [];
  save(s);
  await new Promise((r) => setTimeout(r, 600));
}
export function validateLabPublicOrigin(value, port) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    Number(url.port) !== port ||
    !(
      url.hostname === "localhost" ||
      /^[a-z0-9-]+\.atlas\.localhost$/.test(url.hostname)
    )
  )
    throw Error("Expected a local laboratory endpoint.");
  return value;
}
async function currentAddresses(state) {
  const defaults = {
    hub: "https://localhost:4300",
    atlas: "https://localhost:4280",
  };
  validateLabDatabase(state.databaseUrl);
  const pool = poolFor(state.databaseUrl);
  try {
    const marker = (await pool.query("SELECT id FROM atlas_lab_identity"))
      .rows[0];
    if (marker?.id !== state.id)
      throw Error("Lab identity does not match private state.");
    const hub =
      (
        await pool.query(
          "SELECT value FROM app_settings WHERE key='hub_current_origin'",
        )
      ).rows[0]?.value || defaults.hub;
    const atlas =
      (await pool.query("SELECT url FROM links WHERE id=$1", [state.linkId]))
        .rows[0]?.url || defaults.atlas;
    return {
      hub: validateLabPublicOrigin(hub, 4300),
      atlas: validateLabPublicOrigin(atlas, 4280),
    };
  } finally {
    await pool.end();
  }
}
export function validateLabRuntime(value = "opaque-v2") {
  if (!["opaque-v2", "same-origin-profile"].includes(value))
    throw Error("Lab runtime must be opaque-v2 or same-origin-profile.");
  return value;
}
async function run(command, skipBuild = false, requestedRuntime) {
  if (process.env.NODE_ENV === "production")
    throw Error("The lab refuses a production invocation.");
  if (command === "status") {
    if (!existsSync(stateFile)) {
      console.log("Local lab has not been initialized.");
      return;
    }
    const s = JSON.parse(readFileSync(stateFile));
    console.log(
      JSON.stringify(
        {
          directory: stateDir,
          ...(await currentAddresses(s)),
          user: "student@atlas-lab.example",
          admin: "admin@atlas-lab.example",
          processes: s.processes,
          localRuntime: s.browserRuntime || "opaque-v2",
          simulation: "AWS simulator with local endpoint activation",
          production: "Not deployed; real AWS rehearsal remains deferred",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "stop" || command === "reset") {
    if (!existsSync(stateFile)) return;
    const s = JSON.parse(readFileSync(stateFile));
    validateLabDatabase(s.databaseUrl);
    await stop(s);
    if (command === "reset") {
      const target = new URL(s.databaseUrl);
      const p = poolFor(target.href);
      try {
        const marker = (await p.query("SELECT id FROM atlas_lab_identity"))
          .rows[0];
        if (marker?.id !== s.id)
          throw Error("Lab marker mismatch; database retained.");
      } finally {
        await p.end();
      }
      target.pathname = "/postgres";
      const m = poolFor(target.href);
      try {
        await m.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='atlas_hub_lab_test' AND pid<>pg_backend_pid()",
        );
        await m.query("DROP DATABASE atlas_hub_lab_test");
      } finally {
        await m.end();
      }
      rmSync(stateDir, { recursive: true, force: true });
      console.log(
        "Only the marked local lab database and private lab files were removed.",
      );
    }
    return;
  }
  if (command !== "start")
    throw Error(
      "Usage: node scripts/hub-lab.mjs start [--skip-build] | status | stop | reset",
    );
  const browserRuntime = validateLabRuntime(requestedRuntime);
  const databaseUrl = validateLabDatabase(baseUrl()).href;
  const redisUrl = validateLabRedis(
    process.env.ATLAS_LAB_REDIS_URL || "redis://localhost:56379/14",
  ).href;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  let s = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile))
    : {
        id: randomUUID(),
        processes: [],
        userId: randomUUID(),
        linkId: randomUUID(),
        branchId: randomUUID(),
        branchSecret: token(),
        sessionSecret: token(),
        encryptionKey: token(),
        serviceSecret: token(),
        bootstrapToken: token(),
        databaseUrl,
        redisUrl,
      };
  if (s.databaseUrl !== databaseUrl || s.redisUrl !== redisUrl)
    throw Error(
      "Lab connection settings changed; stop/reset the existing lab explicitly first.",
    );
  await stop(s);
  s.browserRuntime = browserRuntime;
  for (const port of Object.values(ports).flat()) await freePort(port);
  const Redis = requireHub()("ioredis");
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
  } finally {
    redis.disconnect();
  }
  if (!skipBuild) {
    execFileSync("pnpm", ["build"], {
      cwd: hub,
      env: cleanEnvironment(),
      stdio: "inherit",
    });
    execFileSync("pnpm", ["build"], {
      cwd: root,
      env: cleanEnvironment(),
      stdio: "inherit",
    });
  }
  if (
    !existsSync(join(stateDir, "cert.pem")) ||
    !execFileSync(
      "openssl",
      [
        "x509",
        "-in",
        join(stateDir, "cert.pem"),
        "-noout",
        "-ext",
        "subjectAltName",
      ],
      { encoding: "utf8" },
    ).includes("DNS:*.atlas.localhost")
  )
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-days",
        "7",
        "-subj",
        "/CN=Atlas Hub local laboratory",
        "-addext",
        "subjectAltName=DNS:localhost,DNS:*.atlas.localhost,IP:127.0.0.1",
        "-keyout",
        join(stateDir, "key.pem"),
        "-out",
        join(stateDir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
  chmodSync(join(stateDir, "key.pem"), 0o600);
  save(s);
  await database(s);
  const hubEnv = {
    APP_URL: "https://localhost:4300",
    PORT: "4301",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_SECRET: s.sessionSecret,
    DATA_ENCRYPTION_KEY: s.encryptionKey,
    BOOTSTRAP_ADMIN_EMAIL: "admin@atlas-lab.example",
    BOOTSTRAP_TOKEN: s.bootstrapToken,
    ATLAS_HUB_ENABLED: "true",
    ATLAS_HUB_SERVICE_SECRET: s.serviceSecret,
    ATLAS_COORDINATOR_ORIGIN: "https://localhost:4280",
    HUB_CLOUD_FAKE: "1",
    HUB_CLOUD_SIMULATION_AUTO_ACTIVATE: "1",
    LOG_LEVEL: "warn",
  };
  try {
    launch(s, "hub", join(root, "scripts/hub-lab-hub.mjs"), hubEnv, true);
    await ready(4301);
    launch(
      s,
      "cloud-worker",
      join(hub, "apps/server/src/hubCloudWorkerMain.ts"),
      hubEnv,
      true,
    );
    launch(s, "atlas", join(root, "scripts/hub-lab-atlas.mjs"), {
      APP_ORIGIN: "https://localhost:4280",
      RUNTIME_ORIGIN: "https://127.0.0.1:4281",
      ATLAS_HUB_ORIGIN: "https://localhost:4300",
      ATLAS_HUB_BRANCH_ID: s.branchId,
      ATLAS_HUB_BRANCH_SECRET: s.branchSecret,
      ATLAS_HUB_UI_ONLY_LAB: "false",
      LOCAL_RELAY_MODE: "frontend",
      ATLAS_BROWSER_RUNTIME: browserRuntime,
      OPAQUE_ASSETS_DIR: join(root, "dist/opaque-runtime"),
      ATLAS_HUB_SERVICE_SECRET: s.serviceSecret,
      TRUST_PROXY: "127.0.0.1/32,::1/128",
      DATA_DIR: join(stateDir, "atlas"),
      ATLAS_TEST_FIXTURE: "1",
      ATLAS_TEST_FIXTURE_PORT: "4299",
    });
    await ready(4286, "/health");
    launch(s, "https", join(root, "scripts/hub-lab-proxy.mjs"), {});
    await new Promise((r) => setTimeout(r, 700));
    const addresses = await currentAddresses(s);
    console.log(
      `Local lab ready.\nHub: ${addresses.hub}\nAtlas local browser: ${addresses.atlas}\nFixtures: http://fixture.localhost:4299\nSign in normally as student@atlas-lab.example or admin@atlas-lab.example; open the local verification file to get the code.\nThe certificate is local/self-signed; trust only this lab certificate for browser testing.\nLocal ${browserRuntime} runtime and simulated endpoint activation are enabled. Real AWS and production remain deferred.\nPrivate state/logs: ${stateDir}`,
    );
  } catch (e) {
    await stop(s);
    throw e;
  }
}
// createRequire is intentionally used for sibling workspace dependencies only.
const require = createRequire(import.meta.url);
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  run(process.argv[2] || "start", process.argv.includes("--skip-build"), process.argv.find((arg) => arg.startsWith("--runtime="))?.slice(10)).catch(
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
