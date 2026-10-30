/** Pure reduction of an immutable, acknowledged cloud revision. This does not
 * inspect running native data: a concurrent website save stays in its outbox. */
import { hubNamespace, type HubNamespace } from "./hub-contracts.ts";
import { replayProfileIDB } from "./profile-store.ts";

export type CompactableProfileStream = {
  revision: number;
  snapshotRevision: number;
  snapshot: unknown;
  journal: Array<{ revision: number; mode?: string; payload: any }>;
};
export function compactProfileStream(
  factory: Pick<IDBFactory, "cmp">,
  namespace: HubNamespace,
  stream: CompactableProfileStream,
): unknown {
  const key = hubNamespace(namespace);
  if (
    !Number.isSafeInteger(stream.revision) ||
    !Number.isSafeInteger(stream.snapshotRevision) ||
    stream.snapshotRevision < 0 ||
    stream.revision < stream.snapshotRevision ||
    !Array.isArray(stream.journal) ||
    stream.journal.length !== stream.revision - stream.snapshotRevision
  )
    throw Error("PROFILE_COMPACTION_STREAM_INVALID");
  for (let i = 0; i < stream.journal.length; i++)
    if (
      stream.journal[i]?.revision !== stream.snapshotRevision + i + 1 ||
      (stream.journal[i].mode !== undefined &&
        stream.journal[i].mode !== "journal")
    )
      throw Error("PROFILE_COMPACTION_STREAM_INVALID");
  if (namespace.kind === "idb")
    return replayProfileIDB(
      factory as IDBFactory,
      stream.snapshot,
      stream.journal,
    );
  if (namespace.kind === "local") {
    const value =
      stream.snapshot == null
        ? { format: "atlas-local-snapshot-v1", revision: 0, entries: [] }
        : (structuredClone(stream.snapshot) as any);
    if (
      value.format !== "atlas-local-snapshot-v1" ||
      !Array.isArray(value.entries) ||
      value.entries.some(
        (e: any) =>
          !Array.isArray(e) ||
          e.length !== 2 ||
          e.some((v: any) => typeof v !== "string"),
      )
    )
      throw Error("PROFILE_LOCAL_SNAPSHOT_INVALID");
    const entries = new Map<string, string>(value.entries);
    for (const { payload: p } of stream.journal) {
      const c = p?.change;
      if (
        !c ||
        !["set", "remove", "clear"].includes(c.op) ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 0
      )
        throw Error("PROFILE_LOCAL_JOURNAL_INVALID");
      if (c.op === "clear") entries.clear();
      else if (typeof c.key !== "string")
        throw Error("PROFILE_LOCAL_JOURNAL_INVALID");
      else if (c.op === "remove") entries.delete(c.key);
      else if (typeof c.value === "string") entries.set(c.key, c.value);
      else throw Error("PROFILE_LOCAL_JOURNAL_INVALID");
      value.revision = p.revision;
    }
    return { ...value, entries: [...entries] };
  }
  if (namespace.kind === "cookies") {
    const value =
      stream.snapshot == null
        ? { format: "atlas-cookie-snapshot-v1", revision: 0, cookies: [] }
        : (structuredClone(stream.snapshot) as any);
    if (
      value.format !== "atlas-cookie-snapshot-v1" ||
      !Array.isArray(value.cookies)
    )
      throw Error("PROFILE_COOKIE_SNAPSHOT_INVALID");
    const cookies = new Map<string, any>(
      value.cookies.map((c: any) => [c.id, c]),
    );
    for (const { payload: p } of stream.journal) {
      if (
        !Array.isArray(p?.changes) ||
        !Number.isSafeInteger(p.revision) ||
        p.revision < 0
      )
        throw Error("PROFILE_COOKIE_JOURNAL_INVALID");
      for (const c of p.changes) {
        if (!c?.cookie || typeof c.cookie.id !== "string")
          throw Error("PROFILE_COOKIE_JOURNAL_INVALID");
        if (c.op === "delete") cookies.delete(c.cookie.id);
        else if (c.op === "set")
          cookies.set(c.cookie.id, structuredClone(c.cookie));
        else throw Error("PROFILE_COOKIE_JOURNAL_INVALID");
      }
      value.revision = p.revision;
    }
    // Do not expire or rewrite session cookies during reduction. Restore applies
    // its normal clock/session policy, identically before and after compaction.
    for (const c of cookies.values()) {
      if (
        typeof c.domain !== "string" ||
        hubNamespace({ kind: "cookies", origin: "https://" + c.domain })
          .siteGroup !== key.siteGroup ||
        c.id !==
          JSON.stringify([c.partition, c.domain, c.hostOnly, c.path, c.name])
      )
        throw Error("PROFILE_COOKIE_NAMESPACE_INVALID");
    }
    return { ...value, cookies: [...cookies.values()] };
  }
  throw Error("PROFILE_COMPACTION_KIND_UNSUPPORTED");
}
