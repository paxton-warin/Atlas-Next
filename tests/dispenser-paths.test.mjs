import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const script = new URL('../scripts/sync-hub-contracts.mjs', import.meta.url);

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas consolidated checkout '));
  try {
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'runtime'));
    mkdirSync(join(dir, 'dispenser/packages/shared/src'), { recursive: true });
    cpSync(script, join(dir, 'scripts/sync-hub-contracts.mjs'));
    writeFileSync(join(dir, 'dispenser/packages/shared/src/hub.ts'), 'export const fixture = 1;\n');
    return run(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const sync = (dir, args = []) => spawnSync(process.execPath, [join(dir, 'scripts/sync-hub-contracts.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8' });

test('Hub contract synchronization uses the contained dispenser from any working directory', () => fixture(dir => {
  const write = sync(dir); assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /HUB_CONTRACTS_MATCH [a-f0-9]{64}/);
  const generated = readFileSync(join(dir, 'runtime/hub-contracts.ts'), 'utf8');
  assert.match(generated, /export const fixture = 1;/);
  const check = sync(dir, ['--check']); assert.equal(check.status, 0, check.stderr);
  assert.equal(readFileSync(join(dir, 'runtime/hub-contracts.ts'), 'utf8'), generated);
}));

test('Hub contract check rejects drift without changing the target', () => fixture(dir => {
  assert.equal(sync(dir).status, 0);
  const target = join(dir, 'runtime/hub-contracts.ts');
  writeFileSync(target, 'existing target is deliberately stale\n');
  const check = sync(dir, ['--check']); assert.equal(check.status, 1);
  assert.match(check.stderr, /Hub wire contracts differ between release components/);
  assert.equal(readFileSync(target, 'utf8'), 'existing target is deliberately stale\n');
}));

test('The actual imported Hub contracts match Main from an unrelated working directory', () => {
  const check = spawnSync(process.execPath, [fileURLToPath(script), '--check'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /HUB_CONTRACTS_MATCH [a-f0-9]{64}/);
});

test('Hub database package resolution stays inside the consolidated checkout', () => {
  const require = createRequire(new URL('../dispenser/apps/server/package.json', import.meta.url));
  const pg = require.resolve('pg');
  assert.ok(pg.startsWith(root), `Resolved outside consolidated repository: ${pg}`);
  assert.equal(typeof require('pg').Pool, 'function');
});

test('Active Main scripts and tests no longer resolve the former sibling checkout', () => {
  const checked = [];
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '__pycache__'].includes(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && file.endsWith('.mjs') && file !== fileURLToPath(import.meta.url)) {
        const source = readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /["'](?:\.\.\/)+Atlas-Link-Dispenser(?:\/|["'])|["']\/Users\/paxton\/Repositories\/Atlas-Link-Dispenser(?:\/|["'])/, file);
        checked.push(file);
      }
    }
  }
  scan(join(root, 'scripts')); scan(join(root, 'tests'));
  assert.ok(checked.length > 100);
});

test('Lab and paused staging source roots use the contained dispenser', () => {
  for (const file of ['scripts/hub-lab.mjs', 'scripts/hub-lab-hub.mjs', 'tools/lab/perf-staging/stack.mjs']) {
    assert.match(readFileSync(join(root, file), 'utf8'), /resolve\(root,\s*["']dispenser["']\)/, file);
  }
});
