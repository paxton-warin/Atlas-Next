/** Private, owned visible-cookie state. Only strings and the next expiry leave
 * this object. Native message/AEAD ingress is still validated independently;
 * previously accepted entries are not enumerated/revalidated for every setter.
 * Copies contain frozen primitives, never aliases to caller-owned entries. */
import {
  validateCookieViewEntries,
  validateCookieViewDelta,
  type CookieViewEntry,
  type CookieViewDelta,
} from "./sandbox-cookie-result.ts";
const own = Object.getOwnPropertyDescriptor,
  keys = Object.keys,
  create = Object.create,
  freeze = Object.freeze,
  isArray = Array.isArray,
  apply = Reflect.apply,
  sort = Array.prototype.sort,
  join = Array.prototype.join,
  compare = String.prototype.localeCompare,
  PrivateMap = Map,
  get = Map.prototype.get,
  has = Map.prototype.has,
  set = Map.prototype.set,
  remove = Map.prototype.delete,
  clear = Map.prototype.clear,
  each = Map.prototype.forEach;
const fields = ["id", "name", "value", "path", "created", "expiresAt"] as const;
function copyEntry(input: unknown): CookieViewEntry {
  if (!input || typeof input !== "object" ||
      keys(input).some(key => !(fields as readonly string[]).includes(key)))
    throw new DOMException("Invalid visible cookie entry", "SecurityError");
  const result = create(null) as CookieViewEntry;
  for (const key of fields) {
    const descriptor = own(input, key);
    if (!descriptor || !("value" in descriptor))
      throw new DOMException("Accessor-backed cookie entry", "SecurityError");
    (result as any)[key] = descriptor.value;
  }
  if (!validateCookieViewEntries([result]))
    throw new DOMException("Invalid visible cookie entry", "SecurityError");
  return freeze(result);
}
function same(a: CookieViewEntry, b: CookieViewEntry) {
  return a.id === b.id && a.name === b.name && a.value === b.value &&
    a.path === b.path && a.created === b.created && a.expiresAt === b.expiresAt;
}
export function createPrivateCookieLocalView() {
  let rows = new PrivateMap<string, CookieViewEntry>(), count = 0,
    value = "", expiresAt: number | null = null;
  const rebuild = (now: number) => {
    const ordered: CookieViewEntry[] = [];
    expiresAt = null;
    apply(each, rows, [(entry: CookieViewEntry, id: string) => {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        apply(remove, rows, [id]); count--; return;
      }
      ordered[ordered.length] = entry;
      if (entry.expiresAt !== null)
        expiresAt = expiresAt === null ? entry.expiresAt : Math.min(expiresAt, entry.expiresAt);
    }]);
    apply(sort, ordered, [(a: CookieViewEntry, b: CookieViewEntry) =>
      b.path.length - a.path.length || a.created - b.created || apply(compare, a.id, [b.id])]);
    const parts: string[] = [];
    for (const entry of ordered)
      parts[parts.length] = entry.name ? entry.name + "=" + entry.value : entry.value;
    value = apply(join, parts, ["; "]);
  };
  return freeze({
    replace(input: CookieViewEntry[], now: number) {
      if (!isArray(input) || input.length > 180)
        throw new DOMException("Invalid cookie snapshot", "SecurityError");
      const next = new PrivateMap<string, CookieViewEntry>();
      for (let index = 0; index < input.length; index++) {
        const entry = copyEntry(input[index]);
        if (apply(has, next, [entry.id]))
          throw new DOMException("Duplicate cookie snapshot identity", "SecurityError");
        apply(set, next, [entry.id, entry]);
      }
      rows = next; count = input.length; rebuild(now);
      return value;
    },
    update(input: CookieViewDelta, now: number) {
      if (!validateCookieViewDelta(input))
        throw new DOMException("Invalid cookie delta", "SecurityError");
      const upsert = input.upsert.length ? copyEntry(input.upsert[0]) : undefined,
        id = input.remove[0];
      if (id !== undefined && (typeof id !== "string" || id.length > 32768))
        throw new DOMException("Invalid cookie removal identity", "SecurityError");
      if (expiresAt !== null && expiresAt <= now) rebuild(now);
      const nextCount = count - (id !== undefined && apply(has, rows, [id]) ? 1 : 0) +
        (upsert && (!apply(has, rows, [upsert.id]) || upsert.id === id) ? 1 : 0);
      if (nextCount > 180)
        throw new DOMException("Cookie view exceeds its local allowance", "QuotaExceededError");
      let changed = false;
      if (id !== undefined && apply(remove, rows, [id])) { count--; changed = true; }
      if (upsert) {
        const previous = apply(get, rows, [upsert.id]) as CookieViewEntry | undefined;
        if (!previous || !same(previous, upsert)) {
          if (!previous) count++;
          apply(set, rows, [upsert.id, upsert]); changed = true;
        }
      }
      if (changed) rebuild(now);
      return value;
    },
    get expiresAt() { return expiresAt; },
    clear() { apply(clear, rows, []); count = 0; value = ""; expiresAt = null; },
  });
}
