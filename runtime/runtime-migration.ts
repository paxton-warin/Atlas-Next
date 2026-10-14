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
