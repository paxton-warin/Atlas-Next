// The fork renames only the cookie DB; hostname-prefixed Web Storage is unchanged.
// Preserve the old database for rollback. Never overwrite an existing fork jar.
export async function migrateCookies() {
  // Retire the removed engine's worker without touching Scramjet cookies.
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    if (new URL(registration.scope).pathname === "/uv/")
      await registration.unregister();
  }
  if (
    !(await indexedDB.databases()).some(
      (db) => db.name === "__scramjet_controller",
    )
  )
    return;
  const open = (name: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          Error(
            "Close other browsing windows before upgrading website storage.",
          ),
        );
    });
  const legacy = await open("__scramjet_controller");
  let value: any;
  try {
    value = await new Promise((resolve, reject) => {
      const tx = legacy.transaction("state", "readonly");
      const request = tx.objectStore("state").get("cookies");
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    legacy.close();
  }
  if (
    !value ||
    !Number.isFinite(value.updatedAt) ||
    typeof value.cookies !== "string"
  )
    return;
  const current = await open("__runtimekit_controller");
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = current.transaction("state", "readwrite");
      const state = tx.objectStore("state");
      const request = state.get("cookies");
      request.onsuccess = () => {
        if (request.result === undefined) state.put(value, "cookies");
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    current.close();
  }
}
