import { createBackupDirtyHints } from "./backup-dirty-hints.ts";
import { completedBackupSelection } from "./backup-v2-latest.ts";
import { probeLocalReceiptsV2 } from "./local-receipt-probe-v2.ts";
import { createReplicaControlV2 } from "./replica-control-v2.ts";
import { createBackupV2Actor } from "./backup-v2-actor.ts";
import { portableAtlasKey, seedPortableAtlasPreferences } from "./model.ts";
import type { BackupRestoreProgress } from "../../runtime/backup-v2-restore.ts";
import type { BackupV2Status } from "./backup-v2-service.ts";
import type { HubClientSession } from "./hub-client-state.ts";
import {
  setActiveLocalAuthority,
  clearActiveLocalAuthority,
  getActiveLocalAuthority,
  setLocalSiteMode,
  setLocalCookieProfileReady,
  setActiveProfile,
  setActiveProfileContext,
  setProfileDocumentGuard,
} from "../../runtime/profile-context.ts";
import { sameLocalActorAuthority, type LocalActorAuthority } from "../../runtime/local-authority.ts";
export type NewerBackup = {
  checkpointId: string;
  publicationOrdinal: string;
  completedAt: string;
};
export type LocalFirstStatus = {
  freshWorkspace?: boolean;
  nativeOnly?: boolean;
  legacyDataNotImported?: boolean;
  restoreUnavailable?: boolean;
  newerBackup?: NewerBackup;
  checkingLatest?: boolean;
  latestCheckError?: string;
  local: "ready";
  backup: BackupV2Status;
  legacy: Array<{ origin: string; reason: string }>;
};
/** Candidate coordinator. Local startup knows only account scope and the local
 * catalog. The cloud actor never receives website ports or a native revoker. */
export async function createLocalFirstProfile(
  state: HubClientSession,
  options: {
    onStatus(status: LocalFirstStatus): void;
    current(): HubClientSession | null;
    /** Local-only test seam; production reconciles on the60-second clock. */
    scheduleReconciliation?: (work: () => void, delay: number) => () => void;
  },
  catalogRetry = 0,
  openedMetadataChecked = false,
) {
  const grant = state.grant!;
  await probeLocalReceiptsV2();
  const params = new URL(location.href).searchParams;
  const freshWorkspace = params.get("freshWorkspace") ?? undefined;
  if (freshWorkspace && !/^[a-f0-9-]{36}$/i.test(freshWorkspace))
    throw new TypeError("Invalid fresh workspace");
  const version = params.get("backupVersion") ?? undefined;
  if (version && !/^[a-f0-9-]{36}$/i.test(version))
    throw new TypeError("Invalid backup version");
  // Stable, separate native-only catalog: old migration flags and legacy source
  // data cannot route this incarnation back into journal replication.
  const activate = !!version && params.get("activateBackup") === "1";
  let activation = params.get("backupActivation") ?? undefined;
  if (activate && !activation) {
    activation = crypto.randomUUID();
    const url = new URL(location.href);
    url.searchParams.set("backupActivation", activation);
    history.replaceState(history.state, "", url);
  }
  if (activation && !/^[a-f0-9-]{36}$/i.test(activation))
    throw TypeError("Invalid backup activation");
  const selection = freshWorkspace
    ? "fresh:" + freshWorkspace
    : activate
      ? "activate:" + version + ":" + activation
      : (version ?? "native-only-v1");
  const control = createReplicaControlV2({ nativeOnly: true }),
    initialized = await control.initialize(grant.profileId, selection, true);
  let account = initialized.account,
    stopped = false;
  let authority: LocalActorAuthority;
  let restoreUnavailable = account.restoreUnavailable === true;
  const flights = new Map<string, Promise<void>>();
  let newerBackup: NewerBackup | undefined,
    checkingLatest = false,
    latestCheckError: string | undefined;
  let latestFlight: Promise<NewerBackup | null> | undefined;
  const ordinal = (v: unknown) =>
    /^[0-9]{1,30}$/.test(String(v)) ? BigInt(String(v)) : null;
  let restoring = false,
    restoreFinalizing = false;
  let restoreReaderPinned = false,
    restoringCheckpointId: string | undefined,
    restoreReaderLeaseId: string | undefined;
  function releaseRestoreReader() {
    if (!restoreReaderPinned || !restoringCheckpointId || !restoreReaderLeaseId)
      return;
    restoreReaderPinned = false;
    if (options.current()?.grant?.profileId !== grant.profileId) return;
    // Parent keepalive survives backup-worker termination. Cleanup is detached
    // from local catalog publication; expiry also safely collects lost releases.
    void fetch(
      "/api/hub/profile/backups/v2/checkpoints/" +
        restoringCheckpointId +
        "/restore-release",
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        keepalive: true,
        signal: AbortSignal.timeout(1000),
        headers: {
          "content-type": "application/json",
          "x-atlas-hub-csrf": state.csrf!,
          "x-atlas-profile-id": grant.profileId,
        },
        body: JSON.stringify({ leaseId: restoreReaderLeaseId }),
      },
    ).catch(() => {});
  }
  const emitRestore = (progress: BackupRestoreProgress) => {
    if (stopped) return;
    window.dispatchEvent(
      new CustomEvent("atlas:backup-restore-progress", {
        detail: {
          profileId: grant.profileId,
          contextId: grant.contextId,
          sessionId: grant.sessionId,
          progress,
        },
      }),
    );
  };
  const backup = createBackupV2Actor({
    profileId: grant.profileId,
    replicaId: account.replicaId,
    incarnation: account.incarnation,
    label: "Browser at " + location.hostname,
    headers: {
      "x-atlas-hub-csrf": state.csrf!,
      "x-atlas-profile-id": grant.profileId,
    },
    seedCheckpointId: account.seedCheckpointId,
    onRestoreProgress: (_namespace, _records, progress) => {
      if (restoring && progress) {
        if (progress.readerPinned) {
          restoreReaderPinned = true;
          restoreReaderLeaseId = progress.readerLeaseId;
        }
        emitRestore(progress);
      }
    },
    onStatus: (status) => {
      const completed = ordinal(status.lastCompleted?.publicationOrdinal);
      if (
        newerBackup &&
        completed !== null &&
        ordinal(newerBackup.publicationOrdinal)! <= completed
      )
        newerBackup = undefined;
      if (!stopped)
        options.onStatus({
          local: "ready",
          freshWorkspace: !!freshWorkspace,
          nativeOnly: true,
          legacyDataNotImported: !freshWorkspace,
          restoreUnavailable,
          newerBackup,
          checkingLatest,
          latestCheckError,
          backup: {
            ...status,
            deferred: [
              ...status.deferred,
              ...(account.deferredPreferences?.length
                ? [
                    {
                      sourceId: "@atlas-restored-preferences",
                      code: "BACKUP_PREFERENCES_DEFERRED",
                      message:
                        "Some large restored preferences remain in this local checkpoint and have not been applied to the interface.",
                    },
                  ]
                : []),
            ],
          },
          legacy: [],
        });
    },
  });
  function check() {
    const current = options.current();
    if (
      stopped ||
      current?.grant?.profileId !== grant.profileId ||
      current.grant.sessionId !== grant.sessionId ||
      current.grant.contextId !== grant.contextId
    )
      throw Object.assign(
        new Error("The account changed; local data is retained."),
        { code: "PROFILE_CONTEXT_CHANGED" },
      );
  }
  try {
    if (activate && account.hasLocal)
      throw Object.assign(
        new Error(
          "This backup selection already has local state. Open Atlas normally or load the latest backup again.",
        ),
        { code: "LOCAL_ACTIVATION_RETRY_REQUIRED" },
      );
    // Existing native catalogs mount immediately. A new device may restore a
    // completed v2 checkpoint, never v1 history/legacy namespace hints. Automatic
    // discovery uses inactivity deadlines. Only explicit user choice skips a
    // failed restore; elapsed time alone never creates an empty workspace.
    if (!account.hasLocal && !account.cloudChecked) {
      openedMetadataChecked = true;
      restoring = true;
      const blank = {
        completedBytes: 0,
        completedRecords: 0,
        downloadedBytes: 0,
        namespaces: 0,
        elapsedMs: 0,
      };
      let skipped =
        sessionStorage.getItem("atlas.backup.skip-once:" + grant.profileId) ===
        grant.contextId;
      sessionStorage.removeItem("atlas.backup.skip-once:" + grant.profileId);
      let skip!: () => void;
      const localChoice = new Promise<null>((resolve) => {
        skip = () => {
          if (restoreFinalizing) return;
          skipped = true;
          resolve(null);
          backup.stop();
        };
      });
      const onSkip = (event: Event) => {
        const d = (event as CustomEvent).detail;
        if (
          d?.profileId === grant.profileId &&
          d.contextId === grant.contextId &&
          d.sessionId === grant.sessionId
        )
          skip();
      };
      window.addEventListener("atlas:backup-restore-skip", onSkip);
      try {
        let latest: { checkpoint: { checkpointId: string } | null } | null = {
          checkpoint: null,
        };
        emitRestore({ ...blank, phase: "discovering" });
        if (!skipped)
          latest = version
            ? { checkpoint: { checkpointId: version } }
            : await Promise.race([
                backup.latest() as Promise<{
                  checkpoint: { checkpointId: string } | null;
                }>,
                localChoice,
              ]);
        check();
        if (!skipped) latest = completedBackupSelection(latest);
        if (latest?.checkpoint && !skipped) {
          // Worker and transport use progress-reset inactivity deadlines. There
          // is intentionally no total-duration cutoff for a progressing restore.
          restoringCheckpointId = latest.checkpoint.checkpointId;
          const staged = await Promise.race([
            backup.restore(latest.checkpoint.checkpointId),
            localChoice,
          ]);
          if (staged?.readerPinned) {
            restoreReaderPinned = true;
            restoreReaderLeaseId = staged.readerLeaseId;
          }
          check();
          if (staged && !skipped) {
            restoreFinalizing = true;
            emitRestore({ ...blank, phase: "finalizing" });
            for (const [key, value] of Object.entries(
              staged.atlasPreferences ?? {},
            )) {
              check();
              localStorage.setItem(
                "atlas.profile.user:" +
                  grant.profileId +
                  ":replica:" +
                  staged.stagingReplicaId +
                  ":" +
                  key,
                value,
              );
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            try {
              account = await control.publishRestore(
                staged.stagingReplicaId,
                crypto.randomUUID(),
                staged.checkpointId,
                staged.deferredPreferences ?? [],
                [],
                activate,
              );
            } catch (error) {
              if (
                catalogRetry >= 1 ||
                !/^(LOCAL_CATALOG_CHANGED|LOCAL_STATE_REPLACEMENT_REQUIRES_NEW_INCARNATION)$/.test(
                  (error as Error).message,
                )
              )
                throw error;
              check();
              backup.stop();
              control.dispose();
              return createLocalFirstProfile(
                state,
                options,
                catalogRetry + 1,
                openedMetadataChecked,
              );
            }
            emitRestore({ ...blank, phase: "ready" });
            if (activate) {
              const url = new URL(location.href);
              for (const key of [
                "backupVersion",
                "activateBackup",
                "backupActivation",
              ])
                url.searchParams.delete(key);
              history.replaceState(history.state, "", url);
            }
            backup.stop();
            control.dispose();
            return createLocalFirstProfile(state, options, catalogRetry, true);
          }
        }
        if (skipped) restoreUnavailable = true;
      } catch (error) {
        emitRestore({ ...blank, phase: "error" });
        throw Object.assign(
          new Error(
            "Your backup could not finish loading. Retry, or continue without restoring. Your cloud backup is unchanged.",
          ),
          { code: "BACKUP_RESTORE_UNAVAILABLE", cause: error },
        );
      } finally {
        releaseRestoreReader();
        restoring = false;
        window.removeEventListener("atlas:backup-restore-skip", onSkip);
      }
      if (restoreUnavailable && version) {
        const url = new URL(location.href);
        for (const key of [
          "backupVersion",
          "activateBackup",
          "backupActivation",
        ])
          url.searchParams.delete(key);
        history.replaceState(history.state, "", url);
        sessionStorage.setItem(
          "atlas.backup.skip-once:" + grant.profileId,
          grant.contextId,
        );
        backup.stop();
        control.dispose();
        return createLocalFirstProfile(state, options, catalogRetry, true);
      }
      if (restoreUnavailable) {
        // Terminate the preparation actor before exposing native state. A late
        // network/decode completion cannot apply preferences or publish a pointer.
        backup.stop();
        try {
          account = await control.cloudUnavailable();
        } catch (error) {
          if (
            catalogRetry >= 1 ||
            !/^(LOCAL_CATALOG_CHANGED|LOCAL_STATE_REPLACEMENT_REQUIRES_NEW_INCARNATION)$/.test(
              (error as Error).message,
            )
          )
            throw error;
          check();
          control.dispose();
          return createLocalFirstProfile(
            state,
            options,
            catalogRetry + 1,
            openedMetadataChecked,
          );
        }
        control.dispose();
        return createLocalFirstProfile(
          state,
          options,
          catalogRetry,
          openedMetadataChecked,
        );
      }
      try {
        account = await control.cloudEmpty([]);
      } catch (error) {
        if (
          catalogRetry >= 1 ||
          !/^(LOCAL_CATALOG_CHANGED|LOCAL_STATE_REPLACEMENT_REQUIRES_NEW_INCARNATION)$/.test(
            (error as Error).message,
          )
        )
          throw error;
        check();
        backup.stop();
        control.dispose();
        return createLocalFirstProfile(
          state,
          options,
          catalogRetry + 1,
          openedMetadataChecked,
        );
      }
    }
    check();
    authority = Object.freeze({
      version: 2,
      profileId: grant.profileId,
      replicaId: account.replicaId,
      localAuthGeneration: crypto.randomUUID().replaceAll("-", ""),
      browserSessionId: crypto.randomUUID().replaceAll("-", ""),
    });
    setActiveProfile(grant.profileId);
    setActiveProfileContext(grant.contextId);
    setActiveLocalAuthority(authority);
    const publishStatus = () => {
      if (!stopped)
        options.onStatus({
          local: "ready",
          freshWorkspace: !!freshWorkspace,
          nativeOnly: true,
          legacyDataNotImported: !freshWorkspace,
          restoreUnavailable,
          newerBackup,
          checkingLatest,
          latestCheckError,
          backup: backup.status(),
          legacy: [],
        });
    };
    function checkLatest(): Promise<NewerBackup | null> {
      check();
      if (latestFlight) return latestFlight;
      checkingLatest = true;
      latestCheckError = undefined;
      publishStatus();
      const flight = (async () => {
        try {
          const result = (await backup.latest()) as {
            checkpoint?: {
              checkpointId?: string;
              publicationOrdinal?: string | number;
              completedAt?: string;
            };
            receipt?: {
              checkpointId?: string;
              publicationOrdinal?: string | number;
              completedAt?: string;
            };
          };
          check();
          const candidate = result.checkpoint,
            number = ordinal(
              result.receipt?.publicationOrdinal ??
                candidate?.publicationOrdinal,
            );
          const current = backup.status().lastCompleted,
            currentNumber = ordinal(current?.publicationOrdinal),
            seedNumber = ordinal(account.seedPublicationOrdinal);
          const minimum =
            currentNumber === null
              ? seedNumber
              : seedNumber === null
                ? currentNumber
                : currentNumber > seedNumber
                  ? currentNumber
                  : seedNumber;
          if (!candidate) {
            newerBackup = undefined;
            return null;
          }
          if (
            result.receipt?.checkpointId &&
            result.receipt.checkpointId !== candidate.checkpointId
          )
            throw Error("Completed backup identity did not match its receipt.");
          const completedAt =
            result.receipt?.completedAt ?? candidate.completedAt;
          if (
            !candidate.checkpointId ||
            !/^[a-f0-9-]{36}$/i.test(candidate.checkpointId) ||
            number === null ||
            !completedAt ||
            !Number.isFinite(Date.parse(completedAt))
          )
            throw Error("Completed backup metadata was invalid.");
          newerBackup =
            candidate.checkpointId === current?.checkpointId ||
            candidate.checkpointId === account.seedCheckpointId ||
            (minimum !== null && number <= minimum)
              ? undefined
              : {
                  checkpointId: candidate.checkpointId,
                  publicationOrdinal: String(number),
                  completedAt,
                };
          return newerBackup ?? null;
        } catch (error) {
          if (!stopped) {
            latestCheckError =
              "Cloud backups are unavailable. Browsing continues locally.";
          }
          return null;
        } finally {
          checkingLatest = false;
          latestFlight = undefined;
          publishStatus();
        }
      })();
      latestFlight = flight;
      return flight;
    }
    async function loadLatest(): Promise<string | undefined> {
      const offer = await checkLatest();
      check();
      if (!offer) {
        if (latestCheckError) throw Error(latestCheckError);
        return undefined;
      }
      const url = new URL(location.href);
      url.searchParams.set("backupVersion", offer.checkpointId);
      url.searchParams.set("activateBackup", "1");
      url.searchParams.set("backupActivation", crypto.randomUUID());
      url.searchParams.delete("freshWorkspace");
      url.searchParams.delete("atlasLocalFirst");
      return url.href;
    }
    const guard = (origin: string) => {
      check();
      let flight = flights.get(origin);
      if (!flight) {
        flight = (async () => {
          const site = await control.prepareSite(origin);
          check();
          if (site.mode !== "local-v2" || site.cookieLocal !== true)
            throw new Error(
              "Native website storage initialization failed; legacy synchronization remains disabled.",
            );
          setLocalCookieProfileReady(true);
          setLocalSiteMode(origin, { mode: "local-v2" });
          backup.dirty([
            { kind: "local", origin },
            { kind: "cookies", origin },
            { kind: "idb", origin },
          ]);
        })().finally(() => flights.delete(origin));
        flights.set(origin, flight);
      }
      return flight;
    };
    const ready = new Set<string>();
    setProfileDocumentGuard(async (origin) => {
      check();
      if (ready.has(origin)) return;
      await guard(origin);
      ready.add(origin);
    });
    let dirtyTimer: ReturnType<typeof setTimeout> | undefined,
      inputTimer: ReturnType<typeof setTimeout> | undefined;
    const preferenceQueue = new Map<string, string | null>(),
      preferenceSeen = new Map<string, string | null>();
    const preferenceDeferred = new Map<string, string>(),
      deferredSeen = new Map<string, string>();
    const preferenceRevisions = new Map<string, number>();
    let nextPreferenceRevision = 0;
    let preferenceFlight = false;
    const preferencePrefix = `atlas.profile.user:${grant.profileId}:replica:${authority.replicaId}:`;
    const currentAuthority = () => {
      const current = getActiveLocalAuthority(), session = options.current();
      return !stopped && current?.profileId === authority.profileId &&
        current.replicaId === authority.replicaId &&
        current.localAuthGeneration === authority.localAuthGeneration &&
        current.browserSessionId === authority.browserSessionId &&
        session?.grant?.profileId === grant.profileId &&
        session.grant.contextId === grant.contextId &&
        session.grant.sessionId === grant.sessionId;
    };
    const canonicalPreference = (key: string) => {
      if (!currentAuthority() || !portableAtlasKey(key)) return undefined;
      try { return localStorage.getItem(preferencePrefix + key); } catch { return undefined; }
    };
    function queueCanonical(key: string, force = false, value = canonicalPreference(key)) {
      if (value === undefined) return;
      if (value !== null && 64 + 2 * (key.length + value.length) > 256 * 1024) {
        if (preferenceDeferred.get(key) === value || (!force && !preferenceQueue.has(key) && !preferenceDeferred.has(key) && deferredSeen.get(key) === value)) return;
        preferenceRevisions.set(key, ++nextPreferenceRevision);
        preferenceDeferred.set(key, value); preferenceQueue.delete(key);
      } else {
        if (preferenceQueue.has(key) && preferenceQueue.get(key) === value) return;
        if (!force && !preferenceQueue.has(key) && !preferenceDeferred.has(key) && !deferredSeen.has(key) &&
            preferenceSeen.has(key) && preferenceSeen.get(key) === value) return;
        preferenceRevisions.set(key, ++nextPreferenceRevision);
        preferenceDeferred.delete(key); deferredSeen.delete(key); preferenceQueue.set(key, value);
      }
      armDirty();
    }
    const nativeHints = createBackupDirtyHints();
    function armDirty(delay = 250) {
      if (dirtyTimer || stopped) return;
      dirtyTimer = setTimeout(() => {
        dirtyTimer = undefined;
        void drain();
      }, delay);
    }
    async function drain() {
      if (!currentAuthority() || preferenceFlight) return;
      // One coalesced control message, never one network request per mutation.
      if (nativeHints.pending) backup.dirty(nativeHints.take());
      const batch: Record<string, string | null> = {};
      const revisions = new Map<string, number>(), deferredValues = new Map<string, string>();
      const started = performance.now();
      let bytes = 0, count = 0;
      for (const key of new Set([...preferenceQueue.keys(), ...preferenceDeferred.keys()])) {
        if (count >= 16 || bytes >= 64 * 1024 || performance.now() - started >= 4) break;
        // An event may be stale, or another window may have changed canonical
        // storage while this coordinator was asleep. Never replay event bytes.
        const value = canonicalPreference(key);
        if (value === undefined) continue;
        queueCanonical(key, false, value);
        if (!preferenceQueue.has(key) && !preferenceDeferred.has(key)) continue;
        count++; bytes += 2 * (key.length + (value?.length ?? 0));
        revisions.set(key, preferenceRevisions.get(key)!);
        if (preferenceDeferred.has(key)) deferredValues.set(key, value!);
        else batch[key] = value;
      }
      const deferred = [...deferredValues.keys()];
      if (!Object.keys(batch).length && !deferred.length) return;
      preferenceFlight = true;
      try {
        await backup.preferences(batch, deferred);
        for (const [key, value] of Object.entries(batch)) {
          const canonical = canonicalPreference(key);
          if (canonical === undefined) { armDirty(60000); continue; }
          if (canonical !== value) { queueCanonical(key, true, canonical); continue; }
          if (preferenceRevisions.get(key) !== revisions.get(key)) continue;
          preferenceSeen.set(key, value);
          deferredSeen.delete(key);
          if (preferenceQueue.get(key) === value) preferenceQueue.delete(key);
        }
        for (const key of deferred) {
          const canonical = canonicalPreference(key);
          if (canonical === undefined) { armDirty(60000); continue; }
          if (canonical !== deferredValues.get(key)) { queueCanonical(key, true, canonical); continue; }
          if (preferenceRevisions.get(key) !== revisions.get(key)) continue;
          preferenceDeferred.delete(key);
          deferredSeen.set(key, canonical!);
        }
      } catch {
        // Keep the same bounded pending entries until native mirror completion.
        // A backup worker crash cannot revoke or reject their original UI save.
        armDirty(60000);
      } finally {
        preferenceFlight = false;
        if (
          nativeHints.pending ||
          preferenceQueue.size ||
          preferenceDeferred.size
        )
          armDirty();
      }
    }
    const dirty = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        !currentAuthority() || detail?.profileId !== grant.profileId ||
        (detail?.replicaId && detail.replicaId !== authority.replicaId)
      )
        return;
      if (event.type === "atlas:profile-native-change") nativeHints.add(detail);
      if (
        event.type === "atlas:profile-user-change" &&
        typeof detail.key === "string" && portableAtlasKey(detail.key)
      ) {
        queueCanonical(detail.key);
      }
      armDirty();
    };
    const foreground = () => {
      if (inputTimer) return;
      backup.foreground();
      inputTimer = setTimeout(() => {
        inputTimer = undefined;
        if (!stopped) backup.foreground();
      }, 250);
    };
    window.addEventListener("atlas:profile-native-change", dirty);
    window.addEventListener("atlas:profile-user-change", dirty);
    window.addEventListener("atlas:profile-foreground", foreground);
    for (const event of ["keydown", "pointerdown", "wheel", "touchstart"])
      window.addEventListener(event, foreground, {
        capture: true,
        passive: true,
      });
    // Backup initialization is LOCAL ONLY and detached from readiness. A worker
    // exception changes the cloud status, never the local guard or actor.
    void backup.initialize().catch(() => {});
    let cancelSeed: (() => void) | undefined, reconciliationFlight = false, reconciliationRequested = false;
    let reconciliationTimer: ReturnType<typeof setTimeout> | undefined,
      reconciliationYield: (() => void) | undefined;
    async function reconcile() {
      if (!currentAuthority()) return;
      if (reconciliationFlight) { reconciliationRequested = true; return; }
      clearTimeout(reconciliationTimer); reconciliationTimer = undefined;
      reconciliationFlight = true;
      try {
        cancelSeed?.();
        cancelSeed = seedPortableAtlasPreferences(authority, (key) => queueCanonical(key, true), { current: currentAuthority });
        let cursor: { phase: "values" | "deferred"; after?: string } | undefined;
        do {
          const page = await backup.preferenceKeys(cursor);
          if (!currentAuthority()) return;
          if (!Array.isArray(page.keys) || page.keys.length > 64) throw Error("BACKUP_PREFERENCES_PAGE_INVALID");
          let keys = 0, bytes = 0, start = performance.now();
          for (const key of page.keys) {
            if (!currentAuthority()) return;
            if (keys >= 16 || bytes >= 64 * 1024 || performance.now() - start >= 4) {
              await new Promise<void>(resolve => { reconciliationYield = resolve;
                reconciliationTimer = setTimeout(() => { reconciliationTimer = undefined; reconciliationYield = undefined; resolve(); }, 16); });
              if (!currentAuthority()) return;
              keys = bytes = 0; start = performance.now();
            }
            const value = canonicalPreference(key);
            if (value === undefined) continue;
            queueCanonical(key, true, value); keys++; bytes += 2 * (key.length + (value?.length ?? 0));
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch {
        if (currentAuthority()) { clearTimeout(reconciliationTimer); reconciliationTimer = setTimeout(() => { reconciliationTimer = undefined; void reconcile(); }, 60000); }
      } finally {
        reconciliationFlight = false;
        if (reconciliationRequested && currentAuthority()) {
          reconciliationRequested = false; clearTimeout(reconciliationTimer);
          reconciliationTimer = setTimeout(() => { reconciliationTimer = undefined; void reconcile(); }, 16);
        }
      }
    }
    const storageChanged = (event: StorageEvent) => {
      if (!currentAuthority() || (event.storageArea && event.storageArea !== localStorage)) return;
      if (event.key === null) { void reconcile(); return; }
      if (event.key.startsWith(preferencePrefix)) queueCanonical(event.key.slice(preferencePrefix.length));
    };
    window.addEventListener("storage", storageChanged);
    // Reconcile every start, including canonical keys absent from the mirror
    // and mirror keys deleted while no coordinator was alive. Old seed markers
    // are diagnostics only and can never authorize skipping this work.
    void reconcile();
    const cancelReconciliationClock = (options.scheduleReconciliation ?? ((work: () => void, delay: number) => {
      const timer = setInterval(work, delay); return () => clearInterval(timer);
    }))(() => { void reconcile(); }, 60000);
    const resumeReconciliation = () => { if (document.visibilityState === "visible") void reconcile(); };
    window.addEventListener("focus", resumeReconciliation);
    document.addEventListener("visibilitychange", resumeReconciliation);
    publishStatus();
    if (!freshWorkspace && !version && !openedMetadataChecked)
      void checkLatest();
    return {
      get stopped() {
        return stopped;
      },
      get authority() {
        return authority;
      },
      backup,
      checkLatest,
      loadLatest,
      same(s: HubClientSession) {
        return (
          !stopped &&
          s.grant?.profileId === grant.profileId &&
          s.grant.contextId === grant.contextId &&
          s.grant.sessionId === grant.sessionId
        );
      },
      flush: () => backup.flush(),
      retry: () => backup.retry(),
      stop() {
        if (stopped) return;
        if (sameLocalActorAuthority(getActiveLocalAuthority(), authority))
          window.dispatchEvent(new CustomEvent("atlas:profile-local-before-revoke", {
            detail: { generation: authority.localAuthGeneration },
          }));
        stopped = true;
        clearTimeout(dirtyTimer);
        clearTimeout(inputTimer);
        cancelSeed?.();
        clearTimeout(reconciliationTimer); reconciliationYield?.();
        cancelReconciliationClock();
        window.removeEventListener("focus", resumeReconciliation);
        document.removeEventListener("visibilitychange", resumeReconciliation);
        window.removeEventListener("storage", storageChanged);
        window.removeEventListener("atlas:profile-native-change", dirty);
        window.removeEventListener("atlas:profile-user-change", dirty);
        window.removeEventListener("atlas:profile-foreground", foreground);
        for (const event of ["keydown", "pointerdown", "wheel", "touchstart"])
          window.removeEventListener(event, foreground, true);
        if (clearActiveLocalAuthority(authority))
          setProfileDocumentGuard(undefined);
        window.dispatchEvent(
          new CustomEvent("atlas:profile-local-revoke", {
            detail: { generation: authority.localAuthGeneration },
          }),
        );
        backup.stop();
        control.dispose();
      },
    };
  } catch (error) {
    backup.stop();
    control.dispose();
    throw error;
  }
}
