/** Process-local stable coordinator override. Never rewrites node.json or
 * sends a new origin credential to an inherited rotating public endpoint. */
export function nodeControlSettings(env = process.env) {
  const raw = env.ATLAS_COORDINATOR_ORIGIN?.trim() || '', key = env.ATLAS_COORDINATOR_ORIGIN_KEY || '';
  if (key && !raw) throw Error('A stable coordinator origin is required with its origin key.');
  if (!raw) return Object.freeze({ origin: null, originKey: null });
  let u; try { u = new URL(raw); } catch { throw Error('Invalid stable coordinator origin.'); }
  if (u.protocol !== 'https:' || u.origin !== raw || u.username || u.password) throw Error('Invalid stable coordinator origin.');
  if (key && (!/^[\x21-\x7e]{16,512}$/.test(key))) throw Error('Invalid coordinator origin header.');
  return Object.freeze({ origin: u.origin, originKey: key || null });
}
export function nodeHeartbeatRequest(credentials, connections, settings) {
  const url = new URL('/api/nodes/heartbeat', settings.origin || credentials.control);
  const headers = { 'Content-Type': 'application/json', authorization: 'Bearer ' + credentials.secret };
  if (settings.originKey) headers['X-Atlas-Origin-Key'] = settings.originKey;
  return { url, init: { method: 'POST', headers, body: JSON.stringify({ id: credentials.id, connections }), signal: AbortSignal.timeout(6000), redirect: 'error' } };
}
