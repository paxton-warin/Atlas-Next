/** Bounded, sealed endpoint alias for one operator-designated probe account.
 * Normal assignments/tickets/control grants remain authoritative; a candidate
 * endpoint never becomes the global node endpoint through this module. */
const bad = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const origin = value => { try { const u = new URL(value); if (u.protocol === 'https:' && u.origin === value && !u.username && !u.password) return value; } catch {} throw bad('Invalid qualification endpoint.'); };
const ALIASES = 'hubQualificationAliases', LEASES = 'hubQualificationLeases';
export function createNodeQualification(store, { now = Date.now } = {}) {
  const cache = new Map();
  function read(key) {
    const raw = store.get(key), old = cache.get(key);
    if (old?.raw === raw) return old.value;
    let value;
    try { value = raw == null ? {} : JSON.parse(store.unseal(raw)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); }
    catch { throw bad('Qualification state is unavailable.', 503); }
    cache.set(key, { raw, value }); return value;
  }
  function write(key, value) { const raw = store.seal(JSON.stringify(value)); store.set(key, raw); cache.set(key, { raw, value }); }
  const key = b => b.jobId + ':' + b.probeAccountId + ':' + b.stableNodeId;
  const common = b => b && typeof b === 'object' && !Array.isArray(b) && uuid(b.jobId) && uuid(b.probeAccountId) && /^[a-f0-9]{64}$/.test(b.planHash || '') && typeof b.stableNodeId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(b.stableNodeId) && b.stableNodeId !== 'local';
  function currentNode(b) { const n = store.db.prepare('SELECT id,endpoint FROM nodes WHERE id=?').get(b.stableNodeId); if (!n || n.endpoint !== b.expectedCurrentEndpoint) throw bad('Qualification node endpoint changed.', 409); return n; }
  function prune(value) { return Object.fromEntries(Object.entries(value).filter(([, r]) => Date.parse(r.expiresAt) >= now() - 86400000)); }
  function activeFor(accountId) {
    if (!uuid(accountId)) return null;
    const found = Object.entries(read(ALIASES)).filter(([, r]) => r.probeAccountId === accountId && !r.revoked && Date.parse(r.expiresAt) > now());
    if (found.length > 1) throw bad('Conflicting qualification assignments.', 503);
    if (!found.length) return null;
    const [aliasKey, r] = found[0]; currentNode(r); return { aliasKey, ...r };
  }
  async function probe(endpoint, nodeId) {
    const n = store.db.prepare('SELECT credential FROM nodes WHERE id=?').get(nodeId);
    if (!n?.credential) throw bad('Qualification node is unavailable.', 503);
    let response, health;
    try { response = await fetch(endpoint + '/node/health', { headers: { authorization: 'Bearer ' + store.unseal(n.credential) }, signal: AbortSignal.timeout(5000), redirect: 'error' }); health = response.ok ? await response.json() : null; } catch {}
    if (!health || health.id !== nodeId || !Array.isArray(health.capabilities) || health.capabilities.some(v => typeof v !== 'string')) throw bad('Qualification node identity or endpoint is unavailable.', 503);
    return { observedAt: now(), capabilities: [...health.capabilities] };
  }
  async function stage(b) {
    if (!common(b) || Object.keys(b).some(k => !['jobId','planHash','probeAccountId','stableNodeId','expectedCurrentEndpoint','candidateEndpoint','expiresAt'].includes(k))) throw bad('Invalid qualification operation.');
    origin(b.expectedCurrentEndpoint); origin(b.candidateEndpoint);
    const expires = Date.parse(b.expiresAt);
    if (typeof b.expiresAt !== 'string' || !Number.isFinite(expires) || new Date(expires).toISOString() !== b.expiresAt || expires <= now() || expires > now() + 15 * 60000 || b.candidateEndpoint === b.expectedCurrentEndpoint) throw bad('Qualification expiry or target is invalid.');
    currentNode(b);
    const observation = await probe(b.candidateEndpoint, b.stableNodeId);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      currentNode(b);
      const aliases = prune(read(ALIASES)), id = key(b), prior = aliases[id];
      if (prior && ['jobId','planHash','probeAccountId','stableNodeId','expectedCurrentEndpoint','candidateEndpoint'].some(k => prior[k] !== b[k])) throw bad('Qualification operation changed.', 409);
      if (prior?.revoked) throw bad('Qualification operation was revoked.', 409);
      if (prior && expires < Date.parse(prior.expiresAt)) throw bad('Qualification expiry cannot move backwards.', 409);
      if (Object.entries(aliases).some(([k, r]) => k !== id && r.probeAccountId === b.probeAccountId && !r.revoked && Date.parse(r.expiresAt) > now())) throw bad('Probe account already has an active qualification.', 409);
      if (!prior && Object.keys(aliases).length >= 128) throw bad('Qualification registry is full.', 429);
      const replayed = !!prior && prior.expiresAt === b.expiresAt;
      aliases[id] = { ...b, revoked: false, observation }; write(ALIASES, aliases);
      if (!replayed) store.audit('hub.qualification.stage', b.jobId);
      store.db.exec('COMMIT'); return { ok: true, replayed, expiresAt: b.expiresAt };
    } catch (e) { store.db.exec('ROLLBACK'); cache.clear(); throw e; }
  }
  function remove(b) {
    if (!common(b) || Object.keys(b).some(k => !['jobId','planHash','probeAccountId','stableNodeId'].includes(k))) throw bad('Invalid qualification revocation.');
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const aliases = { ...read(ALIASES) }, id = key(b), prior = aliases[id];
      if (prior && prior.planHash !== b.planHash) throw bad('Qualification operation changed.', 409);
      const replayed = !prior || prior.revoked === true;
      if (prior) { aliases[id] = { ...prior, revoked: true }; write(ALIASES, aliases); }
      if (!replayed) store.audit('hub.qualification.revoke', b.jobId);
      store.db.exec('COMMIT'); return { ok: true, replayed };
    } catch (e) { store.db.exec('ROLLBACK'); cache.clear(); throw e; }
  }
  function binding(hash) { return read(LEASES)[hash]; }
  function liveBinding(hash) {
    const b = binding(hash); if (!b) return null;
    const a = read(ALIASES)[b.aliasKey];
    if (!a || a.revoked || a.planHash !== b.planHash || a.candidateEndpoint !== b.candidateEndpoint || Date.parse(b.expiresAt) <= now()) throw bad('Qualification assignment expired. Open a new browsing session.', 410);
    return b;
  }
  function copyNode(selected, a) {
    if (!a?.observation || now() - a.observation.observedAt >= 45000) throw bad('Qualification node health expired.', 503);
    return { ...selected, endpoint: a.candidateEndpoint, seen: a.observation.observedAt, qualificationExpiresAt: Date.parse(a.expiresAt), qualificationCapabilities: a.observation.capabilities };
  }
  return {
    stage, remove,
    preferredNode: accountId => activeFor(accountId)?.stableNodeId || '',
    nodeForAccount(selected, accountId) { const a = activeFor(accountId); return a && selected?.id === a.stableNodeId ? copyNode(selected, a) : selected; },
    async refreshNode(id) {
      const aliases = { ...read(ALIASES) }; let healthy = false, changed = false;
      for (const [key, a] of Object.entries(aliases)) {
        if (a.stableNodeId !== id || a.revoked || Date.parse(a.expiresAt) <= now()) continue;
        try { const observation = await probe(a.candidateEndpoint, id); const current = read(ALIASES)[key];
          if (current && !current.revoked && current.candidateEndpoint === a.candidateEndpoint && current.expiresAt === a.expiresAt) { aliases[key] = { ...current, observation }; healthy = changed = true; }
        } catch {}
      }
      if (changed) { const current = { ...read(ALIASES) }; for (const [k, a] of Object.entries(aliases)) if (current[k] && !current[k].revoked && current[k].expiresAt === a.expiresAt) current[k] = a; write(ALIASES, current); }
      return healthy;
    },
    bindLease(hash, grant) {
      if (binding(hash)) { liveBinding(hash); return; }
      const a = activeFor(grant.userId); if (!a) return;
      const lease = store.db.prepare('SELECT node,generation FROM browse_leases WHERE hash=?').get(hash);
      if (lease?.node !== a.stableNodeId) throw bad('Probe account must open a new qualification session.', 409);
      const leases = prune(read(LEASES));
      if (Object.keys(leases).length >= 1024) throw bad('Qualification lease registry is full.', 429);
      leases[hash] = { ...a, generation: lease.generation }; write(LEASES, leases);
    },
    validLease(hash) { try { liveBinding(hash); return true; } catch { return false; } },
    expiresAt: hash => binding(hash) ? Date.parse(binding(hash).expiresAt) : Infinity,
    resolve(lease, selected) {
      const b = liveBinding(lease.hash); if (!b) return selected;
      const owner = store.db.prepare('SELECT user_id FROM hub_browse_owners WHERE lease_hash=?').get(lease.hash);
      if (!selected || selected.id !== b.stableNodeId || lease.generation !== b.generation || owner?.user_id !== b.probeAccountId || ![b.expectedCurrentEndpoint,b.candidateEndpoint].includes(selected.endpoint)) throw bad('Qualification assignment changed.', 410);
      const a = read(ALIASES)[b.aliasKey];
      return { ...copyNode(selected, a), qualificationExpiresAt: Date.parse(b.expiresAt) };
    },
  };
}
