/** A bounded preference-CAS retry can merge only edits whose meaning is known.
 * This helper neither writes storage nor invents acknowledgement/ownership. */
export type PreferenceChange = { key: string; base: string | null; value: string | null };
type HistoryEntry = { url: string; title: string; time: number };
const singletonKeys = new Set([
  "atlas.settings", "atlas.shortcuts", "atlas.history", "atlas.chats",
  "atlas.onboarded", "atlas.sidebarCollapsed", "atlas.ai.geminiConsent", "atlas.tabs",
]);
const knownKey = (key: string) => singletonKeys.has(key) ||
  /^atlas\.windows\.v1\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key);
const ownObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
function history(raw: string | null): HistoryEntry[] | undefined {
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(value) || value.length > 100) return;
  const seen = new Set<string>();
  const result: HistoryEntry[] = [];
  for (const entry of value) {
    if (!ownObject(entry) || Object.keys(entry).length !== 3 ||
        typeof entry.url !== "string" || typeof entry.title !== "string" ||
        typeof entry.time !== "number" || !Number.isSafeInteger(entry.time) || entry.time < 0 ||
        seen.has(entry.url)) return;
    try {
      const url = new URL(entry.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    } catch { return; }
    if (result.length && entry.time > result[result.length - 1].time) return;
    seen.add(entry.url);
    result.push({ url: entry.url, title: entry.title, time: entry.time });
  }
  return result;
}
/** Missing entries are deletions, except the actual MRU's oldest-tail trimming
 * when a full 100-item list receives new URLs. Revisited entries moved to its
 * front are excluded from that old-tail check. */
function additive(base: HistoryEntry[], next: HistoryEntry[]) {
  const values = new Map(next.map(entry => [entry.url, entry]));
  let missing = false;
  for (const prior of base) {
    const current = values.get(prior.url);
    if (!current) {
      missing = true;
      // At capacity, a pruned base entry must actually be older than the
      // retained MRU frontier; clock-skewed/deleted lists are not guessed at.
      if (next.length && prior.time > next[next.length - 1].time) return false;
      continue;
    }
    if (current.time < prior.time ||
        (current.time === prior.time && current.title !== prior.title)) return false;
    if (current.time > prior.time) continue; // an ordinary revisit changes MRU position
    if (missing) return false; // a middle deletion is not normal oldest-tail trimming
  }
  return !missing || (base.length === 100 && next.length === 100);
}
function mergeHistory(base: HistoryEntry[], local: HistoryEntry[], remote: HistoryEntry[]) {
  // A clear or removal cannot silently resurrect another context's old data.
  if (!local.length || !remote.length || !additive(base, local) || !additive(base, remote)) return;
  const values = new Map(remote.map(entry => [entry.url, entry]));
  for (const entry of local) {
    const prior = values.get(entry.url);
    if (!prior || entry.time > prior.time) values.set(entry.url, entry);
    else if (entry.time === prior.time && entry.title !== prior.title) return;
  }
  // Stable timestamp ties retain the authoritative list's relative order.
  return [...values.values()].sort((a, b) => b.time - a.time).slice(0, 100);
}
/** Rebase one failed CAS after an authoritative GET. Every returned entry uses
 * that exact current base, including convergent/no-op entries, so the caller can
 * obtain a real positive POST acknowledgement with a fresh idempotency key.
 * Genuine conflicts return null and leave their local version untouched. */
export function rebasePreferenceChanges(
  changes: PreferenceChange[],
  canonical: Record<string, string>,
): PreferenceChange[] | null {
  if (!Array.isArray(changes) || changes.length > 1000 || !ownObject(canonical)) return null;
  const seen = new Set<string>(), result: PreferenceChange[] = [];
  for (const change of changes) {
    if (!ownObject(change)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(change);
    if (Object.keys(descriptors).length !== 3 ||
        ["key", "base", "value"].some(key => !descriptors[key] || !("value" in descriptors[key]))) return null;
    const { key, base, value } = change;
    if (typeof key !== "string" || !knownKey(key) || seen.has(key) ||
        !(base === null || typeof base === "string") ||
        !(value === null || typeof value === "string")) return null;
    seen.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(canonical, key);
    if (descriptor && !("value" in descriptor)) return null;
    const current = descriptor ? descriptor.value : null;
    if (!(current === null || typeof current === "string")) return null;
    let next = value;
    let histories: [HistoryEntry[], HistoryEntry[], HistoryEntry[]] | undefined;
    if (key === "atlas.history") {
      const before = history(base), local = history(value), remote = history(current);
      if (!before || !local || !remote) return null;
      histories = [before, local, remote];
    }
    if (current !== base && current !== value) {
      if (!histories) return null;
      const merged = mergeHistory(...histories);
      if (!merged) return null;
      next = JSON.stringify(merged);
    }
    result.push({ key, base: current, value: next });
  }
  return result;
}
