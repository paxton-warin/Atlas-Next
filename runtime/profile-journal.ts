/** Trusted native-store outbox. An acknowledgement means local IDB committed,
 * never that remote profile storage has received this entry. */
export const PROFILE_OUTBOX_PREFIX = "outbox:";
export const PROFILE_OUTBOX_BYTES = "profile-outbox-bytes";
export const PROFILE_OUTBOX_SEQUENCE = "profile-outbox-sequence";
export const PROFILE_OUTBOX_LIMIT = 32 * 1024 * 1024;
export const PROFILE_IDB_KEEP = "__atlas_idb_keepalive_v2__";
export type ProfileJournalEntry = {
  id: string;
  sequence: number;
  profileId: string;
  kind: "local" | "idb" | "cookies";
  origin: string;
  name?: string;
  createdAt: number;
  payload: unknown;
  bytes: number;
};
export function checkedProfile(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new TypeError("Invalid profile identity");
  return value;
}
export function profileDatabaseName(
  base: string,
  profileId?: string | null,
): string {
  const id = checkedProfile(profileId);
  return id ? base + ":profile:" + id : base;
}
export function profileIDBPrefix(
  origin: string,
  profileId?: string | null,
): string {
  const id = checkedProfile(profileId);
  return (
    "atlas.browsing.idb.v2:" +
    (id ? "profile:" + id + ":" : "") +
    encodeURIComponent(new URL(origin).origin) +
    ":"
  );
}
const transactions = new WeakMap<
  IDBTransaction,
  Map<
    string,
    {
      loaded: boolean;
      bytes: number;
      sequence: number;
      pending: ProfileJournalEntry[];
    }
  >
>();
/** Append in the data mutation's live transaction. Capacity AND monotonic source
 * sequence are transactional, including concurrent tabs and multiple operations
 * within one transaction. Abort rolls back data/counter/journal together. */
export function appendProfileJournal(
  store: IDBObjectStore,
  input: Omit<ProfileJournalEntry, "id" | "createdAt" | "sequence">,
  keyMode: "string" | "array" = "string",
) {
  checkedProfile(input.profileId);
  if (
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    input.bytes > PROFILE_OUTBOX_LIMIT
  )
    throw new DOMException(
      "Profile outbox payload exceeds allowance",
      "QuotaExceededError",
    );
  const entry: ProfileJournalEntry = {
    ...input,
    id: crypto.randomUUID(),
    sequence: 0,
    createdAt: Date.now(),
  };
  let stores = transactions.get(store.transaction);
  if (!stores) {
    stores = new Map();
    transactions.set(store.transaction, stores);
  }
  let state = stores.get(store.name);
  const counter = keyMode === "array" ? ["outbox-bytes"] : PROFILE_OUTBOX_BYTES;
  const serial =
    keyMode === "array" ? ["outbox-sequence"] : PROFILE_OUTBOX_SEQUENCE;
  const flush = () => {
    for (const next of state!.pending.splice(0)) {
      const total = state!.bytes + next.bytes;
      if (
        !Number.isSafeInteger(total) ||
        total > PROFILE_OUTBOX_LIMIT ||
        state!.sequence >= Number.MAX_SAFE_INTEGER
      ) {
        store.transaction.abort();
        return;
      }
      state!.bytes = total;
      next.sequence = ++state!.sequence;
      store.put(
        next,
        keyMode === "array"
          ? ["outbox", next.id]
          : PROFILE_OUTBOX_PREFIX + next.id,
      );
    }
    store.put(state!.bytes, counter);
    store.put(state!.sequence, serial);
  };
  if (state) {
    state.pending.push(entry);
    if (state.loaded) flush();
    return entry;
  }
  state = { loaded: false, bytes: 0, sequence: 0, pending: [entry] };
  stores.set(store.name, state);
  const bytes = store.get(counter),
    sequence = store.get(serial);
  sequence.onsuccess = () => {
    state!.loaded = true;
    state!.bytes = Number(bytes.result || 0);
    state!.sequence = Number(sequence.result || 0);
    flush();
  };
  return entry;
}
