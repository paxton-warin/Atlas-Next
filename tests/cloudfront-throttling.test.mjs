import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = await import('../scripts/cloudfront-reset.mjs');
const ARGS = ['cloudfront', 'create-distribution-with-tags', '--distribution-config-with-tags', 'file:///private/fixture-origin-key.json'];
const SECRET = 'fixture-secret-that-must-never-be-logged';

function awsError(code, extras = {}) {
  return Object.assign(new Error('CLI fixture failure'), {
    stderr: `An error occurred (${code}) when calling the CreateDistributionWithTags operation: ${SECRET}`,
    status: 254,
  }, extras);
}

function fixture(responses, options = {}) {
  assert.equal(typeof helper.makeAwsRunner, 'function', 'CloudFront runner must expose bounded, visible throttling retries');
  const calls = [], delays = [], logs = [];
  const execute = (file, args, opts) => {
    calls.push({ file, args, opts });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.notEqual(response, undefined, 'runner made an unexpected extra AWS invocation');
    return response;
  };
  const run = helper.makeAwsRunner({
    execute, pause: (ms) => delays.push(ms), log: (line) => logs.push(String(line)),
    random: () => 0.5, maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 25,
    timeoutMs: 75000, ...options,
  });
  return { run, calls, delays, logs };
}

test('runner succeeds once, bounds AWS subprocess time, and disables nested SDK retries', () => {
  const f = fixture(['{"Distribution":{"Id":"D-FIXTURE"}}']);
  assert.equal(f.run(ARGS).Distribution.Id, 'D-FIXTURE');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.delays, []);
  const call = f.calls[0];
  assert.equal(call.file, 'aws');
  assert.equal(String(call.opts.env.AWS_MAX_ATTEMPTS), '1');
  assert.equal(call.opts.env.AWS_RETRY_MODE, 'standard');
  assert.equal(call.opts.timeout, 75000);
  assert.equal(call.opts.killSignal, 'SIGKILL');
  assert.equal(String(call.args[call.args.indexOf('--cli-connect-timeout') + 1]), '10');
  assert.equal(String(call.args[call.args.indexOf('--cli-read-timeout') + 1]), '30');
  assert.ok(f.logs.some((line) => /attempt|trying|call/i.test(line)), 'AWS call must have visible progress');
});

for (const code of ['Throttling', 'ThrottlingException', 'TooManyRequestsException', 'RequestLimitExceeded']) {
  test(`${code} retries the identical request then returns success`, () => {
    const f = fixture([awsError(code), '{"Distribution":{"Id":"D-RETRIED"}}']);
    assert.equal(f.run(ARGS).Distribution.Id, 'D-RETRIED');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[0].args, f.calls[1].args, 'CallerReference input file must remain unchanged');
    assert.equal(f.delays.length, 1);
    assert.ok(f.delays[0] > 0 && f.delays[0] <= 25);
    assert.ok(f.logs.some((line) => /retry|throttl|wait/i.test(line)), 'backoff must be visible');
  });
}

test('persistent throttling stops at maxAttempts with capped backoff', () => {
  const f = fixture(Array.from({ length: 4 }, () => awsError('Throttling')));
  assert.throws(() => f.run(ARGS), (error) => error.awsCode === 'Throttling');
  assert.equal(f.calls.length, 4);
  assert.equal(f.delays.length, 3);
  assert.ok(f.delays.every((ms) => ms > 0 && ms <= 25));
  assert.ok(f.delays[1] >= f.delays[0], 'backoff should grow until its cap');
});

for (const code of ['AccessDenied', 'TooManyDistributions', 'InvalidArgument', 'ExpiredToken', 'DistributionAlreadyExists']) {
  test(`${code} is not mistaken for a retryable throttle`, () => {
    const f = fixture([awsError(code)]);
    assert.throws(() => f.run(ARGS), (error) => error.awsCode === code);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.delays, []);
  });
}

test('an interrupted subprocess is not retried even if stderr contains Throttling', () => {
  const f = fixture([awsError('Throttling', { signal: 'SIGINT', status: null })]);
  assert.throws(() => f.run(ARGS));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.delays, []);
});

test('a timed-out subprocess is not retried because write completion is uncertain', () => {
  const f = fixture([awsError('Throttling', { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null })]);
  assert.throws(() => f.run(ARGS));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.delays, []);
});

test('malformed JSON output is not retried and does not leak the response', () => {
  const f = fixture([`not-json-${SECRET}`]);
  let error;
  try { f.run(ARGS); } catch (caught) { error = caught; }
  assert.ok(error);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.delays, []);
  assert.ok(!`${error.message}\n${f.logs.join('\n')}`.includes(SECRET));
});

test('progress and final errors exclude command arguments, secret text, and raw error messages', () => {
  const f = fixture([awsError('Throttling'), awsError('AccessDenied')]);
  let error;
  try { f.run(ARGS); } catch (caught) { error = caught; }
  assert.ok(error);
  const output = `${error.message}\n${f.logs.join('\n')}`;
  assert.ok(!output.includes(SECRET));
  assert.ok(!output.includes('fixture-origin-key.json'));
  assert.ok(!output.includes('--distribution-config-with-tags'));
  assert.ok(output.includes('cloudfront'));
});

test('structured JSON throttling error codes are retried without exposing the message', () => {
  const error = Object.assign(new Error('CLI JSON failure'), {
    stderr: JSON.stringify({ Error: { Code: 'Throttling', Message: SECRET } }), status: 254,
  });
  const f = fixture([error, '{"ok":true}']);
  assert.equal(f.run(ARGS).ok, true);
  assert.equal(f.calls.length, 2);
  assert.ok(!f.logs.join('\n').includes(SECRET));
});

function batchFixture(t, { lock = false, populated = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-throttle-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = helper.initialize(dir, 1);
  if (populated) {
    for (const [index, item] of helper.entries(state).entries()) {
      state.resources[item.key] = { id: `D${index + 1}`, domain: `d${index + 1}fixture.cloudfront.net`, status: 'InProgress' };
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  }
  if (lock) writeFileSync(join(dir, '.running'), '');
  return { dir, state, lock: join(dir, '.running'), statePath: join(dir, 'state.json') };
}

test('unlock removes a confirmed stale legacy empty lock without changing saved state', (t) => {
  const f = batchFixture(t, { lock: true, populated: true });
  const before = readFileSync(f.statePath, 'utf8');
  const calls = [];
  const result = helper.unlockBatch(f.dir, (...args) => { calls.push(args); return { status: 1, stdout: '', stderr: '' }; });
  assert.equal(existsSync(f.lock), false);
  assert.equal(readFileSync(f.statePath, 'utf8'), before);
  assert.match(result, /stale lock removed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'lsof');
  assert.deepEqual(calls[0][1], ['-t', f.lock]);
  assert.equal(calls[0][2].timeout, 10000);
});

for (const [name, inspection] of [
  ['active PID', { status: 0, stdout: '12345\n', stderr: '' }],
  ['uncertain successful inspection', { status: 0, stdout: '', stderr: '' }],
  ['warning on stderr', { status: 1, stdout: '', stderr: 'permission denied' }],
  ['spawn failure', { status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing lsof'), { code: 'ENOENT' }) }],
  ['terminated inspection', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }],
]) {
  test(`unlock preserves the lock and state for ${name}`, (t) => {
    const f = batchFixture(t, { lock: true, populated: true });
    const before = readFileSync(f.statePath, 'utf8');
    assert.throws(() => helper.unlockBatch(f.dir, () => inspection), /active|verified/i);
    assert.equal(existsSync(f.lock), true);
    assert.equal(readFileSync(f.statePath, 'utf8'), before);
  });
}

test('unlock with no lock does not inspect processes or change saved state', (t) => {
  const f = batchFixture(t, { populated: true });
  const before = readFileSync(f.statePath, 'utf8');
  assert.match(helper.unlockBatch(f.dir, () => assert.fail('No inspection expected')), /no lock present/);
  assert.equal(readFileSync(f.statePath, 'utf8'), before);
});

test('wait visibly polls InProgress to actual Deployed and saves each result', (t) => {
  const f = batchFixture(t, { populated: true }), calls = [], logs = [], delays = [], polls = new Map();
  const run = (args) => {
    calls.push(args);
    if (args[1] === 'get-caller-identity') return { Account: '123456789012' };
    assert.equal(args[1], 'get-distribution');
    const id = args[args.indexOf('--id') + 1];
    const count = (polls.get(id) || 0) + 1;
    polls.set(id, count);
    return { Distribution: { Id: id, Status: count === 1 ? 'InProgress' : 'Deployed' } };
  };
  helper.waitBatch(f.dir, f.state, run, (line) => logs.push(line), {
    pause: (ms) => {
      delays.push(ms);
      const saved = JSON.parse(readFileSync(f.statePath));
      assert.ok(Object.values(saved.resources).some((resource) => resource.status === 'InProgress'));
    }, pollMs: 12, maxPolls: 3,
  });
  assert.equal(calls.filter((args) => args[1] === 'get-distribution').length, 8);
  assert.deepEqual(delays, [12, 12, 12, 12]);
  assert.ok(logs.some((line) => line.includes('InProgress')));
  assert.ok(logs.some((line) => /2\/3/.test(line)));
  assert.ok(Object.values(JSON.parse(readFileSync(f.statePath)).resources).every((resource) => resource.status === 'Deployed'));
  assert.equal(existsSync(join(f.dir, 'frontend-import.txt')), true);
});

test('wait stops at maxPolls without marking an unfinished distribution deployed', (t) => {
  const f = batchFixture(t, { populated: true }), calls = [], delays = [], logs = [];
  const run = (args) => {
    calls.push(args);
    if (args[1] === 'get-caller-identity') return { Account: '123456789012' };
    return { Distribution: { Id: args[args.indexOf('--id') + 1], Status: 'InProgress' } };
  };
  assert.throws(() => helper.waitBatch(f.dir, f.state, run, (line) => logs.push(line), {
    pause: (ms) => delays.push(ms), pollMs: 5, maxPolls: 3,
  }), /still deploying after 3 checks/);
  assert.equal(calls.filter((args) => args[1] === 'get-distribution').length, 3);
  assert.deepEqual(delays, [5, 5]);
  assert.ok(Object.values(JSON.parse(readFileSync(f.statePath)).resources).every((resource) => resource.status === 'InProgress'));
  assert.equal(existsSync(join(f.dir, 'frontend-import.txt')), false);
  assert.ok(logs.some((line) => /3\/3/.test(line)));
});

test('wait rejects incomplete batches before making any AWS calls', (t) => {
  const f = batchFixture(t), before = readFileSync(f.statePath, 'utf8');
  assert.throws(() => helper.waitBatch(f.dir, f.state, () => assert.fail('No AWS calls expected'), () => {}, { pause: () => {} }), /incomplete/);
  assert.equal(readFileSync(f.statePath, 'utf8'), before);
});

test('wait rejects unexpected or mismatched AWS statuses without recording deployment', (t) => {
  for (const distribution of [{ Id: 'D1', Status: 'Unknown' }, { Id: 'WRONG', Status: 'Deployed' }, {}]) {
    const f = batchFixture(t, { populated: true });
    const run = (args) => args[1] === 'get-caller-identity'
      ? { Account: '123456789012' } : { Distribution: distribution };
    assert.throws(() => helper.waitBatch(f.dir, f.state, run, () => {}, { pause: () => {}, maxPolls: 1 }), /Unexpected deployment status/);
    assert.equal(JSON.parse(readFileSync(f.statePath)).resources['frontend-001'].status, 'InProgress');
  }
});
