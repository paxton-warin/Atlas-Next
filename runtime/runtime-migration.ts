// Existing data is upgraded only when an older controller database is present.
// Fresh profiles do not download the retired-engine compatibility module.
export async function migrateCookies() {
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    if (new URL(registration.scope).pathname === "/uv/")
      await registration.unregister();
  }
  const databases = await indexedDB.databases();
  if (
    !databases.some(
      (db) =>
        db.name?.startsWith("__") &&
        db.name.endsWith("_controller") &&
        db.name !== "__runtimekit_controller",
    )
  )
    return;
  const upgrade = await import("./cookie-upgrade");
  await upgrade.migrateCookies();
}

export async function activateWorker(path: string): Promise<ServiceWorker> {
  const url = new URL(path, location.origin).href;
  const reg = await navigator.serviceWorker.register(path, {
    type: "classic",
    updateViaCache: "none",
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let updateConfirmed = false;
    const watched = new Set<ServiceWorker>();
    const pending = new Set<ServiceWorker>();
    const finish = (error?: Error, worker?: ServiceWorker) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reg.removeEventListener("updatefound", check);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      for (const sw of watched) sw.removeEventListener("statechange", check);
      if (error) reject(error);
      else resolve(worker!);
    };
    const check = () => {
      if (settled) return;
      for (const sw of [reg.installing, reg.waiting, reg.active]) {
        if (sw && !watched.has(sw)) {
          watched.add(sw);
          sw.addEventListener("statechange", check);
        }
      }
      // A same-URL register() may return yesterday's still-active worker without
      // checking its imports. Never pair that old RPC implementation with the
      // new Controller, or choose the old worker during an in-progress install.
      for (const worker of [reg.installing, reg.waiting]) {
        if (worker) pending.add(worker);
      }
      if ([...pending].some(worker => worker.state === "redundant")) {
        finish(Error("Browsing worker upgrade failed. Reload this tab."));
        return;
      }
      const worker = reg.active;
      if (
        updateConfirmed &&
        !reg.installing &&
        !reg.waiting &&
        worker?.scriptURL === url &&
        worker.state === "activated" &&
        navigator.serviceWorker.controller === worker
      ) finish(undefined, worker);
    };
    const timer = setTimeout(
      () => finish(Error("Browsing worker upgrade timed out. Reload this tab.")),
      15000,
    );
    reg.addEventListener("updatefound", check);
    navigator.serviceWorker.addEventListener("controllerchange", check);
    check();
    // The existing deadline covers a stalled update as well as activation.
    // An update failure is not permission to use the stale active generation.
    void Promise.resolve().then(() => reg.update()).then(() => {
      updateConfirmed = true;
      check();
    }, () => finish(Error("Browsing worker upgrade failed. Reload this tab.")));
  });
}
