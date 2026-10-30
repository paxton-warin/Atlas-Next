/** Cloud-only protection for a completed checkpoint while a new local staging
 * copy is being read. This never grants/revokes native website authority. */
export type BackupRestoreReaderPin = {
  version: 1;
  leaseId: string;
  ttlMs: number;
  renewAfterMs: number;
  observedAt: number;
};
type Transport = {
  request<T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  subscribeActivity?: (listener: (path: string) => void) => () => void;
};
export type BackupRestoreReaderClock = {
  now(): number;
  setTimeout(work: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};
export function createBackupRestoreReader(options: {
  transport: Transport;
  checkpointId: string;
  pin?: BackupRestoreReaderPin;
  signal?: AbortSignal;
  lost(error: Error): void;
  clock?: BackupRestoreReaderClock;
}) {
  const clock = options.clock ?? {
    now: () => performance.now(),
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (id: unknown) =>
      clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const pin = options.pin;
  if (!pin) return { activity() {}, close() {} };
  let stopped = false,
    lastActivity = clock.now(),
    expiry = pin.observedAt + pin.ttlMs,
    renewTimer: unknown,
    expiryTimer: unknown,
    renewing = false;
  const controller = new AbortController(),
    base = "/checkpoints/" + options.checkpointId;
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const invalid = () =>
    Object.assign(
      Error(
        "Restore protection expired. Retry to load a completed backup; local saves are unchanged.",
      ),
      { code: "BACKUP_RESTORE_PIN_EXPIRED", name: "AbortError" },
    );
  let unsubscribe = () => {};
  const clear = () => {
    clock.clearTimeout(renewTimer);
    clock.clearTimeout(expiryTimer);
    unsubscribe();
    options.signal?.removeEventListener("abort", aborted);
  };
  function release() {
    // Cleanup is detached. Neither successful local staging nor its publication
    // waits for a cloud release acknowledgement; TTL covers worker termination.
    void options.transport
      .request(
        base + "/restore-release",
        "POST",
        { leaseId: pin!.leaseId },
        AbortSignal.timeout(1000),
      )
      .catch(() => {});
  }
  function close() {
    if (stopped) return;
    stopped = true;
    clear();
    controller.abort();
    release();
  }
  function aborted() {
    close();
  }
  function lost() {
    if (stopped) return;
    const error = invalid();
    stopped = true;
    clear();
    controller.abort(error);
    release();
    options.lost(error);
  }
  function expiryWatch() {
    clock.clearTimeout(expiryTimer);
    expiryTimer = clock.setTimeout(lost, Math.max(0, expiry - clock.now()));
  }
  function schedule(delay: number) {
    clock.clearTimeout(renewTimer);
    if (!stopped)
      renewTimer = clock.setTimeout(
        () => {
          void renew();
        },
        Math.max(0, delay),
      );
  }
  async function renew() {
    if (stopped || renewing) return;
    if (clock.now() >= expiry) {
      lost();
      return;
    }
    if (clock.now() - lastActivity > 45000) {
      schedule(Math.min(pin!.renewAfterMs, expiry - clock.now()));
      return;
    }
    renewing = true;
    const started = clock.now();
    try {
      const result = await options.transport.request<{
        renewed: boolean;
        ttlMs: number;
        leaseId: string;
      }>(
        base + "/restore-renew",
        "POST",
        { leaseId: pin!.leaseId },
        AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.min(10000, expiry - started))),
        ]),
      );
      if (stopped) return;
      if (
        result?.renewed !== true ||
        result.ttlMs !== pin!.ttlMs ||
        result.leaseId !== pin!.leaseId
      )
        throw Error("BACKUP_RESTORE_PIN_RESPONSE_INVALID");
      expiry = started + result.ttlMs;
      expiryWatch();
      schedule(pin!.renewAfterMs);
    } catch (error) {
      if (!stopped) {
        if (
          [401, 403, 404, 409, 410].includes(
            Number((error as { status?: number })?.status),
          ) ||
          clock.now() >= expiry
        )
          lost();
        else schedule(Math.min(5000, expiry - clock.now()));
      }
    } finally {
      renewing = false;
    }
  }
  function activity() {
    if (!stopped) lastActivity = clock.now();
  }
  unsubscribe =
    options.transport.subscribeActivity?.((path) => {
      if (
        path.startsWith("/parts/") ||
        /^\/namespace-versions\/[a-f0-9-]{36}\/records(?:\?|$)/i.test(path) ||
        path.startsWith(base + "?") ||
        path.startsWith(base + "/namespaces")
      )
        activity();
    }) ?? (() => {});
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) close();
  else {
    expiryWatch();
    schedule(
      Math.min(
        pin.renewAfterMs,
        Math.max(0, expiry - clock.now() - pin.renewAfterMs),
      ),
    );
  }
  return { activity, close };
}
