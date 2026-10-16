import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearStaleRelayCredentials,
  restoreBrowsingLeaseOnStartup,
  RELAY_RECOVERY_STORAGE_KEY,
  RELAY_RECOVERY_REVISION,
  LEASE_STORAGE_KEY,
  SAME_ORIGIN_LEASE_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  SAME_ORIGIN_SESSION_STORAGE_KEY,
} from '../web/src/browsing-session.ts';

function fixture() {
  const values = new Map([
    [LEASE_STORAGE_KEY, 'old-relay-ticket'],
    [SAME_ORIGIN_LEASE_STORAGE_KEY, 'old-boot-and-relay-ticket'],
    [SESSION_STORAGE_KEY, 'legacy-pin'],
    [SAME_ORIGIN_SESSION_STORAGE_KEY, 'current-node-4-pin'],
    ['atlas.settings', '{"theme":"forest"}'],
    ['atlas.tabs', '[{"url":"https://website.example/"}]'],
    ['atlas.admin', 'administrator-state'],
    ['https://website.example@save', 'game-progress'],
  ]);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

test('one-time recovery removes only stale lease credentials, preserving node pins and all other browser data', () => {
  const storage = fixture();
  const preserved = [...storage.values].filter(([key]) => ![LEASE_STORAGE_KEY, SAME_ORIGIN_LEASE_STORAGE_KEY].includes(key));
  assert.equal(clearStaleRelayCredentials(storage), true);
  assert.equal(storage.getItem(LEASE_STORAGE_KEY), null);
  assert.equal(storage.getItem(SAME_ORIGIN_LEASE_STORAGE_KEY), null);
  assert.equal(storage.getItem(RELAY_RECOVERY_STORAGE_KEY), RELAY_RECOVERY_REVISION);
  for (const [key, value] of preserved) assert.equal(storage.getItem(key), value);
  storage.setItem(SAME_ORIGIN_LEASE_STORAGE_KEY, 'fresh-server-ticket');
  assert.equal(clearStaleRelayCredentials(storage), false);
  assert.equal(storage.getItem(SAME_ORIGIN_LEASE_STORAGE_KEY), 'fresh-server-ticket');
});

test('concurrent embedded and popout startup clear before restore, only once under the shared lock', async () => {
  const storage = fixture();
  let queue = Promise.resolve();
  const locks = { request(name, operation) {
    assert.equal(name, 'atlas-browsing-session');
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  } };
  const calls = [];
  const startup = () => restoreBrowsingLeaseOnStartup(
    () => storage.getItem(SAME_ORIGIN_SESSION_STORAGE_KEY),
    async (session, intent) => {
      calls.push({ session, intent, cached: storage.getItem(SAME_ORIGIN_LEASE_STORAGE_KEY) });
      return { session, ticket: `fresh-${calls.length}` };
    },
    (session) => {
      storage.setItem(SAME_ORIGIN_SESSION_STORAGE_KEY, session);
      storage.setItem(SAME_ORIGIN_LEASE_STORAGE_KEY, 'fresh-server-ticket');
    },
    locks,
    () => clearStaleRelayCredentials(storage),
  );
  const [embedded, popout] = await Promise.all([startup(), startup()]);
  assert.equal(embedded.session, 'current-node-4-pin');
  assert.equal(popout.session, embedded.session);
  assert.deepEqual(calls, [
    { session: 'current-node-4-pin', intent: 'restore', cached: null },
    { session: 'current-node-4-pin', intent: 'restore', cached: 'fresh-server-ticket' },
  ]);
});

test('storage failures do not interrupt server restore or turn revocation into fresh allocation', async () => {
  const denied = new Proxy({}, { get() { return () => { throw Error('storage denied'); }; } });
  assert.equal(clearStaleRelayCredentials(denied), false);
  const requests = [];
  const revoked = Object.assign(Error('revoked'), { code: 'SESSION_REVOKED' });
  await assert.rejects(restoreBrowsingLeaseOnStartup(
    () => 'revoked-pin',
    async (session, intent) => { requests.push({ session, intent }); throw revoked; },
    () => assert.fail('revoked session must not be remembered'),
    undefined,
    () => clearStaleRelayCredentials(denied),
  ), (error) => error === revoked);
  assert.deepEqual(requests, [{ session: 'revoked-pin', intent: 'restore' }]);
});

test('embedded and popout startup both wire the shared credential cleanup without browser-wide clearing', () => {
  for (const name of ['App', 'Popout']) {
    const source = readFileSync(new URL(`../web/src/${name}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /restoreBrowsingLeaseOnStartup\(/);
    assert.match(source, /navigator\.locks,\s*\(\) => clearStaleRelayCredentials\(localStorage\)/);
  }
  const source = readFileSync(new URL('../web/src/browsing-session.ts', import.meta.url), 'utf8');
  const cleanup = source.slice(source.indexOf('export function clearStaleRelayCredentials'), source.indexOf('/** A newly activated runtime'));
  assert.doesNotMatch(cleanup, /\.clear\(|indexedDB|deleteDatabase|document\.cookie|sessionStorage/);
});
