#!/usr/bin/env node
// Creates a NEW, resumable CloudFront batch using AWS CLI v2. Never deletes old resources.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
export const REQUEST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';
export const ORIGINS = {
  frontend: 'vps-1.internals.paxton.co', node2: 'vps-2.internals.paxton.co',
  node3: 'vps-3.internals.paxton.co', dispenser: 'atlas-dispenser-vps-b.internals.paxton.co',
};
const hash = (s) => createHash('sha256').update(s).digest('hex');
const fail = (s) => { throw new Error(s); };
export function writePrivate(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, path);
}
function save(dir, state) { writePrivate(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n'); }
export function entries(state) {
  if (!Number.isInteger(state.frontends) || state.frontends < 1 || state.frontends > 100) fail('Frontend count must be 1–100.');
  return [
    ...Array.from({ length: state.frontends }, (_, i) => ({ role: 'frontend', key: `frontend-${String(i + 1).padStart(3, '0')}` })),
    ...['node2', 'node3', 'dispenser'].map((role) => ({ role, key: role })),
  ];
}
export function initialize(dir, frontends = 100) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  if (existsSync(join(dir, 'state.json'))) fail('This directory already contains a batch. Use plan/create/wait to resume it.');
  const viewer = readFileSync(new URL('./cloudfront-viewer.js', import.meta.url));
  const state = { version: 1, batch: randomUUID(), frontends, origins: ORIGINS, priceClass: 'PriceClass_All', viewerHash: hash(viewer), resources: {} };
  entries(state);
  writePrivate(join(dir, 'viewer.js'), viewer); save(dir, state); return state;
}
export function distribution(state, item, functionARN, key) {
  const atlas = item.role !== 'dispenser';
  if (atlas && (!functionARN || !key || /[\r\n]/.test(key))) fail('Atlas origin key and function ARN are required.');
  const origin = {
    Id: item.role, DomainName: state.origins[item.role], OriginPath: '',
    CustomHeaders: atlas ? { Quantity: 1, Items: [{ HeaderName: 'X-Atlas-Origin-Key', HeaderValue: key }] } : { Quantity: 0 },
    CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only', OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] }, OriginReadTimeout: 60, OriginKeepaliveTimeout: 5 },
  };
  const config = {
    CallerReference: `atlas-${state.batch}-${item.key}`,
    Comment: `atlas-replace:${state.batch}:${item.key}`,
    Aliases: { Quantity: 0 }, DefaultRootObject: '', Origins: { Quantity: 1, Items: [origin] },
    DefaultCacheBehavior: {
      TargetOriginId: item.role, ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: { Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
      TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 },
      CachePolicyId: CACHE, OriginRequestPolicyId: REQUEST, Compress: true,
      FunctionAssociations: atlas ? { Quantity: 1, Items: [{ EventType: 'viewer-request', FunctionARN: functionARN }] } : { Quantity: 0 },
      LambdaFunctionAssociations: { Quantity: 0 },
    },
    CacheBehaviors: { Quantity: 0 },
    CustomErrorResponses: { Quantity: 10, Items: [400, 403, 404, 405, 414, 500, 501, 502, 503, 504].map((ErrorCode) => ({ ErrorCode, ErrorCachingMinTTL: 0 })) },
    Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' },
    PriceClass: state.priceClass, Enabled: true, HttpVersion: 'http2', IsIPV6Enabled: true,
    ViewerCertificate: { CloudFrontDefaultCertificate: true },
    Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0 } }, WebACLId: '',
  };
  return { DistributionConfig: config, Tags: { Items: [
    { Key: 'Project', Value: 'Atlas' }, { Key: 'AtlasBatch', Value: state.batch }, { Key: 'Role', Value: item.role },
  ] } };
}
const THROTTLES = new Set(['Throttling', 'ThrottlingException', 'ThrottledException', 'RequestThrottled', 'RequestThrottledException', 'TooManyRequestsException', 'RequestLimitExceeded', 'SlowDown']);
export function sleep(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function errorCode(error) {
  if (error.signal === 'SIGINT' || error.signal === 'SIGTERM') return 'INTERRUPTED';
  if (error.code === 'ETIMEDOUT') return 'CLI_TIMEOUT';
  const stderr = String(error.stderr || '');
  let parsed;
  try { parsed = JSON.parse(stderr); } catch { /* text CLI format */ }
  const value = parsed?.Error?.Code || parsed?.error?.code || parsed?.Code || parsed?.code ||
    stderr.match(/An error occurred \(([A-Za-z0-9_.-]+)\)/)?.[1] ||
    stderr.match(/^\s*(?:Error\s+)?Code:\s*([A-Za-z0-9_.-]+)\s*$/m)?.[1] || error.code;
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value || '') ? value : 'CLI_FAILED';
}
export function makeAwsRunner({ execute = execFileSync, pause = sleep, log = console.error, random = Math.random, maxAttempts = 8, baseDelayMs = 10000, maxDelayMs = 60000, timeoutMs = 75000 } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('Invalid AWS retry settings.');
  return (args) => {
    const operation = args.slice(0, 2).join(' ');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log(`AWS ${operation}: attempt ${attempt}/${maxAttempts} (request timeout ${Math.ceil(timeoutMs / 1000)}s)`);
      try {
        const result = execute('aws', [...args, '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '30'], {
          encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutMs, killSignal: 'SIGKILL',
          // Own visible retries instead of multiplying hidden SDK/CLI retries.
          env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '1' },
        });
        try { return result.trim() ? JSON.parse(result) : {}; }
        catch { throw Object.assign(new Error('AWS returned invalid JSON; response contents omitted.'), { code: 'INVALID_JSON' }); }
      } catch (error) {
        // Only explicit throttling is automatically retried. Unknown write outcomes,
        // interrupts, authorization failures and hard quotas stop for same-batch resume.
        const code = errorCode(error);
        if (THROTTLES.has(code) && attempt < maxAttempts) {
          const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          const delay = Math.round(capped * (0.75 + 0.25 * Math.min(1, Math.max(0, random()))));
          log(`AWS ${operation}: ${code}; retry ${attempt + 1}/${maxAttempts} in ${(delay / 1000).toFixed(1)}s. Progress is saved; keep this batch.`);
          pause(delay); continue;
        }
        const advice = THROTTLES.has(code)
          ? `Still throttled after ${maxAttempts} attempts. Progress is saved; wait a few minutes and rerun the same command with the same --dir. Do not run init.`
          : code === 'CLI_TIMEOUT'
            ? 'Request timed out; its outcome may be unknown. Resume the SAME batch to reconcile saved/caller-reference resources.'
            : 'Stopped without retrying this error. Fix the reported issue, then resume the same batch.';
        throw Object.assign(new Error(`AWS ${operation}: ${code}. ${advice}`), { awsCode: code });
      }
    }
  };
}
export const aws = makeAwsRunner();
function account(dir, state, run) {
  const id = run(['sts', 'get-caller-identity']).Account;
  if (!/^\d{12}$/.test(id || '')) fail('AWS account response is invalid.');
  if (state.account && state.account !== id) fail('AWS account differs from this batch. Select the original profile.');
  state.account = id; save(dir, state);
}
function readKey(dir, name) {
  const path = join(dir, `${name}.key`);
  if (!existsSync(path)) fail(`Missing ${name}.key. Copy the EXISTING running edge key before creating distributions.`);
  const value = readFileSync(path, 'utf8').trim();
  if (!/^[!-~]{16,512}$/.test(value)) fail(`Invalid ${name}.key: expected one nonempty origin secret, without spaces/newlines.`);
  chmodSync(path, 0o600); return value;
}
function ensureFunction(dir, state, run, group) {
  const name = `atlas-viewer-${state.batch}-${group}`;
  const comment = `Atlas ${group} ${state.batch} ${state.viewerHash}`;
  const config = { Comment: comment, Runtime: 'cloudfront-js-2.0' };
  let result;
  try { result = run(['cloudfront', 'describe-function', '--name', name, '--stage', 'DEVELOPMENT']); }
  catch (error) {
    if (error.awsCode !== 'NoSuchFunctionExists') throw error;
    try { result = run(['cloudfront', 'create-function', '--name', name, '--function-config', JSON.stringify(config), '--function-code', `fileb://${join(dir, 'viewer.js')}`]); }
    catch (createError) {
      if (createError.awsCode !== 'FunctionAlreadyExists') throw createError;
      result = run(['cloudfront', 'describe-function', '--name', name, '--stage', 'DEVELOPMENT']);
    }
  }
  const found = result.FunctionSummary;
  if (found?.FunctionConfig?.Comment !== comment || found.FunctionConfig.Runtime !== config.Runtime) fail('Existing function does not match this batch. No overwrite performed.');
  const published = run(['cloudfront', 'publish-function', '--name', name, '--if-match', result.ETag]);
  const arn = published.FunctionSummary?.FunctionMetadata?.FunctionARN || found.FunctionMetadata?.FunctionARN;
  if (!arn?.startsWith(`arn:aws:cloudfront::${state.account}:function/`)) fail('Unexpected function ARN.');
  state.functions ||= {}; state.functions[group] = arn;
  save(dir, state); return arn;
}
function assertConfig(actual, expected) {
  // Check all explicit desired fields, allowing server-supplied defaults.
  function contains(a, e) {
    if (Array.isArray(e)) return Array.isArray(a) && a.length === e.length && e.every((v) => a.some((candidate) => contains(candidate, v)));
    if (e && typeof e === 'object') return a && Object.entries(e).every(([k, v]) => contains(a[k], v));
    return a === e;
  }
  if (!contains(actual, expected)) fail('Existing distribution configuration differs from this batch. No overwrite performed.');
}
export function exportLinks(dir, state) {
  const list = entries(state);
  if (!list.every((i) => state.resources[i.key])) return false;
  const originFor = (key) => {
    const host = state.resources[key].domain;
    if (!/^d[a-z0-9]+\.cloudfront\.net$/.test(host || '')) fail('Unexpected CloudFront hostname.');
    return `https://${host}`;
  };
  const frontendOrigins = list.filter((i) => i.role === 'frontend').map((i) => originFor(i.key));
  const urls = { batch: state.batch, frontendOrigin: frontendOrigins[0], frontendOrigins, node2Origin: originFor('node2'), node3Origin: originFor('node3'), dispenserOrigin: originFor('dispenser') };
  if (new Set([...frontendOrigins, urls.node2Origin, urls.node3Origin, urls.dispenserOrigin]).size !== list.length) fail('Duplicate distribution hostnames.');
  writePrivate(join(dir, 'urls.json'), JSON.stringify(urls, null, 2) + '\n');
  writePrivate(join(dir, 'frontend-import.txt'), frontendOrigins.map((url, i) => `Atlas ${String(i + 1).padStart(3, '0')} | ${url}/`).join('\n') + '\n');
  return true;
}
export function createBatch(dir, state, run = aws, log = console.log, { pause = sleep, createDelayMs = run === aws ? 5000 : 0 } = {}) {
  if (!Number.isFinite(createDelayMs) || createDelayMs < 0 || createDelayMs > 60000) fail('Create delay must be between 0 and 60 seconds.');
  const keys = { frontend: readKey(dir, 'main'), node2: readKey(dir, 'node2'), node3: readKey(dir, 'node3') };
  if (hash(readFileSync(join(dir, 'viewer.js'))) !== state.viewerHash) fail('viewer.js changed after initialization.');
  account(dir, state, run);
  // AWS permits at most 100 distributions associated with the same function.
  const functions = { front: ensureFunction(dir, state, run, 'front'), nodes: ensureFunction(dir, state, run, 'nodes') };
  let inventory = run(['cloudfront', 'list-distributions']).DistributionList?.Items || [];
  const items = entries(state);
  log(`Batch progress: ${Object.keys(state.resources).length}/${items.length} saved; checking existing resources before creating missing ones.`);
  for (const [index, item] of items.entries()) {
    const body = distribution(state, item, functions[item.role === 'frontend' ? 'front' : 'nodes'], keys[item.role]);
    const expected = body.DistributionConfig;
    let prior = state.resources[item.key];
    if (!prior) {
      const matches = inventory.filter((d) => d.Comment === expected.Comment);
      if (matches.length > 1) fail('Multiple distributions match one batch item. Review inventory.');
      if (matches.length) prior = { id: matches[0].Id };
    }
    let result;
    if (prior) {
      log(`[${index + 1}/${items.length}] ${item.key}: checking existing distribution ${prior.id}`);
      result = run(['cloudfront', 'get-distribution', '--id', prior.id]).Distribution;
      assertConfig(result.DistributionConfig, expected);
    } else {
      const path = join(dir, `${item.key}.json`);
      writePrivate(path, JSON.stringify(body, null, 2) + '\n');
      log(`[${index + 1}/${items.length}] ${item.key}: creating; pacing ${(createDelayMs / 1000).toFixed(1)}s`);
      pause(createDelayMs);
      try { result = run(['cloudfront', 'create-distribution-with-tags', '--distribution-config-with-tags', `file://${path}`]).Distribution; }
      catch (error) {
        if (error.awsCode !== 'DistributionAlreadyExists') throw error;
        inventory = run(['cloudfront', 'list-distributions']).DistributionList?.Items || [];
        const matches = inventory.filter((d) => d.Comment === expected.Comment);
        if (matches.length !== 1) fail('CallerReference already exists, but matching distribution is not yet visible. Retry this batch later.');
        result = run(['cloudfront', 'get-distribution', '--id', matches[0].Id]).Distribution;
        assertConfig(result.DistributionConfig, expected);
      }
    }
    if (!result?.Id || !result.DomainName) fail('Incomplete AWS distribution response. Retry the same batch.');
    state.resources[item.key] = { id: result.Id, domain: result.DomainName, status: result.Status };
    save(dir, state); log(`${item.key}: ${result.Id} https://${result.DomainName}`);
  }
  exportLinks(dir, state);
  log(`CREATED_OR_RESUMED=${entries(state).length}; IMPORT=${join(dir, 'frontend-import.txt')}`);
}
export function waitBatch(dir, state, run = aws, log = console.log, { pause = sleep, pollMs = 30000, maxPolls = 80 } = {}) {
  if (!Number.isFinite(pollMs) || pollMs < 0 || !Number.isInteger(maxPolls) || maxPolls < 1) fail('Invalid deployment polling settings.');
  const items = entries(state);
  if (items.some((item) => !state.resources[item.key])) fail('Batch is incomplete; run create --apply again first.');
  account(dir, state, run);
  for (const [index, item] of items.entries()) {
    const resource = state.resources[item.key];
    let deployed = false;
    for (let poll = 1; poll <= maxPolls; poll++) {
      log(`[${index + 1}/${items.length}] ${item.key}: checking deployment (${poll}/${maxPolls})`);
      const result = run(['cloudfront', 'get-distribution', '--id', resource.id]).Distribution;
      if (result?.Id !== resource.id || !['InProgress', 'Deployed'].includes(result.Status)) fail('Unexpected deployment status; no completion recorded.');
      resource.status = result.Status; save(dir, state);
      if (result.Status === 'Deployed') { deployed = true; log(`${item.key}: Deployed`); break; }
      if (poll < maxPolls) { log(`${item.key}: InProgress; checking again in ${pollMs / 1000}s`); pause(pollMs); }
    }
    if (!deployed) fail(`${item.key} is still deploying after ${maxPolls} checks. Progress is saved; rerun wait with the same --dir.`);
  }
  exportLinks(dir, state);
}
export function unlockBatch(dir, inspect = spawnSync) {
  const lock = join(dir, '.running');
  if (!existsSync(lock)) return 'UNLOCK: no lock present';
  // lsof inspects the open lock descriptor even for the older empty lock format.
  // Refuse on missing tools/permission errors; never unlink an active owner's lock.
  const result = inspect('lsof', ['-t', lock], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 1 || String(result.stdout || '').trim() || String(result.stderr || '').trim()) fail('Lock is active or its owner could not be verified. Stop the old helper first; no lock was removed.');
  unlinkSync(lock); return 'UNLOCK: stale lock removed; saved distributions unchanged';
}
export function cli(argv) {
  const command = argv.shift();
  const opts = {};
  while (argv.length) {
    const arg = argv.shift();
    if (arg === '--apply') opts.apply = true;
    else if (['--dir', '--frontends', '--create-delay-seconds'].includes(arg) && argv.length) opts[arg.slice(2)] = argv.shift();
    else fail(`Unknown or incomplete option: ${arg}`);
  }
  if (!opts.dir || !['init', 'plan', 'create', 'wait', 'unlock'].includes(command)) fail('Usage: node scripts/cloudfront-reset.mjs init|plan|create|wait|unlock --dir PRIVATE_DIRECTORY [--frontends 100] [--create-delay-seconds 5] [--apply]');
  const dir = resolve(opts.dir);
  if (command === 'init') { const s = initialize(dir, Number(opts.frontends || 100)); console.log(`BATCH=${s.batch}; FRONTENDS=${s.frontends}; TOTAL=${s.frontends + 3}; DIR=${dir}`); return; }
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  if (state.version !== 1 || !/^[a-f0-9-]{36}$/.test(state.batch)) fail('Unsupported batch state.');
  if (command === 'unlock') { console.log(unlockBatch(dir)); return; }
  if (command === 'plan') {
    for (const role of Object.keys(state.origins)) console.log(`${role}: ${role === 'frontend' ? state.frontends : 1} → ${state.origins[role]}`);
    console.log(`TOTAL=${entries(state).length}; EXISTING_RESOURCES_CHANGED=0; LOCAL_RELAY_MODE=frontend`); return;
  }
  if (command === 'create' && !opts.apply) fail('Creation requires --apply. Run plan first.');
  const lock = join(dir, '.running');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { fail('Batch is locked. Stop the other invocation; after a crash, remove .running only once no invocation remains.'); }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }) + '\n');
    command === 'create' ? createBatch(dir, state, aws, console.log, { createDelayMs: Number(opts['create-delay-seconds'] ?? 5) * 1000 }) : waitBatch(dir, state);
  }
  finally { closeSync(fd); unlinkSync(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
