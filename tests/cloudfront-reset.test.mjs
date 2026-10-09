import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, entries, distribution, createBatch, waitBatch, cli, CACHE, REQUEST } from '../scripts/cloudfront-reset.mjs';

function fixture(t, n = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-cf-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = initialize(dir, n);
  for (const name of ['main', 'node2', 'node3']) writeFileSync(join(dir, `${name}.key`), `fixture-${name}-not-a-real-secret`);
  return { dir, state };
}
function mockAWS() {
  const functions = new Map(), distributions = new Map(), calls = [];
  const mock = { functions, distributions, calls, account: '123456789012', failAt: null };
  mock.run = (args) => {
    calls.push(args);
    const action = args[1];
    const option = (name) => args[args.indexOf(name) + 1];
    if (action === 'get-caller-identity') return { Account: mock.account };
    if (action === 'describe-function') {
      if (!functions.has(option('--name'))) throw Object.assign(Error('missing'), { awsCode: 'NoSuchFunctionExists' });
      return functions.get(option('--name'));
    }
    if (action === 'create-function') {
      const name = option('--name');
      const result = { ETag: 'etag-fixture', FunctionSummary: { FunctionConfig: JSON.parse(option('--function-config')), FunctionMetadata: { FunctionARN: `arn:aws:cloudfront::${mock.account}:function/${name}` } } };
      functions.set(name, result); return result;
    }
    if (action === 'publish-function') return functions.get(option('--name'));
    if (action === 'list-distributions') return { DistributionList: { Items: [...distributions.values()].map((d) => ({ Id: d.Id, Comment: d.DistributionConfig.Comment })) } };
    if (action === 'create-distribution-with-tags') {
      const input = JSON.parse(readFileSync(option('--distribution-config-with-tags').slice(7), 'utf8'));
      if (mock.failAt === distributions.size) throw Error('Fixture interruption');
      const id = `D${distributions.size + 1}`;
      const d = { Id: id, DomainName: `d${distributions.size + 1}fixture.cloudfront.net`, Status: 'InProgress', DistributionConfig: input.DistributionConfig };
      distributions.set(id, d); return { Distribution: d };
    }
    if (action === 'get-distribution') return { Distribution: distributions.get(option('--id')) };
    if (action === 'wait') { assert.equal(args[2], 'distribution-deployed'); return {}; }
    throw Error(`Unexpected AWS action ${action}`);
  };
  return mock;
}
test('plan has 100 frontends, two nodes and one dispenser, no separate main runtime', (t) => {
  const { state } = fixture(t, 100);
  assert.equal(entries(state).length, 103);
  assert.equal(entries(state).filter((i) => i.role === 'frontend').length, 100);
  assert.equal(state.origins.node2, 'vps-2.internals.paxton.co');
});
test('Atlas config forwards viewer headers/cookies/query and WS without caching or iframe restrictions', (t) => {
  const { state } = fixture(t);
  const c = distribution(state, entries(state)[0], 'arn:fixture', 'fixture-key').DistributionConfig;
  assert.equal(c.Origins.Items[0].DomainName, 'vps-1.internals.paxton.co');
  assert.equal(c.Origins.Items[0].CustomOriginConfig.OriginProtocolPolicy, 'https-only');
  assert.equal(c.Origins.Items[0].CustomHeaders.Items[0].HeaderName, 'X-Atlas-Origin-Key');
  assert.equal(c.DefaultCacheBehavior.CachePolicyId, CACHE);
  assert.equal(c.DefaultCacheBehavior.OriginRequestPolicyId, REQUEST);
  assert.equal(c.DefaultCacheBehavior.AllowedMethods.Quantity, 7);
  assert.equal(c.DefaultCacheBehavior.ResponseHeadersPolicyId, undefined);
  assert.equal(c.DefaultRootObject, '');
  assert.ok(c.CustomErrorResponses.Items.every((e) => e.ErrorCachingMinTTL === 0 && !e.ResponsePagePath));
});
test('dispenser uses its own existing virtual host, without Atlas key or viewer function', (t) => {
  const { state } = fixture(t);
  const c = distribution(state, { key: 'dispenser', role: 'dispenser' }).DistributionConfig;
  assert.equal(c.Origins.Items[0].DomainName, 'atlas-dispenser-vps-b.internals.paxton.co');
  assert.equal(c.Origins.Items[0].CustomHeaders.Quantity, 0);
  assert.equal(c.DefaultCacheBehavior.FunctionAssociations.Quantity, 0);
});
test('create exports ONLY frontend links for dispenser, and state/files are private', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS();
  createBatch(dir, state, aws.run, () => {});
  const urls = JSON.parse(readFileSync(join(dir, 'urls.json')));
  const lines = readFileSync(join(dir, 'frontend-import.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes(urls.frontendOrigin));
  assert.ok(!lines.some((l) => l.includes(urls.node2Origin) || l.includes(urls.node3Origin) || l.includes(urls.dispenserOrigin)));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'frontend-001.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
});
test('100 frontend functions + 2 node functions never exceed 100 associations per function', (t) => {
  const { dir, state } = fixture(t, 100); const aws = mockAWS();
  createBatch(dir, state, aws.run, () => {});
  assert.equal(aws.functions.size, 2); assert.equal(aws.distributions.size, 103);
  const counts = new Map();
  for (const d of aws.distributions.values()) for (const f of d.DistributionConfig.DefaultCacheBehavior.FunctionAssociations.Items || []) counts.set(f.FunctionARN, (counts.get(f.FunctionARN) || 0) + 1);
  assert.deepEqual([...counts.values()].sort((a, b) => a - b), [2, 100]);
});
test('repeat create resumes without duplicate distributions or overwriting existing resources', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS();
  createBatch(dir, state, aws.run, () => {}); createBatch(dir, state, aws.run, () => {});
  assert.equal(aws.distributions.size, 5);
  assert.equal(aws.calls.filter((a) => a[1] === 'create-distribution-with-tags').length, 5);
  assert.ok(!aws.calls.some((a) => /delete|update/.test(a[1])));
});
test('resume recovers creation committed at AWS but missing local receipt', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS();
  createBatch(dir, state, aws.run, () => {});
  delete state.resources['frontend-001'];
  createBatch(dir, state, aws.run, () => {});
  assert.equal(state.resources['frontend-001'].id, 'D1');
  assert.equal(aws.distributions.size, 5);
});
test('partial failure persists progress; rerun completes only missing items', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS(); aws.failAt = 2;
  assert.throws(() => createBatch(dir, state, aws.run, () => {}), /Fixture interruption/);
  const resumed = JSON.parse(readFileSync(join(dir, 'state.json')));
  assert.equal(Object.keys(resumed.resources).length, 2);
  assert.equal(existsSync(join(dir, 'frontend-import.txt')), false);
  aws.failAt = null; createBatch(dir, resumed, aws.run, () => {});
  assert.equal(aws.distributions.size, 5);
});
test('different account refuses mutation', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS(); state.account = '111111111111';
  assert.throws(() => createBatch(dir, state, aws.run, () => {}), /differs/);
  assert.equal(aws.functions.size, 0); assert.equal(aws.distributions.size, 0);
});
test('config drift refuses overwrite; unordered AWS method list is accepted', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS(); createBatch(dir, state, aws.run, () => {});
  aws.distributions.get('D1').DistributionConfig.DefaultCacheBehavior.AllowedMethods.Items.reverse();
  createBatch(dir, state, aws.run, () => {});
  aws.distributions.get('D1').DistributionConfig.Origins.Items[0].DomainName = 'wrong.example';
  assert.throws(() => createBatch(dir, state, aws.run, () => {}), /differs/);
});
test('viewer code changes or missing keys fail before any AWS call', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS();
  writeFileSync(join(dir, 'viewer.js'), '// changed');
  assert.throws(() => createBatch(dir, state, aws.run, () => {}), /changed/);
  assert.equal(aws.calls.length, 0);
  rmSync(join(dir, 'node2.key'));
  assert.throws(() => createBatch(dir, state, aws.run, () => {}), /Missing node2.key/);
});
test('waiting uses recorded IDs and never creates/deletes', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS(); createBatch(dir, state, aws.run, () => {});
  for (const distribution of aws.distributions.values()) distribution.Status = 'Deployed';
  aws.calls.length = 0; waitBatch(dir, state, aws.run, () => {});
  assert.equal(aws.calls.filter((a) => a[1] === 'get-distribution').length, 5);
  assert.ok(Object.values(state.resources).every((r) => r.status === 'Deployed'));
  assert.ok(aws.calls.every((a) => ['get-distribution', 'get-caller-identity'].includes(a[1])));
});
test('new creations are paced and announced; resuming existing resources does not delay for creation', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS(), delays = [], output = [];
  const options = { pause: (ms) => delays.push(ms), createDelayMs: 5000 };
  createBatch(dir, state, aws.run, (line) => output.push(line), options);
  assert.deepEqual(delays, [5000, 5000, 5000, 5000, 5000]);
  assert.ok(output.some((line) => line.includes('[1/5]') && line.includes('pacing 5.0s')));
  delays.length = 0;
  createBatch(dir, state, aws.run, (line) => output.push(line), options);
  assert.deepEqual(delays, []);
  assert.equal(aws.distributions.size, 5);
});
test('create requires explicit apply; init never overwrites a batch', (t) => {
  const { dir } = fixture(t);
  assert.throws(() => cli(['create', '--dir', dir]), /requires --apply/);
  assert.throws(() => initialize(dir), /already contains/);
});
test('output never contains the fixture origin secrets', (t) => {
  const { dir, state } = fixture(t); const aws = mockAWS(), output = [];
  createBatch(dir, state, aws.run, (line) => output.push(line));
  assert.ok(!output.join('\n').includes('not-a-real-secret'));
  assert.ok(!readFileSync(join(dir, 'urls.json'), 'utf8').includes('not-a-real-secret'));
});
