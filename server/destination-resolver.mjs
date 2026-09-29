import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export function isPublicIp(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

// Share validated DNS answers across streams, never across runtime instances.
// Socket.connect receives these same addresses; it must not resolve again.
export function createDestinationResolver({
  lookup = systemLookup,
  now = Date.now,
  ttlMs = 10_000,
  timeoutMs = 8_000,
  maxEntries = 512,
  maxPending = 256,
} = {}) {
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isInteger(maxPending) ||
    maxPending < 1
  )
    throw Error("Invalid DNS resolver limits.");
  const cache = new Map();
  const pending = new Map();
  let activeLookups = 0;
  const copy = (addresses) => addresses.map((address) => ({ ...address }));

  return async function resolveDestination(
    hostname,
    { allowPrivate = false } = {},
  ) {
    const key = `${allowPrivate ? "fixture" : "public"}:${hostname.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      cache.delete(key);
      cache.set(key, cached);
      return copy(cached.addresses);
    }
    cache.delete(key);
    if (pending.has(key)) return copy(await pending.get(key));
    // Count underlying OS requests until they settle, even after our deadline.
    // dns.lookup has no cancellation API; timed-out work must stay bounded too.
    if (activeLookups >= maxPending)
      throw Object.assign(Error("DNS resolver busy. Retry shortly."), {
        code: "EAI_AGAIN",
      });

    activeLookups++;
    const request = Promise.resolve()
      .then(() => lookup(hostname, { all: true }))
      .finally(() => activeLookups--);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(Error("DNS lookup timed out."), {
              code: "ETIMEDOUT",
            }),
          ),
        timeoutMs,
      );
    });
    const result = Promise.race([request, deadline])
      .then((addresses) => {
        if (
          !addresses.length ||
          addresses.some(
            (record) =>
              ![4, 6].includes(record.family) ||
              typeof record.address !== "string" ||
              isIP(record.address) !== record.family ||
              (!allowPrivate && !isPublicIp(record.address)),
          )
        )
          throw Error("Destination rejected");
        const validated = copy(addresses);
        // Expiry starts after successful resolution, not before a slow lookup.
        for (const [host, entry] of cache)
          if (entry.expires <= now()) cache.delete(host);
        cache.set(key, { addresses: validated, expires: now() + ttlMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return validated;
      })
      .finally(() => {
        clearTimeout(timer);
        pending.delete(key);
      });
    pending.set(key, result);
    return copy(await result);
  };
}
