/** Background backup orchestration only. It never grants website ownership,
 * marks a native write durable, or reports a remote save acknowledgement.
 * `run` must retain the profile's existing fenced/durable drain implementation.
 */
export type ProfileSyncChange = "data" | "cookies";
export type ProfileSyncClock = {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};
export type ProfileSyncSchedulerOptions = {
  run(): Promise<void>;
  /** Background errors only. Explicit flush callers receive their rejection. */
  onError?(error: unknown): void | Promise<void>;
  /** Runs after a real successful drain; newer mutations remain pending. */
  onSuccess?(state: { pending: boolean }): void | Promise<void>;
  retryable(error: unknown): boolean;
  clock?: ProfileSyncClock;
  random?: () => number;
  delayMs?: number;
  cookieDelayMs?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
};

export function createProfileSyncScheduler(options: ProfileSyncSchedulerOptions) {
  const clock: ProfileSyncClock = options.clock ?? {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const random = options.random ?? Math.random;
  const delayMs = options.delayMs ?? 1000;
  const cookieDelayMs = options.cookieDelayMs ?? 15000;
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const maxBackoffMs = options.maxBackoffMs ?? 60000;
  for (const value of [delayMs, cookieDelayMs, retryBaseMs, maxBackoffMs])
    if (!Number.isFinite(value) || value < 0 || value > 86400000)
      throw new TypeError("Invalid profile backup scheduling interval");
  if (retryBaseMs < 1 || maxBackoffMs < retryBaseMs)
    throw new TypeError("Invalid profile backup retry interval");

  let version = 0;
  let cleanVersion = 0;
  let dueAt: number | undefined;
  let retryAt = 0;
  let failures = 0;
  let paused = false;
  let stopped = false;
  let timer: unknown;
  let timerAt: number | undefined;
  let flight: { promise: Promise<void>; observed: boolean } | undefined;
  const pending = () => version > cleanVersion;
  const cancelTimer = () => {
    if (timerAt !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    timerAt = undefined;
  };
  function arm() {
    if (stopped || paused || flight || !pending() || dueAt === undefined) {
      cancelTimer();
      return;
    }
    const deadline = Math.max(dueAt, retryAt);
    if (timerAt === deadline) return;
    cancelTimer();
    timerAt = deadline;
    timer = clock.setTimeout(() => {
      timer = undefined;
      timerAt = undefined;
      // Background failures are reported below and retained as pending work.
      // The timer never creates an unhandled rejected promise.
      void start(false).catch(() => {});
    }, Math.max(0, deadline - clock.now()));
  }
  function changed(kind: ProfileSyncChange = "data", { resumePaused = false } = {}) {
    if (stopped) return;
    const deadline = clock.now() + (kind === "cookies" ? cookieDelayMs : delayMs);
    // Only the caller can know that this mutation belongs to a different,
    // unblocked website. Ordinary noisy writes must not defeat terminal pause.
    if (paused && resumePaused) {
      paused = false;
      dueAt = deadline;
    }
    ++version;
    dueAt = dueAt === undefined ? deadline : Math.min(dueAt, deadline);
    arm();
  }
  function reconcileDirty(kind: ProfileSyncChange = "data") {
    if (stopped) return;
    if (!pending()) changed(kind);
    else arm(); // Preserve deadline, backoff and terminal pause on idle probes.
  }
  function retryDelay() {
    const base = Math.min(maxBackoffMs, retryBaseMs * 2 ** Math.min(failures - 1, 30));
    const sample = random();
    const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
    return Math.min(maxBackoffMs, Math.round(base * (0.8 + bounded * 0.4)));
  }
  function start(observed: boolean): Promise<void> {
    if (stopped)
      return Promise.reject(Object.assign(Error("Profile backup scheduler is stopped."), {
        code: "PROFILE_SYNC_SCHEDULER_STOPPED",
      }));
    if (flight) {
      if (observed) flight.observed = true;
      return flight.promise;
    }
    // Explicit drains also cover durable entries whose notification was missed.
    if (!pending()) ++version;
    const startedVersion = version;
    cancelTimer();
    dueAt = undefined;
    const current = { promise: Promise.resolve(), observed };
    current.promise = Promise.resolve()
      .then(() => {
        if (stopped) throw Object.assign(Error("Profile backup scheduler is stopped."), {
          code: "PROFILE_SYNC_SCHEDULER_STOPPED",
        });
        return options.run();
      })
      .then(async () => {
        if (stopped) return;
        cleanVersion = startedVersion;
        failures = 0;
        paused = false;
        retryAt = 0;
        try { await options.onSuccess?.({ pending: pending() }); } catch { /* UI failure cannot undo a real ACK. */ }
      }, async (error: unknown) => {
        if (!stopped) {
          ++failures;
          let retryable = false;
          try { retryable = options.retryable(error); } catch { /* Pause, do not storm. */ }
          paused = !retryable;
          retryAt = retryable ? clock.now() + retryDelay() : 0;
          dueAt ??= clock.now();
          if (!current.observed) {
            try { await options.onError?.(error); } catch { /* UI failure is not an ACK. */ }
          }
        }
        throw error;
      })
      .finally(() => {
        if (flight === current) flight = undefined;
        arm();
      });
    flight = current;
    return current.promise;
  }
  function flushNow() {
    if (flight) return start(true);
    paused = false;
    retryAt = 0;
    return start(true);
  }
  function retry() {
    // A deliberate user retry may reset failure pacing. If work is already in
    // flight it joins that exact attempt instead of creating a second drain.
    if (!flight) failures = 0;
    return flushNow();
  }
  function stop() {
    stopped = true;
    cancelTimer();
    // The durable outbox belongs to the caller and is never erased here.
  }
  return {
    changed,
    reconcileDirty,
    flushNow,
    retry,
    pending,
    stop,
    inspect: () => ({
      pending: pending(), running: !!flight, paused, stopped, failures,
      dueAt, retryAt, timerAt,
    }),
  };
}
