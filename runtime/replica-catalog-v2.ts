/** Small local catalog only. User values, journals and cloud state never enter
 * the UI realm while establishing account/replica scope. */
export type ReplicaCatalogEntry = {
  profileId: string;
  replicaId: string;
  incarnation: string;
  hasLocal: boolean;
  cloudChecked: boolean;
  /** Cloud discovery failed; this native working incarnation must not be
   * automatically overwritten by a late restore or called a confirmed backup. */
  restoreUnavailable?: boolean;
  revision: number;
  selection?: string;
  seedCheckpointId?: string;
  seedPublicationOrdinal?: string;
  deferredPreferences?: string[];
  legacyOrigins?: string[];
};
const NAME = "atlas.local-first.catalog.v2";
const uuid = /^[a-f0-9-]{36}$/i;
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ?? new DOMException("Local catalog aborted", "AbortError"),
      );
    tx.onerror = () => {};
  });
async function open(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("accounts");
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
}
export async function establishReplicaCatalog(
  factory: IDBFactory,
  profileId: string,
  randomUUID = () => crypto.randomUUID(),
  selection?: string,
): Promise<ReplicaCatalogEntry> {
  if (!uuid.test(profileId)) throw new TypeError("Invalid account scope");
  const db = await open(factory);
  try {
    const tx = db.transaction("accounts", "readwrite"),
      end = done(tx),
      store = tx.objectStore("accounts");
    let alias: NativeActiveSelection | undefined;
    if (selection === "native-only-v1") {
      alias = await request(store.get(activeSelectionKey(profileId)));
      if (alias && !validActiveSelection(alias,profileId)) throw Error("LOCAL_ACTIVE_SELECTION_INVALID");
      if (alias) selection = alias.selection;
    }
    const key: IDBValidKey = selection ? [profileId, selection] : profileId;
    const prior = await request(store.get(key));
    if (alias && (!prior || prior.replicaId !== alias.replicaId || prior.incarnation !== alias.incarnation || prior.seedCheckpointId !== alias.checkpointId)) throw Error("LOCAL_ACTIVE_SELECTION_INVALID");
    if (prior) {
      if (
        prior.profileId !== profileId ||
        !uuid.test(prior.replicaId) ||
        prior.replicaId === profileId
      )
        throw new Error("LOCAL_CATALOG_INVALID");
      await end;
      return prior;
    }
    const row: ReplicaCatalogEntry = {
      profileId,
      replicaId: randomUUID(),
      incarnation: randomUUID(),
      hasLocal: false,
      cloudChecked: false,
      revision: 1,
      ...(selection ? { selection } : {}),
    };
    store.add(row, key);
    await end;
    return row;
  } finally {
    db.close();
  }
}
/** CAS prevents a delayed restore/cleanup from replacing a newer incarnation.
 * An existing local incarnation is never overwritten by automatic cloud restore. */
export async function updateReplicaCatalog(
  factory: IDBFactory,
  expected: ReplicaCatalogEntry,
  patch: Partial<
    Pick<
      ReplicaCatalogEntry,
      | "replicaId"
      | "incarnation"
      | "hasLocal"
      | "cloudChecked"
      | "restoreUnavailable"
      | "seedCheckpointId"
      | "seedPublicationOrdinal"
      | "deferredPreferences"
      | "legacyOrigins"
    >
  >,
) {
  const db = await open(factory);
  try {
    const tx = db.transaction("accounts", "readwrite"),
      end = done(tx),
      store = tx.objectStore("accounts");
    const prior = (await request(
      store.get(
        expected.selection
          ? [expected.profileId, expected.selection]
          : expected.profileId,
      ),
    )) as ReplicaCatalogEntry;
    if (
      !prior ||
      prior.replicaId !== expected.replicaId ||
      prior.incarnation !== expected.incarnation ||
      (prior.revision !== expected.revision &&
        Object.keys(patch).some(
          (k) =>
            ![
              "hasLocal",
              "cloudChecked",
              "legacyOrigins",
              "restoreUnavailable",
            ].includes(k),
        ))
    ) {
      tx.abort();
      try {
        await end;
      } catch {}
      throw new Error("LOCAL_CATALOG_CHANGED");
    }
    if (
      patch.replicaId &&
      patch.replicaId !== prior.replicaId &&
      prior.hasLocal
    ) {
      tx.abort();
      try {
        await end;
      } catch {}
      throw new Error("LOCAL_STATE_REPLACEMENT_REQUIRES_NEW_INCARNATION");
    }
    const next = {
      ...prior,
      ...patch,
      hasLocal: prior.hasLocal || patch.hasLocal === true,
      cloudChecked: prior.cloudChecked || patch.cloudChecked === true,
      revision: prior.revision + 1,
    };
    store.put(
      next,
      expected.selection
        ? [expected.profileId, expected.selection]
        : expected.profileId,
    );
    await end;
    return next;
  } finally {
    db.close();
  }
}

/** An explicit verified restore may become this link's normal workspace.
 * Metadata discovery alone never writes this alias. */
export type NativeActiveSelection = {profileId:string;selection:string;replicaId:string;incarnation:string;checkpointId:string;revision:number};
const activeSelectionKey = (profileId:string):IDBValidKey => ["native-active-selection-v1",profileId];
function validActiveSelection(value:any,profileId:string):value is NativeActiveSelection {
  return value?.profileId===profileId && /^activate:[a-f0-9-]{36}:[a-f0-9-]{36}$/i.test(value.selection) && uuid.test(value.replicaId) && uuid.test(value.incarnation) && uuid.test(value.checkpointId) && Number.isSafeInteger(value.revision) && value.revision>0;
}
export async function nativeActiveSelectionRevision(factory:IDBFactory,profileId:string):Promise<number>{
 if(!uuid.test(profileId))throw TypeError("Invalid account scope");
 const db=await open(factory);try{const t=db.transaction("accounts"),end=done(t),v=await request(t.objectStore("accounts").get(activeSelectionKey(profileId)));await end;if(v&&!validActiveSelection(v,profileId))throw Error("LOCAL_ACTIVE_SELECTION_INVALID");return v?.revision??0;}finally{db.close();}
}
export async function activateNativeReplicaCatalog(factory:IDBFactory,expectedRevision:number,target:ReplicaCatalogEntry){
 if(!target.selection?.startsWith("activate:")||!target.seedCheckpointId||!target.hasLocal)throw Error("LOCAL_ACTIVATION_REQUIRES_COMPLETED_RESTORE");
 const db=await open(factory);try{const t=db.transaction("accounts","readwrite"),end=done(t),store=t.objectStore("accounts"),prior=await request(store.get(activeSelectionKey(target.profileId))),current=await request(store.get([target.profileId,target.selection]));
  if(prior&&!validActiveSelection(prior,target.profileId)){t.abort();await end.catch(()=>{});throw Error("LOCAL_ACTIVE_SELECTION_INVALID");}
  if(!current||current.replicaId!==target.replicaId||current.incarnation!==target.incarnation||current.seedCheckpointId!==target.seedCheckpointId||!current.hasLocal){t.abort();await end.catch(()=>{});throw Error("LOCAL_CATALOG_CHANGED");}
  if(prior?.selection===target.selection&&prior.replicaId===target.replicaId&&prior.incarnation===target.incarnation){await end;return prior as NativeActiveSelection;}
  if((prior?.revision??0)!==expectedRevision){t.abort();await end.catch(()=>{});throw Error("LOCAL_ACTIVE_SELECTION_CHANGED");}
  const alias:NativeActiveSelection={profileId:target.profileId,selection:target.selection,replicaId:target.replicaId,incarnation:target.incarnation,checkpointId:target.seedCheckpointId,revision:expectedRevision+1};store.put(alias,activeSelectionKey(target.profileId));await end;return alias;
 }finally{db.close();}
}
