/** Bounded in-flight work only: successful grants are cached by the caller's
 * existing expiry rules. Revocation invalidates an in-flight result as well. */
export function createIdentityVerification({ maxPending = 2048 } = {}) {
  const flights = new Map();
  let closed = false;
  return {
    async run(key, verify) {
      if (closed) throw Object.assign(Error('Hub verification is closed.'), { statusCode: 503 });
      const prior = flights.get(key);
      if (prior) return prior.promise;
      if (flights.size >= maxPending)
        throw Object.assign(Error('Hub verification is busy. Retry shortly.'), { statusCode: 503, code: 'HUB_UNAVAILABLE' });
      const item = { invalidated: false };
      item.promise = Promise.resolve().then(verify).then(value => {
        if (closed || item.invalidated) throw Object.assign(Error('Hub session is no longer current.'), { statusCode: 401, code: 'HUB_SESSION_EXPIRED' });
        return value;
      }).finally(() => { if (flights.get(key) === item) flights.delete(key); });
      flights.set(key, item);
      return item.promise;
    },
    invalidate(key) { const item = flights.get(key); if (item) item.invalidated = true; },
    close() { closed = true; for (const item of flights.values()) item.invalidated = true; },
    pending: () => flights.size,
  };
}
