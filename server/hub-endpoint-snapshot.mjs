/** Fixed, read-only cutover inventory. Never exposes credentials or accepts a
 * caller-selected target. A corrupt entry fails the complete snapshot rather
 * than silently hiding a peer which must survive endpoint replacement. */
const unavailable = () => Object.assign(Error('Coordinator endpoint snapshot is unavailable.'), { statusCode: 503 });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value >= 1;
const origin = value => {
  try { const u = new URL(value); if (u.protocol === 'https:' && u.origin === value && !u.username && !u.password) return u.origin; } catch {}
  throw unavailable();
};
export function coordinatorEndpointSnapshot({ config, store, requestOrigin, now = Date.now }) {
  let begun = false;
  try {
    store.db.exec('BEGIN'); begun = true;
    const revision = store.get('hubEndpointRevision');
    const generation = revision == null ? 0 : revision.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) throw unavailable();
    const hubOrigin = origin(store.get('hubCurrentOrigin') || config.hubOrigin);
    const rows = store.db.prepare("SELECT id,endpoint FROM nodes WHERE id!='local' ORDER BY id").all();
    if (rows.length > 10000 || rows.some(row => typeof row.id !== 'string' || !row.id || row.id.length > 100)) throw unavailable();
    const nodes = rows.map(row => ({ id: row.id, endpoint: origin(row.endpoint) }));
    const registry = store.get('hubBranchRegistry') || {};
    if (typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).length > 10000) throw unavailable();
    const byOrigin = new Map();
    function branch(rawOrigin, entry, sealed) {
      const o = origin(rawOrigin), generation = entry?.generation ?? 1;
      if (!uuid(entry?.id) || !token(entry?.secret) || !positive(generation)) throw unavailable();
      let transitionRevision = 0, transitionActive = false;
      if (sealed && entry.transition !== undefined) {
        if (!entry.transition || !positive(entry.transition.revision) || typeof entry.transition.active !== 'boolean') throw unavailable();
        transitionRevision = entry.transition.revision; transitionActive = entry.transition.active;
      }
      return { origin: o, id: entry.id, generation, transitionRevision, transitionActive };
    }
    for (const entry of config.hubBranches || []) {
      const value = branch(entry.origin, entry, false);
      // branchFor uses the first configured entry; a sealed registry overrides.
      if (!byOrigin.has(value.origin)) byOrigin.set(value.origin, value);
    }
    if (uuid(config.hubBranchId) && token(config.hubBranchSecret) && !byOrigin.has(origin(config.appOrigin)))
      byOrigin.set(origin(config.appOrigin), branch(config.appOrigin, { id: config.hubBranchId, secret: config.hubBranchSecret, generation: 1 }, false));
    for (const [o, sealed] of Object.entries(registry)) byOrigin.set(origin(o), branch(o, JSON.parse(store.unseal(sealed)), true));
    if (byOrigin.size > 10000) throw unavailable();
    const branches = [...byOrigin.values()].sort((a, b) => a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
    const value = { format: 'atlas-coordinator-endpoint-snapshot-v1', origin: origin(requestOrigin), observedAt: new Date(now()).toISOString(), generation, hubOrigin, nodes, branches };
    store.db.exec('COMMIT'); begun = false;
    return value;
  } catch {
    if (begun) try { store.db.exec('ROLLBACK'); } catch {}
    throw unavailable();
  }
}
