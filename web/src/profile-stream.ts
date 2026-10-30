import { HUB_LIMITS, type HubNamespace } from "../../runtime/hub-contracts.ts";
type Journal = { revision: number; mode?: string; payload: unknown };
export type ProfileStream = {
  revision: number;
  snapshotRevision: number;
  snapshot: unknown;
  journal: Journal[];
  hasMore?: boolean;
  nextAfter?: number;
};
export type ProfileStreamHead = {
  revision: number;
  snapshotRevision: number;
  restoreBytes: number;
  snapshotBytes: number;
};
/** Metadata-only existing protocol request. The caller must still validate its
 * durable native head and writer epoch before reusing an unchanged stream. */
export async function loadProfileStreamHead(
  request: (body: Record<string, unknown>) => Promise<unknown>,
  namespace: HubNamespace,
): Promise<ProfileStreamHead> {
  const value = await request({ namespace, headOnly: true });
  if (!value || typeof value !== "object") throw Error("PROFILE_STREAM_HEAD_INVALID");
  const head = value as ProfileStreamHead;
  if (
    !Number.isSafeInteger(head.revision) ||
    !Number.isSafeInteger(head.snapshotRevision) ||
    head.snapshotRevision < 0 || head.revision < head.snapshotRevision ||
    !Number.isSafeInteger(head.restoreBytes) || head.restoreBytes < 0 ||
    !Number.isSafeInteger(head.snapshotBytes) || head.snapshotBytes < 0
  ) throw Error("PROFILE_STREAM_HEAD_INVALID");
  return {
    revision: head.revision, snapshotRevision: head.snapshotRevision,
    restoreBytes: head.restoreBytes, snapshotBytes: head.snapshotBytes,
  };
}
/** Collect one pinned history before exposing it to atomic native restoration.
 * A concurrent checkpoint requires a fresh attempt, never a partial restore. */
export async function loadProfileStream(
  request: (body: Record<string, unknown>) => Promise<ProfileStream>,
  namespace: HubNamespace,
  maxBytes = HUB_LIMITS.streamBytes,
): Promise<ProfileStream> {
  const first = await request({ namespace });
  const { revision, snapshotRevision } = first;
  if (
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(snapshotRevision) ||
    snapshotRevision < 0 ||
    revision < snapshotRevision
  )
    throw Error("PROFILE_STREAM_HEAD_INVALID");
  let after = snapshotRevision,
    bytes = 0,
    pages = 0;
  const measure = (value: unknown) => {
    if (value === null) return 0;
    const v = value as { codec?: string; bytes?: number };
    if (v?.codec === "atlas-chunks-v1") {
      if (!Number.isSafeInteger(v.bytes) || v.bytes! < 0)
        throw Error("PROFILE_STREAM_BYTES_INVALID");
      return v.bytes!;
    }
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  };
  bytes += measure(first.snapshot);
  let page = first;
  const journal: Journal[] = [];
  for (;;) {
    if (
      ++pages > 100000 ||
      page.revision !== revision ||
      page.snapshotRevision !== snapshotRevision ||
      !Array.isArray(page.journal) ||
      page.journal.length > 1000 ||
      (page !== first && page.snapshot !== null)
    )
      throw Error("PROFILE_STREAM_PAGE_INVALID");
    for (const entry of page.journal) {
      if (!entry || entry.revision !== after + 1 || entry.revision > revision)
        throw Error("PROFILE_STREAM_ORDER_INVALID");
      bytes += measure(entry.payload);
      if (bytes > maxBytes) throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
      journal.push(entry);
      after = entry.revision;
    }
    if (bytes > maxBytes) throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
    if (!page.hasMore) {
      if (after !== revision) throw Error("PROFILE_STREAM_INCOMPLETE");
      return { revision, snapshotRevision, snapshot: first.snapshot, journal };
    }
    if (page.nextAfter !== after || !page.journal.length || after >= revision)
      throw Error("PROFILE_STREAM_CURSOR_INVALID");
    page = await request({
      namespace,
      after,
      targetRevision: revision,
      snapshotRevision,
    });
  }
}
