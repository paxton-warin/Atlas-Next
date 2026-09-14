import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(t, options = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "atlas-service-update-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  const script = join(root, "scripts/update-running-service.sh");
  copyFileSync(
    new URL("../scripts/update-running-service.sh", import.meta.url),
    script,
  );
  const project = options.project || "atlas-node";
  const service = project === "atlas-main" ? "app" : "node";
  const configFiles = options.configFiles || [
    "compose.node.yaml",
    "compose.dispenser.yaml",
    "custom overrides.yml",
  ];
  const envFiles = options.envFiles || [];
  const originals = new Map();
  for (const name of [...configFiles, ...envFiles, "Caddyfile.node", ".env"]) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    const body = `keep ${name}; PRIVATE_CONFIG_VALUE\n`;
    writeFileSync(file, body);
    originals.set(file, body);
  }
  const labelConfigFiles = options.relative
    ? configFiles
    : configFiles.map((name) => join(root, name));
  const labelEnvFiles = options.relative
    ? envFiles
    : envFiles.map((name) => join(root, name));
  const stateFile = join(root, "docker-state.json");
  const labels = {
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.project.working_dir": root,
    "com.docker.compose.project.config_files": labelConfigFiles.join(","),
    "com.docker.compose.project.environment_file": labelEnvFiles.join(","),
    ...options.labels,
  };
  if (options.missingFile) rmSync(join(root, options.missingFile));
  writeFileSync(
    stateFile,
    JSON.stringify({
      labels,
      calls: [],
      matches: ["fixture-container"],
      running: true,
      ...options.state,
    }),
  );
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = process.env.ATLAS_UPDATE_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.calls.push(args);
fs.writeFileSync(file, JSON.stringify(state));
let output = "";
if (args[0] === "ps") output = state.matches.join("\\n");
else if (args[0] === "inspect") {
  const format = args[2];
  const label = /index \\.Config.Labels "([^"]+)"/.exec(format);
  if (label) output = state.labels[label[1]] ?? "<no value>";
  else if (format === "{{.State.Running}}") output = String(state.running);
  else if (format === "{{.Image}}") output = "sha256:" + "a".repeat(64);
  else process.exit(91);
} else if (args[0] === "tag") {
  if (state.failTag) process.exit(9);
} else if (args[0] === "compose") {
  const command = args.find((arg) => ["config", "build", "up", "ps", "logs"].includes(arg));
  if (state.failCommand === command) process.exit(10);
  if (command === "ps") output = "fixture service running";
  if (command === "logs") output = "fixture service logs";
  if (!command) process.exit(92);
} else process.exit(93);
if (output) process.stdout.write(output + "\\n");
`,
    { mode: 0o755 },
  );
  return {
    root,
    labels,
    project,
    service,
    originals,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    run: (args = [project, service], cwd = root) =>
      spawnSync("bash", [script, ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ATLAS_UPDATE_FIXTURE: stateFile,
        },
      }),
  };
}

const composeCalls = (f) =>
  f.state().calls.filter((args) => args[0] === "compose");
const did = (f, command) =>
  composeCalls(f).some((args) => args.includes(command));

for (const project of ["atlas-node", "atlas-main"]) {
  test(`updater preserves ${project}'s full file stack and files, tags first, recreates only its application`, (t) => {
    const f = fixture(t, { project, envFiles: [".env.live", "overrides.env"] });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const prefix = ["compose", "--project-directory", f.root, "-p", project];
    for (const file of f.labels[
      "com.docker.compose.project.config_files"
    ].split(","))
      prefix.push("-f", file);
    for (const file of f.labels[
      "com.docker.compose.project.environment_file"
    ].split(","))
      prefix.push("--env-file", file);
    assert.deepEqual(composeCalls(f), [
      [...prefix, "config", "--quiet"],
      [...prefix, "build", f.service],
      [
        ...prefix,
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "120",
        f.service,
      ],
      [...prefix, "ps", f.service],
      [...prefix, "logs", "--tail=50", f.service],
    ]);
    const calls = f.state().calls;
    assert.deepEqual(calls[0], [
      "ps",
      "--filter",
      "status=running",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${f.service}`,
      "--format",
      "{{.ID}}",
    ]);
    const tag = calls.findIndex((args) => args[0] === "tag");
    assert.ok(tag > calls.findIndex((args) => args.includes("config")));
    assert.ok(tag < calls.findIndex((args) => args.includes("build")));
    assert.match(
      calls[tag][2],
      new RegExp(
        `^${project}-${f.service}:before-update-[0-9]{8}T[0-9]{6}Z-[0-9]+$`,
      ),
    );
    assert.ok(result.stdout.includes(`ROLLBACK_IMAGE=${calls[tag][2]}`));
    assert.ok(!result.stdout.includes("PRIVATE_CONFIG_VALUE"));
    assert.ok(
      !calls.some(
        (args) =>
          args.includes("edge") ||
          args.includes("down") ||
          args.includes("network"),
      ),
    );
    for (const [file, body] of f.originals)
      assert.equal(readFileSync(file, "utf8"), body);
  });
}

test("updater resolves relative recorded files and accepts absent optional env-file metadata", (t) => {
  const f = fixture(t, {
    relative: true,
    labels: { "com.docker.compose.project.environment_file": undefined },
  });
  assert.equal(f.run().status, 0);
  const config = composeCalls(f)[0];
  assert.ok(config.includes(join(f.root, "compose.dispenser.yaml")));
  assert.ok(!config.includes("--env-file"));
});

test("updater uses a distinct rollback tag for each invocation", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  const tags = f
    .state()
    .calls.filter((args) => args[0] === "tag")
    .map((args) => args[2]);
  assert.equal(new Set(tags).size, 2);
});

for (const args of [
  ["atlas-main", "node"],
  ["atlas-node", "edge"],
  ["atlas-link-dispenser", "app"],
  [],
  ["atlas-node", "node", "extra"],
]) {
  test(`updater rejects unsupported arguments ${JSON.stringify(args)} before Docker`, (t) => {
    const f = fixture(t);
    assert.equal(f.run(args).status, 1);
    assert.equal(f.state().calls.length, 0);
  });
}

for (const matches of [[], ["first", "second"]]) {
  test(`updater rejects ${matches.length} matching running containers before mutation`, (t) => {
    const f = fixture(t, { state: { matches } });
    assert.equal(f.run().status, 1);
    assert.equal(f.state().calls.length, 1);
  });
}

for (const [name, options] of [
  [
    "wrong project",
    { labels: { "com.docker.compose.project": "atlas-link-dispenser" } },
  ],
  ["wrong service", { labels: { "com.docker.compose.service": "edge" } }],
  ["stopped container", { state: { running: false } }],
  [
    "absent working directory",
    { labels: { "com.docker.compose.project.working_dir": "" } },
  ],
  [
    "different working directory",
    { labels: { "com.docker.compose.project.working_dir": tmpdir() } },
  ],
  [
    "absent file metadata",
    { labels: { "com.docker.compose.project.config_files": undefined } },
  ],
  [
    "empty file metadata",
    { labels: { "com.docker.compose.project.config_files": "" } },
  ],
  [
    "malformed file metadata",
    {
      labels: {
        "com.docker.compose.project.config_files": "compose.node.yaml,",
      },
    },
  ],
  ["missing override", { missingFile: "compose.dispenser.yaml" }],
  [
    "missing environment file",
    { envFiles: [".env.live"], missingFile: ".env.live" },
  ],
]) {
  test(`updater stops on ${name} before Compose or image tagging`, (t) => {
    const f = fixture(t, options);
    assert.equal(f.run().status, 1);
    assert.equal(composeCalls(f).length, 0);
    assert.ok(!f.state().calls.some((args) => args[0] === "tag"));
  });
}

test("updater requires running from the same uploaded checkout", (t) => {
  const f = fixture(t);
  assert.equal(f.run(undefined, tmpdir()).status, 1);
  assert.equal(f.state().calls.length, 0);
});

for (const command of ["config", "build", "up"]) {
  test(`updater stops after ${command} failure without later operations`, (t) => {
    const f = fixture(t, { state: { failCommand: command } });
    const result = f.run();
    assert.equal(result.status, 10);
    assert.ok(did(f, command));
    if (command === "config") {
      assert.ok(!did(f, "build"));
      assert.ok(!f.state().calls.some((args) => args[0] === "tag"));
    }
    if (command !== "up") assert.ok(!did(f, "up"));
    assert.ok(!did(f, "logs"));
    assert.ok(!result.stdout.includes("UPDATE_RECREATED="));
  });
}

test("updater requires successful image retention before building", (t) => {
  const f = fixture(t, { state: { failTag: true } });
  assert.equal(f.run().status, 9);
  assert.ok(!did(f, "build"));
  assert.ok(!did(f, "up"));
});
