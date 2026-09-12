// The fork renames only the cookie DB; hostname-prefixed Web Storage is unchanged.
// Preserve the old database for rollback. Never overwrite an existing fork jar.
export async function migrateCookies() {
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

export async function activateWorker(path: string): Promise<ServiceWorker> {
  const url = new URL(path, location.origin).href;
  const reg = await navigator.serviceWorker.register(path, {
    type: "classic",
    updateViaCache: "none",
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        finish(Error("Browsing worker upgrade timed out. Reload this tab.")),
      15000,
    );
    const watched = new Set<ServiceWorker>();
    const check = () => {
      for (const sw of [reg.installing, reg.waiting, reg.active]) {
        if (sw && !watched.has(sw)) {
          watched.add(sw);
          sw.addEventListener("statechange", check);
        }
      }
      if (
        reg.active?.scriptURL === url &&
        reg.active.state === "activated" &&
        navigator.serviceWorker.controller?.scriptURL === url
      )
        finish();
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      reg.removeEventListener("updatefound", check);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      for (const sw of watched) sw.removeEventListener("statechange", check);
      if (error) reject(error);
      else resolve(reg.active!);
    };
    reg.addEventListener("updatefound", check);
    navigator.serviceWorker.addEventListener("controllerchange", check);
    check();
  });
}
