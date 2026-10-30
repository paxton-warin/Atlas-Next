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

export type RuntimeStartupOptions = {
  signal?: AbortSignal;
  onSlow?: () => void;
};

// Elapsed time is an observation, not evidence that valid local startup failed.
// Real operation failures still reject; owner teardown cancels the local wait.
export async function waitForRuntimeStartup<T>(
  operation: PromiseLike<T>,
  options: RuntimeStartupOptions & { slowAfterMs: number },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean, value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (ok) resolve(value);
      else reject(value);
    };
    const abort = () => finish(false, options.signal!.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    // Always consume a late rejection, even when the owner already closed.
    Promise.resolve(operation).then(
      value => finish(true, value),
      error => finish(false, error),
    );
    if (options.signal?.aborted) abort();
    if (!settled) timer = setTimeout(() => {
      if (settled) return;
      // A presentation callback must not change startup success/failure.
      try { options.onSlow?.(); } catch {}
    }, options.slowAfterMs);
  });
}

export async function activateWorker(
  path: string,
  options: RuntimeStartupOptions = {},
): Promise<ServiceWorker> {
  const url = new URL(path, location.origin).href;
  const selection = new Promise<ServiceWorker>((resolve, reject) => {
    let settled = false;
    let updateConfirmed = false;
    let reg: ServiceWorkerRegistration | undefined;
    const watched = new Set<ServiceWorker>();
    const pending = new Set<ServiceWorker>();
    const finish = (error?: unknown, worker?: ServiceWorker) => {
      if (settled) return;
      settled = true;
      reg?.removeEventListener("updatefound", check);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      options.signal?.removeEventListener("abort", abort);
      for (const sw of watched) sw.removeEventListener("statechange", check);
      if (worker) resolve(worker);
      else reject(error);
    };
    const abort = () => finish(options.signal!.reason);
    const check = () => {
      if (settled || !reg) return;
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
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    void Promise.resolve().then(() => {
      if (settled) return;
      return navigator.serviceWorker.register(path, {
        type: "classic",
        updateViaCache: "none",
      });
    }).then(registered => {
      // Native register/update work is browser-owned; cancellation must not
      // unregister a shared worker or attach a late listener to a closed root.
      if (settled || !registered) return;
      reg = registered;
      reg.addEventListener("updatefound", check);
      navigator.serviceWorker.addEventListener("controllerchange", check);
      check();
      if (settled) return;
      // An update failure is not permission to use the stale active generation.
      void Promise.resolve().then(() => reg!.update()).then(() => {
        updateConfirmed = true;
        check();
      }, () => finish(Error("Browsing worker upgrade failed. Reload this tab.")));
    }, error => finish(error));
  });
  return waitForRuntimeStartup(selection, { ...options, slowAfterMs: 15000 });
}
