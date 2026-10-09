import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
let source;
try {
  source = readFileSync(
    new URL("../scripts/apply-cloudfront-retarget.sh", import.meta.url),
    "utf8",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const cid = "abc123def456";
function fixture(t, overrides = {}) {
  assert.ok(source, "offline retarget wrapper exists");
  const root = mkdtempSync(join(tmpdir(), "atlas-retarget-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "cloudfront-retarget"),
    bin = join(root, "bin"),
    log = join(root, "docker.log"),
    state = join(root, "state");
  mkdirSync(scripts);
  mkdirSync(bin);
  writeFileSync(join(scripts, "apply-cloudfront-retarget.sh"), source);
  writeFileSync(
    join(scripts, "retarget-cloudfront.mjs"),
    "// Mounted helper fixture\n",
  );
  const plan = join(root, "plan.json");
  writeFileSync(plan, "{}");
  writeFileSync(state, "true");
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2),e=process.env;fs.appendFileSync(e.DOCKER_LOG,JSON.stringify(a)+'\\n');
const value=()=>fs.readFileSync(e.DOCKER_STATE,'utf8');
if(a[0]==='ps'){console.log(e.MOCK_MATCHES??'${cid}');}
else if(a[0]==='inspect'){const f=a[a.indexOf('--format')+1];if(f.includes('.Image'))console.log('sha256:'+ '1'.repeat(64));else if(f.includes('.State.Running'))console.log(value());else if(f.includes('compose.project'))console.log(e.MOCK_MODE==='main'?'atlas-main':'atlas-node');else if(f.includes('compose.service'))console.log(e.MOCK_MODE==='main'?'app':'node');else process.exit(3);}
else if(a[0]==='run'){if(a.includes('--apply')&&e.MOCK_FAIL_APPLY)process.exit(42);if(!a.includes('--apply')&&e.MOCK_FAIL_PREVIEW)process.exit(41);console.log(JSON.stringify({mode:a.includes('--apply')?'apply':'dry-run',changed:1,backup:'/backup/atlas-retarget-fixture'}));}
else if(a[0]==='stop'){fs.writeFileSync(e.DOCKER_STATE,'false');console.log('${cid}');}
else if(a[0]==='start'){if(e.MOCK_FAIL_START)process.exit(43);fs.writeFileSync(e.DOCKER_STATE,'true');console.log('${cid}');}
else process.exit(9);\n`,
    { mode: 0o755 },
  );
  return {
    root,
    log,
    state,
    plan,
    run: (mode = "node", apply = false) =>
      spawnSync(
        "bash",
        [
          join(scripts, "apply-cloudfront-retarget.sh"),
          mode,
          plan,
          ...(apply ? ["--apply"] : []),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            DOCKER_LOG: log,
            DOCKER_STATE: state,
            MOCK_MODE: mode,
            ...overrides,
          },
        },
      ),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}
test("dryrun only reads selected service via isolated existing image", (t) => {
  const f = fixture(t),
    out = f.run();
  assert.equal(out.status, 0, out.stderr);
  const calls = f.calls(),
    run = calls.find((c) => c[0] === "run");
  assert.ok(run);
  assert.ok(run.includes(`${cid}:ro`));
  assert.equal(run[run.indexOf("--network") + 1], "none");
  assert.equal(run[run.indexOf("--user") + 1], "0:0");
  assert.ok(run.includes("--pull=never"));
  assert.ok(run.some((a) => a.endsWith("/work/plan.json:ro")));
  assert.ok(run.includes("--entrypoint"));
  assert.ok(!calls.some((c) => ["stop", "start", "compose"].includes(c[0])));
  assert.equal(readFileSync(f.state, "utf8"), "true");
});
test("apply validates then stops only selected main, verifies stopped, applies and restarts same container", (t) => {
  const f = fixture(t),
    out = f.run("main", true);
  assert.equal(out.status, 0, out.stderr);
  const calls = f.calls(),
    stop = calls.findIndex((c) => c[0] === "stop"),
    apply = calls.findIndex((c) => c[0] === "run" && c.includes("--apply")),
    start = calls.findIndex((c) => c[0] === "start");
  assert.ok(stop > calls.findIndex((c) => c[0] === "run"));
  assert.ok(apply > stop && start > apply);
  assert.ok(
    calls
      .slice(stop + 1, apply)
      .some((c) => c[0] === "inspect" && c.includes("{{.State.Running}}")),
  );
  assert.ok(calls[stop].includes(cid));
  assert.deepEqual(calls[start], ["start", cid]);
  assert.ok(calls[apply].includes("--offline"));
  assert.ok(calls[apply].includes(cid));
  assert.ok(calls[apply].some((a) => a.endsWith(":/backup:rw")));
  assert.ok(!calls.some((c) => c[0] === "compose"));
  assert.equal(readFileSync(f.state, "utf8"), "true");
  assert.match(out.stdout, /BACKUP_ROOT=/);
});
for (const [name, matches] of [
  ["none", ""],
  ["many", `${cid}\n012345abcdef`],
])
  test(`rejects ${name} running containers`, (t) => {
    const f = fixture(t, { MOCK_MATCHES: matches }),
      out = f.run("node", true);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /exactly one/);
    assert.ok(!f.calls().some((c) => ["run", "stop", "start"].includes(c[0])));
  });
test("failed preview never stops service", (t) => {
  const f = fixture(t, { MOCK_FAIL_PREVIEW: "1" }),
    out = f.run("node", true);
  assert.notEqual(out.status, 0);
  assert.ok(!f.calls().some((c) => c[0] === "stop"));
  assert.equal(readFileSync(f.state, "utf8"), "true");
});
test("failed apply leaves selected service stopped for review", (t) => {
  const f = fixture(t, { MOCK_FAIL_APPLY: "1" }),
    out = f.run("node", true);
  assert.notEqual(out.status, 0);
  assert.equal(readFileSync(f.state, "utf8"), "false");
  assert.ok(!f.calls().some((c) => c[0] === "start"));
  assert.match(out.stderr, /remains stopped/);
});
test("restart failure is reported, not claimed healthy", (t) => {
  const f = fixture(t, { MOCK_FAIL_START: "1" }),
    out = f.run("node", true);
  assert.notEqual(out.status, 0);
  assert.equal(readFileSync(f.state, "utf8"), "false");
  assert.match(out.stderr, /restart failed/);
});
