/** Serialize each authenticated node's full control snapshots. Requests join
 * the next unsent batch, and complete when that batch reaches the node. Later
 * arrivals cannot keep earlier callers waiting for the entire queue to idle.
 * No authority is cached: snapshot() reads current leases at send time. */
export function createNodeControlDispatch({ snapshot, send, maxPending = 256 }) {
  const flights = new Map();
  const counts = { sent: 0, coalesced: 0, failed: 0, rejected: 0 };
  let closed = false;
  function batch() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function request(target) {
    if (closed) return Promise.reject(Error('Node control is closed.'));
    const key = target.id + '\0' + target.endpoint;
    let entry = flights.get(key);
    if (entry) {
      entry.target = target;
      if (!entry.queued) entry.queued = batch();
      counts.coalesced++;
      return entry.queued.promise;
    }
    if (flights.size >= maxPending) {
      counts.rejected++;
      return Promise.reject(Error('Node control is busy.'));
    }
    const completion = batch();
    entry = { target, queued: completion, active: null, abort: new AbortController() };
    flights.set(key, entry);
    entry.drain = Promise.resolve().then(async () => {
      try {
        while (entry.queued && !closed) {
          const current = entry.queued;
          entry.queued = null;
          entry.active = current;
          const selected = entry.target;
          const state = snapshot(selected);
          counts.sent++;
          await send(selected, state, entry.abort.signal);
          if (closed) throw Error('Node control is closed.');
          current.resolve();
          entry.active = null;
        }
        if (closed) throw Error('Node control is closed.');
      } catch (error) {
        counts.failed++;
        entry.active?.reject(error);
        entry.queued?.reject(error);
        entry.active = entry.queued = null;
      } finally {
        // Delete synchronously before resolved batch consumers can re-enter.
        // A separate Promise.finally would leave a lost-request microtask gap.
        if (flights.get(key) === entry) flights.delete(key);
      }
    });
    return completion.promise;
  }
  return {
    request,
    stats: () => ({ pending: flights.size, ...counts }),
    async close() {
      closed = true;
      for (const entry of flights.values()) entry.abort.abort();
      await Promise.allSettled([...flights.values()].map(entry => entry.drain));
      flights.clear();
    },
  };
}
