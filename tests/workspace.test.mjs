import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { CONFIG, ROOT, commandPlan, runPlan, verifyWorkspace } from '../scripts/workspace.mjs';

test('monorepo preserves both original package dependency graphs', () => {
  assert.equal(CONFIG.schema, 'atlas-monorepo-v1');
  assert.deepEqual(verifyWorkspace(), [
    'browser:atlas-next:lock-preserved',
    'hub:atlas-link-dispenser:lock-preserved',
  ]);
});

test('all-install routes two frozen installs to contained directories, independent of cwd', () => {
  const plan = commandPlan('install');
  assert.deepEqual(plan.map(({ args }) => args), [
    ['--dir', ROOT, 'install', '--frozen-lockfile'],
    ['--dir', resolve(ROOT, 'dispenser'), 'install', '--frozen-lockfile'],
  ]);
  assert.ok(plan.every((command) => command.cwd === ROOT));
});

test('all-check runs bounded stage-ordered commands without recursive all scripts', () => {
  const plan = commandPlan('check');
  assert.deepEqual(plan.map(({ component, action }) => `${component}:${action}`), [
    'browser:typecheck', 'hub:typecheck', 'browser:test', 'hub:test', 'browser:build', 'hub:build',
  ]);
  assert.ok(plan.every((command) => !command.args.some((arg) => arg.includes(':all'))));
  assert.ok(plan.every((command) => !command.args.some((arg) => /migrat|deploy|start|dev/.test(arg))));
});

test('Hub commands target only Hub and never invoke browser services', () => {
  for (const action of ['install', 'typecheck', 'test', 'build', 'check', 'dev']) {
    const plan = commandPlan(action, 'hub');
    assert.ok(plan.length >= 1);
    assert.ok(plan.every((command) => command.component === 'hub'));
    assert.ok(plan.every((command) => command.args[1] === resolve(ROOT, 'dispenser')));
  }
});

test('workspace commands reject unknown actions, components and ambiguous development', () => {
  assert.throws(() => commandPlan('deploy'), /Unknown/);
  assert.throws(() => commandPlan('build', '../outside'), /Unknown/);
  assert.throws(() => commandPlan('dev'), /Select a component/);
});

test('workspace child failure stops immediately and preserves exact exit status', () => {
  let called = 0;
  const result = runPlan(commandPlan('build'), () => { called++; return { status: 23 }; }, () => {});
  assert.equal(result, 23);
  assert.equal(called, 1);
});

test('workspace propagates process signals and runs children without a shell', () => {
  let called = 0;
  const result = runPlan(commandPlan('build'), (command, args, options) => {
    called++;
    assert.equal(options.shell, false);
    assert.equal(options.cwd, ROOT);
    return called === 1 ? { status: 0 } : { status: null, signal: 'SIGTERM' };
  }, () => {});
  assert.equal(result, 143);
  assert.equal(called, 2);
});

test('root scripts expose one interface while preserving browser and Hub manifests', () => {
  const main = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.equal(main.scripts.start, 'node --env-file-if-exists=.env server/index.mjs');
  assert.equal(main.scripts['node:start'], 'node --env-file-if-exists=.env server/node.mjs');
  assert.equal(main.scripts.test, 'node --test tests/*.test.mjs');
  for (const action of ['install', 'build', 'typecheck', 'test', 'check']) {
    assert.equal(main.scripts[`${action}:all`], `node scripts/workspace.mjs ${action}`);
  }
  assert.equal(main.scripts['hub:test'], 'node scripts/workspace.mjs test --component hub');
  assert.equal(main.scripts['test:hub-tools'], 'node --test dispenser/scripts/production-bootstrap.test.mjs');
  const hub = JSON.parse(readFileSync(resolve(ROOT, 'dispenser/package.json'), 'utf8'));
  assert.equal(hub.scripts.build, 'pnpm -r build');
  assert.equal(hub.scripts.test, 'pnpm -r test');
});

function isolatedWorkspace(t) {
  const parent = mkdtempSync(resolve(tmpdir(), 'atlas-workspace-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = resolve(parent, 'repo');
  mkdirSync(resolve(root, 'dispenser'), { recursive: true });
  for (const path of ['package.json', 'pnpm-lock.yaml', 'dispenser/package.json', 'dispenser/pnpm-lock.yaml']) {
    cpSync(resolve(ROOT, path), resolve(root, path));
  }
  return { parent, root };
}

test('workspace verification rejects dependency lock drift on a separate copy', (t) => {
  const { root } = isolatedWorkspace(t);
  assert.equal(verifyWorkspace(root).length, 2);
  const lock = resolve(root, 'dispenser/pnpm-lock.yaml');
  writeFileSync(lock, readFileSync(lock, 'utf8') + '\n# changed resolution metadata\n');
  assert.throws(() => verifyWorkspace(root), /Dependency lock changed for hub/);
});

test('workspace verification rejects an external Hub directory binding', (t) => {
  const { parent, root } = isolatedWorkspace(t);
  renameSync(resolve(root, 'dispenser'), resolve(parent, 'outside-hub'));
  symlinkSync(resolve(parent, 'outside-hub'), resolve(root, 'dispenser'), 'dir');
  assert.throws(() => verifyWorkspace(root), /resolves outside the repository/);
});

test('workspace verification rejects accidental nested Hub Git metadata', (t) => {
  const { root } = isolatedWorkspace(t);
  writeFileSync(resolve(root, 'dispenser/.git'), 'gitdir: /fixture-only\n');
  assert.throws(() => verifyWorkspace(root), /not a nested Git repository/);
});
