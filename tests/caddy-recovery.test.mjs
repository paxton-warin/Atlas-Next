import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(
  new URL("../scripts/restore-vps2-caddy.sh", import.meta.url),
);
const site = "atlas-dispenser-vps-b.internals.paxton.co";
const original = `{$ORIGIN_HOST} {
  @unauthorized not header X-Atlas-Origin-Key {$ORIGIN_KEY}
  respond @unauthorized 403
  reverse_proxy node:4183
}

existing.fixture.test {
  respond "existing site retained"
}
`;

function fixture(t, options = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "atlas-caddy-recovery-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "Caddyfile.node");
  const stateFile = join(root, "docker-state.json");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(config, original);
  writeFileSync(
    stateFile,
    JSON.stringify({
      config,
      appNetworks: ["atlas-link-dispenser_default"],
      edgeNetworks: ["atlas-node_atlas-node"],
      calls: [],
      reloads: 0,
      ...options,
    }),
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.MOCK_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
let code = 0;
let output = "";
let raw = false;
let signal;
if (args[0] === "inspect") {
  const format = args[2], container = args[3];
  if (format.includes(".State.Running")) output = "true";
  else if (format.includes(".Mounts")) output = state.config;
  else if (format.includes(".NetworkSettings.Networks")) output = (container === "atlas-node-edge-1" ? state.edgeNetworks : state.appNetworks).join("\\n");
  else code = 90;
} else if (args[0] === "network") {
  if (args[1] === "inspect") output = "[]";
  else if (args[1] === "connect") state.edgeNetworks.push(args[2]);
  else if (args[1] === "disconnect") state.edgeNetworks = state.edgeNetworks.filter(n => n !== args[2]);
  else code = 91;
} else if (args[0] === "exec") {
  const command = args.slice(args[1] === "-i" ? 3 : 2);
  if (command[0] === "sh") state.candidate = fs.readFileSync(0, "utf8");
  else if (command[0] === "cat") {
    output = state.staleMount ? "stale mount bytes" : fs.readFileSync(state.config, "utf8");
    raw = true;
  }
  else if (command[0] === "caddy" && command[1] === "validate") {
    if (!state.candidate?.includes("reverse_proxy atlas-link-dispenser-app-1:3000")) code = 92;
    else if (state.failValidate) code = 1;
  } else if (command[0] === "caddy" && command[1] === "reload") {
    state.reloads++;
    (state.reloadContents ||= []).push(fs.readFileSync(state.config, "utf8"));
    if (state.failReload && state.reloads === 1) code = 1;
    if (state.signalReload && state.reloads === 1) signal = state.signalReload;
  } else if (command[0] === "wget") {
    if (state.failReady) code = 1;
  } else if (command[0] !== "rm") code = 93;
} else code = 94;
fs.writeFileSync(file, JSON.stringify(state));
if (output) process.stdout.write(output + (raw ? "" : "\\n"));
if (code) process.stderr.write("mock docker failure " + code + "\\n");
if (signal) process.kill(process.ppid, signal);
process.exit(code);
`,
    { mode: 0o755 },
  );
  return {
    root,
    config,
    override: join(root, "compose.dispenser.yaml"),
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    run: () =>
      spawnSync("bash", [script, config], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOCK_DOCKER_STATE: stateFile,
        },
      }),
  };
}

test("recovery appends the dispenser route and retains existing routes and the bind-mounted inode", (t) => {
  const f = fixture(t);
  const inode = statSync(f.config).ino;
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(f.config, "utf8");
  assert.ok(config.startsWith(original));
  assert.ok(
    config.includes(
      `${site} {\n  reverse_proxy atlas-link-dispenser-app-1:3000\n}`,
    ),
  );
  assert.equal(statSync(f.config).ino, inode);
  assert.match(result.stdout, /CADDY=RELOADED; DISPENSER_UPSTREAM=READY/);
  assert.match(
    result.stdout,
    /-f compose\.node\.yaml -f compose\.dispenser\.yaml/,
  );
  const state = f.state();
  const callIndex = (needle) =>
    state.calls.findIndex((args) => args.join(" ").includes(needle));
  assert.ok(callIndex("caddy validate") < callIndex("network connect"));
  assert.ok(callIndex("network connect") < callIndex("caddy reload"));
  assert.ok(
    state.calls.some(
      (args) =>
        args.at(-1) === "http://atlas-link-dispenser-app-1:3000/health/ready",
    ),
  );
  assert.ok(
    !state.calls.some((args) =>
      ["restart", "compose", "stop", "start"].includes(args[0]),
    ),
  );
  assert.match(
    readFileSync(f.override, "utf8"),
    /external: true\n    name: "atlas-link-dispenser_default"/,
  );
  const backupDir = join(
    f.root,
    "backups",
    readdirSync(join(f.root, "backups"))[0],
  );
  assert.equal(
    readFileSync(join(backupDir, "Caddyfile.node"), "utf8"),
    original,
  );
  assert.equal(statSync(join(f.root, "backups")).mode & 0o777, 0o700);
  if (process.env.ATLAS_RECOVERY_EVIDENCE) {
    mkdirSync(dirname(process.env.ATLAS_RECOVERY_EVIDENCE), {
      recursive: true,
    });
    writeFileSync(process.env.ATLAS_RECOVERY_EVIDENCE, config);
  }
});

test("an existing dispenser hostname is a review-only no-op without Docker changes", (t) => {
  const f = fixture(t);
  const config = `${original}\n${site} { reverse_proxy custom-service:3000 }\n`;
  writeFileSync(f.config, config);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EXISTING_SITE=REVIEW_REQUIRED/);
  assert.equal(readFileSync(f.config, "utf8"), config);
  assert.equal(f.state().calls.length, 0);
  assert.ok(!existsSync(f.override));
});

test("candidate validation failure leaves the original file and networks untouched", (t) => {
  const f = fixture(t, { failValidate: true });
  const inode = statSync(f.config).ino;
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Candidate validation failed/);
  assert.equal(readFileSync(f.config, "utf8"), original);
  assert.equal(statSync(f.config).ino, inode);
  assert.equal(f.state().reloads, 0);
  assert.ok(
    !f
      .state()
      .calls.some((args) => args[0] === "network" && args[1] === "connect"),
  );
  assert.ok(!existsSync(f.override));
});

for (const failure of ["failReload", "failReady"]) {
  test(`${failure} restores original bytes, reloads Caddy, and removes only the newly attached network`, (t) => {
    const f = fixture(t, { [failure]: true });
    const inode = statSync(f.config).ino;
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ROLLBACK=CADDY_RESTORED/);
    assert.match(result.stderr, /ROLLBACK=NEW_NETWORK_DETACHED/);
    assert.equal(readFileSync(f.config, "utf8"), original);
    assert.equal(statSync(f.config).ino, inode);
    assert.equal(f.state().reloads, 2);
    assert.equal(f.state().reloadContents.at(-1), original);
    assert.deepEqual(f.state().edgeNetworks, ["atlas-node_atlas-node"]);
    assert.ok(!existsSync(f.override));
  });
}

test("existing shared network and custom Compose override are preserved", (t) => {
  const f = fixture(t, {
    edgeNetworks: ["atlas-node_atlas-node", "atlas-link-dispenser_default"],
  });
  const custom = "# existing custom override must not be replaced\n";
  writeFileSync(f.override, custom);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OVERRIDE=PRESERVED/);
  assert.equal(readFileSync(f.override, "utf8"), custom);
  assert.ok(
    !f
      .state()
      .calls.some(
        (args) =>
          args[0] === "network" && ["connect", "disconnect"].includes(args[1]),
      ),
  );
});

test("rollback does not disconnect a network which was already shared", (t) => {
  const f = fixture(t, {
    failReady: true,
    edgeNetworks: ["atlas-node_atlas-node", "atlas-link-dispenser_default"],
  });
  assert.equal(f.run().status, 1);
  assert.ok(
    !f
      .state()
      .calls.some((args) => args[0] === "network" && args[1] === "disconnect"),
  );
  assert.deepEqual(f.state().edgeNetworks, [
    "atlas-node_atlas-node",
    "atlas-link-dispenser_default",
  ]);
});

test("ambiguous non-shared dispenser networks stop before any configuration change", (t) => {
  const f = fixture(t, { appNetworks: ["dispenser-one", "dispenser-two"] });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Expected one eligible dispenser network; found 2/,
  );
  assert.equal(readFileSync(f.config, "utf8"), original);
  assert.ok(!existsSync(join(f.root, "backups")));
});

test("one existing shared network is preferred when dispenser has multiple networks", (t) => {
  const f = fixture(t, {
    appNetworks: ["dispenser-private", "dispenser-shared"],
    edgeNetworks: ["atlas-node_atlas-node", "dispenser-shared"],
  });
  assert.equal(f.run().status, 0);
  assert.match(readFileSync(f.override, "utf8"), /name: "dispenser-shared"/);
});

test("a stale bind mount fails before claiming that the new route was reloaded", (t) => {
  const f = fixture(t, { staleMount: true });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale Caddy bind mount/);
  assert.match(result.stderr, /ROLLBACK=CADDY_RESTORED/);
  assert.equal(readFileSync(f.config, "utf8"), original);
  assert.deepEqual(f.state().edgeNetworks, ["atlas-node_atlas-node"]);
  assert.equal(f.state().reloads, 1);
  assert.equal(f.state().reloadContents[0], original);
});

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`${signal} during reload triggers restoration and network cleanup`, (t) => {
    const f = fixture(t, { signalReload: signal });
    const result = f.run();
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stderr, /ROLLBACK=CADDY_RESTORED/);
    assert.match(result.stderr, /ROLLBACK=NEW_NETWORK_DETACHED/);
    assert.equal(readFileSync(f.config, "utf8"), original);
    assert.deepEqual(f.state().edgeNetworks, ["atlas-node_atlas-node"]);
    assert.equal(f.state().reloads, 2);
  });
}
