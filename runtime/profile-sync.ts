import { maybeCompactProfileStream, resumeProfileCompaction, portableWireBytes, type ProfileCompactionPlan, type ProfileCloudStreamHead } from "./profile-compaction-sync.ts";
import { listProfileIDBDatabases, profileCatalogName, openProfileCatalog, scheduleProfileDeleteRecovery } from "./profile-idb-catalog.ts";
import {
  HUB_LIMITS,
  encodePortableValue,
  hubNamespace,
  hubSiteGroup,
  type HubNamespace,
} from "./hub-contracts.ts";
import {
  checkedProfile,
  PROFILE_IDB_KEEP,
  PROFILE_OUTBOX_BYTES,
  PROFILE_OUTBOX_PREFIX,
  type ProfileJournalEntry,
} from "./profile-journal.ts";

export type CloudHead = { revision: number; epoch: number };
export type QueuedProfileChange = {
  entry: ProfileJournalEntry & { sequence?: number };
  database: string;
  store: string;
  key: IDBValidKey;
  arrayKeys: boolean;
  /** Worker-produced selection metadata, never an encodable journal payload. */
  payloadOmitted?: true;
  namespace?: HubNamespace;
};
export type ProfileCloud = {
  /** Reuse only heads positively ACKed and durably adopted during this drain.
   * Commit CAS/epoch checks remain authoritative; uncertain retries refetch. */
  reuseAcknowledgedHeads?: boolean;
  encode?(value:unknown):Promise<unknown>;
  /** Read the exact immutable native outbox payload inside its worker. */
  encodeChange?(change:QueuedProfileChange):Promise<unknown>;
  receipt?(
    id: string,
  ): Promise<{
    acknowledged: boolean;
    namespace: unknown;
    payloadHash: string;
    mode: string;
    revision: number;
  } | null>;
  writer(
    namespace: HubNamespace,
  ): Promise<{ epoch: number; expiresAt: string }>;
  stream(namespace: HubNamespace): Promise<ProfileCloudStreamHead>;
  snapshot?(namespace: HubNamespace, expectedRevision: number): Promise<{ revision: number; payload: unknown; encoded?: boolean }>;
  commit(input: {
    namespace: HubNamespace;
    epoch: number;
    baseRevision: number;
    idempotencyKey: string;
    mode: "journal" | "snapshot";
    payload: unknown;
  }): Promise<{ acknowledged: boolean; revision: number }>;
};
export type ProfileQueue = {
  list(siteGroup?: string): Promise<QueuedProfileChange[]>;
  metadata?(siteGroup?: string): Promise<QueuedProfileChange[]>;
  payload?(change: QueuedProfileChange): Promise<unknown>;
  compaction?(change: QueuedProfileChange): Promise<ProfileCompactionPlan | null>;
  prepareCompaction?(change: QueuedProfileChange, plan: ProfileCompactionPlan): Promise<void>;
  finishCompaction?(change: QueuedProfileChange, plan: ProfileCompactionPlan): Promise<void>;
  head(change: QueuedProfileChange): Promise<CloudHead | null>;
  /** Null means no remote write was attempted: prepare must commit durably
   * before commit is sent, and remain until acknowledge removes the change. */
  prepared?(change: QueuedProfileChange): Promise<CloudHead | null>;
  prepare?(change: QueuedProfileChange, head: CloudHead): Promise<void>;
  acknowledge(change: QueuedProfileChange, head: CloudHead): Promise<void>;
};
export function changeNamespace(change: QueuedProfileChange): HubNamespace {
  const e = change.entry,
    u = new URL(e.origin);
  if (
    !/^https?:$/.test(u.protocol) ||
    u.origin !== e.origin ||
    u.username ||
    u.password
  )
    throw Error("PROFILE_NAMESPACE_INVALID");
  if (change.payloadOmitted === true) {
    const namespace: HubNamespace = { kind: e.kind, origin: u.origin, ...(e.kind === "idb" ? { name: e.name || "" } : {}) };
    if (e.payload !== undefined || !change.namespace || hubNamespace(change.namespace).key !== hubNamespace(namespace).key)
      throw Error("PROFILE_QUEUE_REFERENCE_INVALID");
    return namespace;
  }
  if (e.kind === "cookies") {
    const changes = (
      e.payload as { changes?: { cookie?: { domain?: string } }[] }
    )?.changes;
    if (
      !Array.isArray(changes) ||
      changes.some((c) => {
        const domain = c.cookie?.domain?.replace(/^\./, "");
        try {
          return (
            !domain ||
            hubSiteGroup("https://" + domain) !== hubSiteGroup(u.origin)
          );
        } catch {
          return true;
        }
      })
    )
      throw Error("PROFILE_COOKIE_PARTITION_REQUIRED");
  }
  return {
    kind: e.kind,
    origin: u.origin,
    ...(e.kind === "idb" ? { name: e.name || "" } : {}),
  };
}
type AcknowledgedStreamHead = { head: CloudHead; remote: ProfileCloudStreamHead };
function advancedAcknowledgedHead(
  remote: ProfileCloudStreamHead,
  epoch: number,
  payload: unknown,
): AcknowledgedStreamHead | undefined {
  // Production metadata counts encoded restore payload bytes, including chunk
  // manifest logical bytes. Missing/invalid legacy metadata never enables reuse.
  const { revision, snapshotRevision, restoreBytes, snapshotBytes } = remote;
  if (![revision, snapshotRevision, restoreBytes, snapshotBytes].every(value =>
        Number.isSafeInteger(value) && value! >= 0) ||
      snapshotRevision! > revision || snapshotBytes! > restoreBytes! ||
      restoreBytes! > HUB_LIMITS.streamBytes || !Number.isSafeInteger(revision + 1)) return;
  let incoming: number;
  try { incoming = portableWireBytes(payload); } catch { return; }
  const nextBytes = restoreBytes! + incoming;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > HUB_LIMITS.streamBytes) return;
  return { head: { revision: revision + 1, epoch },
    remote: { revision: revision + 1, snapshotRevision, restoreBytes: nextBytes, snapshotBytes } };
}
/** Drains already-committed native transactions, never acknowledging a local
 * save on the strength of an attempted HTTP request. Unknown cloud heads and
 * changed fencing epochs require restoration/recovery, not last-write-wins. */
export async function drainProfileQueue(
  queue: ProfileQueue,
  cloud: ProfileCloud,
  now = Date.now,
): Promise<number> {
  let acknowledged = 0;
  const acknowledgedHeads = new Map<string, AcknowledgedStreamHead>();
  const changes = await queue.list();
  for (const change of changes) {
    for (;;) {
      await resumeProfileCompaction(change, queue, cloud, now);
      const namespace = changeNamespace(change);
      const head = await queue.head(change);
      const prepared = await queue.prepared?.(change);
      if (change.payloadOmitted && !cloud.encodeChange) throw Error("PROFILE_QUEUE_PAYLOAD_REQUIRED");
      const payload = cloud.encodeChange ? await cloud.encodeChange(change) : cloud.encode ? await cloud.encode(change.entry.payload) : await encodePortableValue(change.entry.payload);
      // A durable absence of preparation proves this change has never been
      // sent. Probe only uncertain retries (or legacy queues without the
      // durable preparation contract); keep lost-ACK recovery unchanged.
      const fresh = !!queue.prepared && !!queue.prepare && prepared === null;
      const key = hubNamespace(namespace).key;
      if (!cloud.reuseAcknowledgedHeads || !fresh) acknowledgedHeads.delete(key);
      const receipt = fresh ? null : await cloud.receipt?.(change.entry.id);
      if (receipt) {
        acknowledgedHeads.delete(key);
        const sha = async (value: string) =>
          [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(value),
              ),
            ),
          ]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        // A prepared operation survives a crash between remote commit and local
        // acknowledgement. Its original fencing epoch must survive that retry.
        const prior = prepared || head;
        if (!prior) throw Error("PROFILE_RECEIPT_UNPREPARED");
        const expected = await sha(
          JSON.stringify([
            hubNamespace(namespace).key,
            "journal",
            prior.revision,
            await sha(JSON.stringify(payload)),
          ]),
        );
        if (
          !receipt.acknowledged ||
          receipt.mode !== "journal" ||
          JSON.stringify(receipt.namespace) !== hubNamespace(namespace).key ||
          receipt.payloadHash !== expected ||
          receipt.revision !== prior.revision + 1
        )
          throw Error("PROFILE_RECEIPT_INVALID");
        // Server receipt was committed before a lost response. This is not a new
        // write and may be acknowledged even if ownership has since changed.
        await queue.acknowledge(change, {
          revision: receipt.revision,
          epoch: prior.epoch,
        });
        acknowledged++;
        break;
      }
      const cached = acknowledgedHeads.get(key);
      const reuse = !!cached && !!head && cached.head.revision === head.revision &&
        cached.head.epoch === head.epoch;
      if (!reuse) acknowledgedHeads.delete(key);
      const remote = reuse ? cached!.remote : await cloud.stream(namespace);
      if (!head && remote.revision !== 0) throw Error("PROFILE_RESTORE_REQUIRED");
      if (head && head.revision !== remote.revision)
        throw Error("PROFILE_REVISION_CONFLICT");
      const writer = await cloud.writer(namespace);
      if (
        !Number.isSafeInteger(writer.epoch) ||
        writer.epoch < 1 ||
        !Number.isFinite(Date.parse(writer.expiresAt)) ||
        Date.parse(writer.expiresAt) <= now()
      )
        throw Error("PROFILE_WRITER_EXPIRED");
      if (head && head.epoch !== writer.epoch)
        throw Error("PROFILE_RECOVERY_REQUIRED");
      if (
        prepared &&
        (prepared.epoch !== writer.epoch ||
          prepared.revision !== (head?.revision || 0))
      )
        throw Error("PROFILE_RECOVERY_REQUIRED");
      if (await maybeCompactProfileStream(change, queue, cloud, namespace, head, remote, payload, prepared, now)) {
        acknowledgedHeads.delete(key);
        continue;
      }
      const advanced = cloud.reuseAcknowledgedHeads && fresh
        ? advancedAcknowledgedHead(remote, writer.epoch, payload) : undefined;
      await queue.prepare?.(change, {
        revision: head?.revision || 0,
        epoch: writer.epoch,
      });
      const result = await cloud.commit({
        namespace,
        epoch: writer.epoch,
        baseRevision: head?.revision || 0,
        idempotencyKey: change.entry.id,
        mode: "journal",
        payload,
      });
      if (
        result.acknowledged !== true ||
        result.revision !== (head?.revision || 0) + 1
      )
        throw Error("PROFILE_ACK_INVALID");
      await queue.acknowledge(change, {
        revision: result.revision,
        epoch: writer.epoch,
      });
      // Never publish an optimistic head before BOTH acknowledgements. A failed
      // native transaction leaves no reusable metadata; replay keeps its ID.
      if (advanced) acknowledgedHeads.set(key, advanced);
      else acknowledgedHeads.delete(key);
      acknowledged++;
      break;
    }
  }
  return acknowledged;
}

const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error || Error("PROFILE_LOCAL_COMMIT_ABORTED"));
  });
const headKey = (c: QueuedProfileChange): IDBValidKey =>
  c.arrayKeys
    ? ["cloud-head", hubNamespace(changeNamespace(c)).key]
    : "profile-cloud-head:" + hubNamespace(changeNamespace(c)).key;
const preparedKey = (c: QueuedProfileChange): IDBValidKey =>
  c.arrayKeys
    ? ["cloud-prepared", c.entry.id]
    : "profile-cloud-prepared:" + c.entry.id;
export function nativeProfileQueue(
  factory: IDBFactory,
  profileId: string,
): ProfileQueue {
  checkedProfile(profileId);
  const suffix = ":profile:" + profileId;
  const open = (name: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(name);
      r.onupgradeneeded = () => {
        r.transaction?.abort();
        reject(Error("PROFILE_DATABASE_MISSING"));
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Error("PROFILE_DATABASE_BLOCKED"));
      r.onsuccess = () => resolve(r.result);
    });
  const compactionMeta = (change: QueuedProfileChange) => {
    const namespace = changeNamespace(change), local = namespace.kind === "local";
    return { database: namespace.kind === "idb" ? profileCatalogName(profileId) : change.database,
      store: namespace.kind === "idb" ? "meta" : change.store,
      key: local ? ["cloud-compaction", hubNamespace(namespace).key] : "profile-cloud-compaction:" + hubNamespace(namespace).key };
  };
  function validCompaction(change: QueuedProfileChange, plan: ProfileCompactionPlan) {
    if (!plan || hubNamespace(plan.namespace).key !== hubNamespace(changeNamespace(change)).key ||
      !/^[a-zA-Z0-9-]{16,96}$/.test(plan.id) || !Number.isSafeInteger(plan.head?.revision) || plan.head.revision < 0 ||
      !Number.isSafeInteger(plan.head.epoch) || plan.head.epoch < 1 || !plan.payload || typeof plan.payload !== "object")
      throw Error("PROFILE_COMPACTION_PLAN_INVALID");
  }
  async function list(metadataOnly = false, siteGroup?: string) {
      if (siteGroup !== undefined && (typeof siteGroup !== "string" ||
          (siteGroup !== "@atlas" && hubSiteGroup("https://" + siteGroup) !== siteGroup)))
        throw Error("PROFILE_QUEUE_GROUP_INVALID");
      const changes: QueuedProfileChange[] = [];
      const records = (await listProfileIDBDatabases(factory, profileId)).filter(r =>
        siteGroup === undefined || hubSiteGroup(r.origin) === siteGroup);
      scheduleProfileDeleteRecovery(factory, profileId, records);
      // A deletion intent already copied this database's journals into the
      // catalog. Opening its physical source can hang behind deleteDatabase and
      // would duplicate those copied entries. Only the catalog is canonical.
      const active = new Set(records.flatMap(r=>r.physical && !r.deleting ? [r.physical]:[]));
      const catalog = await openProfileCatalog(factory,profileId); catalog.close();
      for (const item of await factory.databases()) {
        const name = item.name || "";
        const local = name === "atlas.browsing.v2" + suffix,
          cookies = name === "atlas.browsing.cookies.v2" + suffix,
          directory = name === profileCatalogName(profileId),
          idb = active.has(name);
        if (!local && !cookies && !idb && !directory) continue;
        const db = await open(name),
          storeName = local ? "origins" : cookies || directory ? "meta" : PROFILE_IDB_KEEP;
        try {
          if (!db.objectStoreNames.contains(storeName))
            throw Error("PROFILE_OUTBOX_UNAVAILABLE");
          const tx = db.transaction(storeName, "readonly"),
            completion = done(tx),
            store = tx.objectStore(storeName);
          // The localStorage source also contains entire website snapshots.
          // Polling the outbox must not clone every snapshot on every drain.
          const keys = (await request(store.getAllKeys())).filter(key => local
            ? Array.isArray(key) && key[0] === "outbox"
            : typeof key === "string" && key.startsWith(PROFILE_OUTBOX_PREFIX));
          const values = await Promise.all(keys.map(key => request(store.get(key))));
          await completion;
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i],
              isEntry = local
                ? Array.isArray(key) && key[0] === "outbox"
                : typeof key === "string" &&
                  key.startsWith(PROFILE_OUTBOX_PREFIX);
            if (!isEntry) continue;
            const entry = values[i] as ProfileJournalEntry & {
              sequence?: number;
            };
            if (
              !entry ||
              entry.profileId !== profileId ||
              typeof entry.id !== "string" ||
              !Number.isSafeInteger(entry.bytes) ||
              entry.bytes < 0
            )
              throw Error("PROFILE_OUTBOX_CORRUPT");
            const change = {
              entry,
              database: name,
              store: storeName,
              key,
              arrayKeys: local,
            };
            const namespace = changeNamespace(change);
            if (siteGroup !== undefined && hubNamespace(namespace).siteGroup !== siteGroup) continue;
            // Full partition/value validation above runs on the original entry.
            // A descriptor cannot be encoded: only queue.payload can resolve its
            // exact immutable native record before wire preparation.
            if (metadataOnly) {
              change.entry = { ...entry, payload: undefined };
              Object.assign(change, { payloadOmitted: true, namespace });
            }
            changes.push(change);
          }
        } finally {
          db.close();
        }
      }
      return changes.sort(
        (a, b) =>
          Number(b.database === profileCatalogName(profileId)) - Number(a.database === profileCatalogName(profileId)) ||
          a.database.localeCompare(b.database) ||
          (a.entry.sequence || 0) - (b.entry.sequence || 0) ||
          a.entry.createdAt - b.entry.createdAt,
      );
  }
  return {
    async compaction(change) {
      const meta = compactionMeta(change), db = await open(meta.database);
      try { const tx = db.transaction(meta.store), completion = done(tx), value = await request(tx.objectStore(meta.store).get(meta.key)); await completion; return value || null; }
      finally { db.close(); }
    },
    async prepareCompaction(change, plan) {
      validCompaction(change, plan);
      const meta = compactionMeta(change), db = await open(meta.database);
      try {
        const tx = db.transaction(meta.store, "readwrite", { durability: "strict" }), completion = done(tx), store = tx.objectStore(meta.store);
        const h = store.get(headKey(change)), p = store.get(meta.key);
        p.onsuccess = () => {
          if (!h.result || h.result.revision !== plan.head.revision || h.result.epoch !== plan.head.epoch ||
              (p.result && JSON.stringify(p.result) !== JSON.stringify(plan))) { tx.abort(); return; }
          store.put(plan, meta.key);
        };
        await completion;
      } finally { db.close(); }
    },
    async finishCompaction(change, plan) {
      validCompaction(change, plan);
      const meta = compactionMeta(change), db = await open(meta.database);
      try {
        const tx = db.transaction(meta.store, "readwrite", { durability: "strict" }), completion = done(tx), store = tx.objectStore(meta.store);
        const h = store.get(headKey(change)), p = store.get(meta.key);
        p.onsuccess = () => {
          const next = { revision: plan.head.revision + 1, epoch: plan.head.epoch };
          if (!h.result || (h.result.revision !== plan.head.revision && h.result.revision !== next.revision) || h.result.epoch !== plan.head.epoch ||
              (p.result ? JSON.stringify(p.result) !== JSON.stringify(plan) : h.result.revision !== next.revision)) { tx.abort(); return; }
          // Only advance the canonical head. No source outbox/counter/native
          // data is read or retired by compaction, including newer writes.
          store.put(next, headKey(change)); store.delete(meta.key);
        };
        await completion;
      } finally { db.close(); }
    },
    list: siteGroup => list(false, siteGroup),
    metadata: siteGroup => list(true, siteGroup),
    async payload(change) {
      const db = await open(change.database);
      try {
        const tx = db.transaction(change.store), completion = done(tx);
        const entry = await request(tx.objectStore(change.store).get(change.key)) as QueuedProfileChange["entry"] | undefined;
        await completion;
        if (!entry || entry.id !== change.entry.id || entry.profileId !== profileId ||
            entry.kind !== change.entry.kind || entry.origin !== change.entry.origin ||
            entry.name !== change.entry.name || entry.sequence !== change.entry.sequence ||
            entry.createdAt !== change.entry.createdAt || entry.bytes !== change.entry.bytes)
          throw Error("PROFILE_QUEUE_ENTRY_CHANGED");
        changeNamespace({ ...change, entry, payloadOmitted: undefined, namespace: undefined });
        return entry.payload;
      } finally { db.close(); }
    },
    async head(change) {
      const directory = change.entry.kind === "idb";
      const db = await open(directory ? profileCatalogName(profileId) : change.database);
      try {
        const tx = db.transaction(directory ? "meta" : change.store, "readonly"),
          completion = done(tx),
          value = await request(
            tx.objectStore(directory ? "meta" : change.store).get(headKey(change)),
          );
        await completion;
        if(value||!directory||change.database===profileCatalogName(profileId))return value||null;
        // Pre-catalog account DBs kept their canonical head next to the local
        // journal. Move it once; never reset an existing remote revision to0.
        const source=await open(change.database);
        let legacy:CloudHead|null=null;
        try{const tx=source.transaction(change.store),completion=done(tx);legacy=await request(tx.objectStore(change.store).get(headKey(change)))||null;await completion;}finally{source.close();}
        if(!legacy)return null;
        const migration=db.transaction('meta','readwrite',{durability:'strict'}),committed=done(migration),store=migration.objectStore('meta'),prior=store.get(headKey(change));let canonical=legacy;
        prior.onsuccess=()=>{if(prior.result)canonical=prior.result;else store.put(legacy,headKey(change));};await committed;return canonical;
      } finally {
        db.close();
      }
    },
    async prepared(change) {
      const db = await open(change.database);
      try {
        const tx = db.transaction(change.store, "readonly"),
          completion = done(tx),
          value = await request(
            tx.objectStore(change.store).get(preparedKey(change)),
          );
        await completion;
        return value || null;
      } finally {
        db.close();
      }
    },
    async prepare(change, head) {
      const db = await open(change.database);
      try {
        const tx = db.transaction(change.store, "readwrite", {
            durability: "strict",
          }),
          completion = done(tx),
          store = tx.objectStore(change.store);
        const existing = store.get(preparedKey(change));
        existing.onsuccess = () => {
          if (
            existing.result &&
            (existing.result.revision !== head.revision ||
              existing.result.epoch !== head.epoch)
          ) {
            tx.abort();
            return;
          }
          store.put(head, preparedKey(change));
        };
        await completion;
      } finally {
        db.close();
      }
    },
    async acknowledge(change, head) {
      // Publish the canonical IDB head first. A crash before source removal is
      // reconciled using the immutable prepared receipt, not a repeated write.
      if(change.entry.kind === "idb") {
        const catalog=await openProfileCatalog(factory,profileId);
        try { const tx=catalog.transaction("meta","readwrite",{durability:"strict"}),completion=done(tx);tx.objectStore("meta").put(head,headKey(change));await completion; } finally {catalog.close();}
      }
      const db = await open(change.database);
      try {
        const tx = db.transaction(change.store, "readwrite", {
            durability: "strict",
          }),
          completion = done(tx),
          store = tx.objectStore(change.store);
        const counter: IDBValidKey = change.arrayKeys
          ? ["outbox-bytes"]
          : PROFILE_OUTBOX_BYTES;
        const exists = store.get(change.key);
        exists.onsuccess = () => {
          if (!exists.result) return; // Repeated acknowledgement is harmless.
          const pending = store.get(counter);
          pending.onsuccess = () => {
            store.delete(change.key);
            store.delete(preparedKey(change));
            store.put(
              Math.max(0, Number(pending.result || 0) - exists.result.bytes),
              counter,
            );
            store.put(head, headKey(change));
          };
        };
        await completion;
      } finally {
        db.close();
      }
    },
  };
}

/** Copy first, then retire only the selected source entries. A crash may leave
 * a duplicate source entry, never an unbacked recovery. Canonical heads remain
 * untouched until a successful cloud restore publishes a new generation. */
export async function preserveProfileRecovery(factory:IDBFactory,profileId:string,recoveryId:string,changes:QueuedProfileChange[],snapshot:unknown):Promise<void>{
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open('atlas.profile.recovery.v1:profile:'+profileId,1);r.onupgradeneeded=()=>r.result.createObjectStore('branches');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{const tx=db.transaction('branches','readwrite',{durability:'strict'}),completion=done(tx);tx.objectStore('branches').put({id:recoveryId,createdAt:Date.now(),snapshot,changes},recoveryId);await completion;}finally{db.close();}
 for(const change of changes){const source=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open(change.database);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{const tx=source.transaction(change.store,'readwrite',{durability:'strict'}),completion=done(tx),store=tx.objectStore(change.store),r=store.get(change.key);r.onsuccess=()=>{if(!r.result)return;const counter=change.arrayKeys?['outbox-bytes']:PROFILE_OUTBOX_BYTES,b=store.get(counter);b.onsuccess=()=>{store.delete(change.key);store.delete(preparedKey(change));store.put(Math.max(0,Number(b.result||0)-Number(r.result.bytes||0)),counter);};};await completion;}finally{source.close();}}
}
