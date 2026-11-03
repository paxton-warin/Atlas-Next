#!/usr/bin/env node
// Read-only, no network or deployment. Works from any current directory.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
assert.equal(json('package.json').name, 'atlas-next');
assert.equal(json('dispenser/package.json').name, 'atlas-link-dispenser');
for (const name of [
  'runtime/host.ts', 'server/index.mjs', 'server/node.mjs',
  'dispenser/apps/server/src/app.ts', 'dispenser/apps/web/src/App.tsx',
  'dispenser/packages/database/migrations', 'dispenser/pnpm-lock.yaml',
  'upstream/scramjet-ls-bypass',
  'maintenance/history/original-sw.js',
  'maintenance/history/original-server-index.mjs',
  'maintenance/history/DIFF.patch',
  'scripts/workspace.mjs',
  'tools/TOOLING-MAP.json',
]) {
  const path = resolve(root, name);
  assert.ok(existsSync(path), `Missing required project file: ${name}`);
  assert.ok(realpathSync(path).startsWith(realpathSync(root) + '/'), `Outside checkout: ${name}`);
}
assert.ok(!existsSync(resolve(root, 'dispenser/.git')), 'Dispenser source must be part of the parent checkout, not an embedded Git repository');
const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
assert.ok(ignore.includes('/local-retained/'));
const dockerIgnore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
assert.ok(dockerIgnore.split('\n').includes('/local-retained'));
assert.ok(dockerIgnore.split('\n').includes('/dispenser'));
assert.ok(ignore.split('\n').includes('/evidence/'), 'Audit output must be entirely disposable/ignored');
assert.ok(!ignore.includes('!/evidence/'), 'Source history must not live in audit output');
const workspace = json('scripts/workspace.config.json');
for (const component of workspace.components) {
  const hash = createHash('sha256').update(readFileSync(resolve(root, component.lockfile))).digest('hex');
  assert.equal(hash, component.lockfileSha256, `Unexpected ${component.id} dependency change`);
}
if (process.argv.includes('--tracked')) {
  for (const name of ['package.json', 'dispenser/package.json', 'dispenser/apps/server/src/app.ts', 'scripts/workspace.mjs']) {
    const entry = execFileSync('git', ['ls-files', '--stage', '--', name], { cwd: root, encoding: 'utf8' }).trim();
    assert.match(entry, /^100(?:644|755) /, `Not ordinary parent-repository source: ${name}`);
  }
}
console.log('LOCAL_PROJECT_LAYOUT=PASS;one parent repository;browser+hub sources contained;dependency locks unchanged;evidence disposable;private retention excluded');
