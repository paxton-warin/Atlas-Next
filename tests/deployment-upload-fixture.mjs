import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Exercise the actual upload script and rsync filters without network or VPS access.
export function probeUpload(scriptFile, { failBackup = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-upload-"));
  const source = join(dir, "source"),
    bin = join(dir, "bin"),
    remote = join(dir, "remote");
  const put = (name, text) => {
    mkdirSync(resolve(name, ".."), { recursive: true });
    writeFileSync(name, text);
  };
  mkdirSync(bin);
  mkdirSync(remote);
  const hosts = ["main.fixture", "node2.fixture", "node3.fixture"];
  const customFiles = [
    "Caddyfile.node",
    "Caddyfile.cloudfront",
    "compose.node.yaml",
    "compose.cloudfront.yaml",
    "compose.override.yml",
    "docker-compose.yml",
    "caddy.d/dispenser.caddy",
  ];
  for (const host of hosts) {
    for (const file of customFiles)
      put(join(remote, host, file), `custom ${host} ${file}\n`);
    put(join(remote, host, ".env"), "SECRET=remote-only\n");
  }
  const templates = [
    "Caddyfile",
    "Caddyfile.node",
    "Caddyfile.cloudfront",
    "compose.yaml",
    "compose.node.yaml",
    "compose.cloudfront.yaml",
  ];
  for (const file of [...templates, ...customFiles])
    put(join(source, file), `stock ${file}\n`);
  for (const file of [
    ".env",
    ".origin-key",
    ".env.before-update",
    "backups/old-secret",
    "deployment-templates/obsolete",
  ])
    put(join(source, file), "local secret\n");
  for (const file of [
    "web/src/main.tsx",
    ".env.example",
    ".env.node.example",
    "evidence/ORIGINAL-sw.js",
    "evidence/DIFF.patch",
    "evidence/ui-refinement/original/server/index.mjs",
  ])
    put(join(source, file), "fixture\n");
  put(join(source, "server/updated.mjs"), "application update\n");
  mkdirSync(join(source, "upstream/scramjet-ls-bypass/app/vendor"), {
    recursive: true,
  });
  put(
    join(source, "scripts/upload-update.sh"),
    readFileSync(scriptFile, "utf8"),
  );
  const stub = `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { cpSync,appendFileSync } from 'node:fs';
import { join,basename } from 'node:path';
const args=process.argv.slice(2),name=basename(process.argv[1]);
const target=value=>{const m=/^[^@]+@([^:]+):\\/opt\\/atlas(.*)$/.exec(value);return m?join(process.env.FIXTURE_REMOTE,m[1],m[2]):value};
appendFileSync(process.env.FIXTURE_TRACE,name+'\\n');
if(name==='ssh') {
 const host=args[0].split('@')[1];
 if(process.env.FAIL_BACKUP==='1') process.exit(42);
 const cmd=args.slice(1).join(' ').replaceAll('/opt/atlas',join(process.env.FIXTURE_REMOTE,host));
 execFileSync('sh',['-c',cmd],{stdio:'inherit'});
} else if(name==='rsync') execFileSync('/usr/bin/rsync',args.map(target),{stdio:'inherit'});
else { const dest=target(args.at(-1)); for(const file of args.slice(0,-1))cpSync(file,join(dest,basename(file))); }
`;
  for (const name of ["ssh", "scp", "rsync"]) {
    put(join(bin, name), stub);
    execFileSync("chmod", ["+x", join(bin, name)]);
  }
  put(join(bin, "package.json"), '{"type":"module"}');
  const trace = join(dir, "trace");
  try {
    const run = spawnSync("bash", [join(source, "scripts/upload-update.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        SSH_USER: "fixture",
        MAIN_HOST: hosts[0],
        NODE2_HOST: hosts[1],
        NODE3_HOST: hosts[2],
        FIXTURE_REMOTE: remote,
        FIXTURE_TRACE: trace,
        FAIL_BACKUP: failBackup ? "1" : "0",
      },
    });
    if (failBackup) {
      assert.notEqual(run.status, 0);
      assert.equal(
        readFileSync(trace, "utf8").includes("rsync"),
        false,
        "Upload must stop before rsync if backup fails",
      );
      for (const host of hosts)
        assert.equal(
          readFileSync(join(remote, host, "Caddyfile.node"), "utf8"),
          `custom ${host} Caddyfile.node\n`,
        );
      return { failedClosed: true };
    }
    assert.equal(run.status, 0, run.stderr);
    let preserved = true,
      backedUp = true,
      staged = true;
    for (const host of hosts) {
      const target = join(remote, host);
      for (const file of customFiles)
        preserved &&=
          readFileSync(join(target, file), "utf8") ===
          `custom ${host} ${file}\n`;
      assert.equal(
        readFileSync(join(target, ".env"), "utf8"),
        "SECRET=remote-only\n",
      );
      assert.equal(
        readFileSync(join(target, "server/updated.mjs"), "utf8"),
        "application update\n",
      );
      assert.equal(existsSync(join(target, ".origin-key")), false);
      assert.equal(existsSync(join(target, ".env.before-update")), false);
      assert.equal(existsSync(join(target, "backups/old-secret")), false);
      for (const file of templates)
        staged &&=
          existsSync(join(target, "deployment-templates", file)) &&
          readFileSync(join(target, "deployment-templates", file), "utf8") ===
            `stock ${file}\n`;
      const backupRoot = join(target, "backups");
      const backups = existsSync(backupRoot)
        ? readdirSync(backupRoot).filter((n) => n.startsWith("deployment-"))
        : [];
      backedUp &&= backups.length === 1;
      for (const backup of backups) {
        const archive = join(backupRoot, backup, "deployment.tar");
        const content = execFileSync(
          "tar",
          ["-xOf", archive, "Caddyfile.node"],
          { encoding: "utf8" },
        );
        assert.equal(content, `custom ${host} Caddyfile.node\n`);
        assert.equal(statSync(archive).mode & 0o077, 0);
      }
      if (staged)
        assert.equal(
          existsSync(join(target, "deployment-templates/obsolete")),
          false,
        );
    }
    return { preserved, backedUp, staged };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
