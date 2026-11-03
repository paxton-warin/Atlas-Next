#!/usr/bin/env node
/** One repository entrypoint; no implicit upgrade, migration, deployment or server startup. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = JSON.parse(readFileSync(new URL('./workspace.config.json', import.meta.url), 'utf8'));
const ACTIONS = new Set(['install', 'dev', 'build', 'typecheck', 'test', 'check', 'verify']);

function withinRoot(path, root) {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export function verifyWorkspace(root = ROOT) {
  const messages = [];
  const canonicalRoot = realpathSync(root);
  for (const component of CONFIG.components) {
    const directory = resolve(root, component.directory);
    const lockfile = resolve(root, component.lockfile);
    if (!withinRoot(directory, root) || !withinRoot(lockfile, root)) {
      throw new Error(`Component ${component.id} escapes the repository`);
    }
    if (!withinRoot(realpathSync(directory), canonicalRoot) || !withinRoot(realpathSync(lockfile), canonicalRoot)) {
      throw new Error(`Component ${component.id} resolves outside the repository`);
    }
    if (component.directory !== '.' && existsSync(resolve(directory, '.git'))) {
      throw new Error(`Component ${component.id} must be source in the parent repository, not a nested Git repository`);
    }
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    if (manifest.name !== component.packageName) throw new Error(`Wrong package for ${component.id}`);
    const sha256 = createHash('sha256').update(readFileSync(lockfile)).digest('hex');
    if (sha256 !== component.lockfileSha256) {
      throw new Error(`Dependency lock changed for ${component.id}; review the dependency update and its workspace checksum together`);
    }
    messages.push(`${component.id}:${manifest.name}:lock-preserved`);
  }
  return messages;
}

export function commandPlan(action, selected, root = ROOT) {
  if (!ACTIONS.has(action)) throw new Error(`Unknown workspace action: ${action}`);
  if (selected && !CONFIG.components.some((component) => component.id === selected)) {
    throw new Error(`Unknown component: ${selected}`);
  }
  if (action === 'verify') return [];
  if (action === 'dev' && !selected) throw new Error('Select a component for dev; browser and Hub keep their own services');
  const components = CONFIG.components.filter((component) => !selected || selected === component.id);
  const actions = action === 'check' ? ['typecheck', 'test', 'build'] : [action];
  return actions.flatMap((item) => components.map((component) => ({
    component: component.id,
    action: item,
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['--dir', resolve(root, component.directory), ...(item === 'install' ? ['install', '--frozen-lockfile'] : ['run', item])],
    cwd: root,
  })));
}

export function runPlan(plan, execute = spawnSync, log = console.log) {
  for (const command of plan) {
    log(`[workspace] ${command.component}: ${command.action}`);
    const result = execute(command.command, command.args, { cwd: command.cwd, stdio: 'inherit', shell: false });
    if (result.error) {
      console.error(`[workspace] ${command.component}: ${result.error.message}`);
      return 1;
    }
    if (result.signal) return 128 + (constants.signals[result.signal] ?? 1);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const [action, ...args] = argv;
    let component;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--component') throw new Error('Usage: workspace.mjs ACTION [--component browser|hub]');
      component = args[1];
    }
    const plan = commandPlan(action, component);
    const messages = verifyWorkspace();
    if (action === 'verify') {
      console.log(`WORKSPACE=PASS;${messages.join(';')};one-repository;isolated-dependency-graphs`);
      return 0;
    }
    return runPlan(plan);
  } catch (error) {
    console.error(`[workspace] ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
