import type {LocalFirstStatus} from './local-first-profile.ts';
let activeV2: Awaited<ReturnType<typeof import('./local-first-profile.ts').createLocalFirstProfile>> | undefined;
export const getLocalFirstProfile = () => activeV2;
import { setProfileLimits } from "../../runtime/profile-limits.ts";
import { watchProfileWriters } from "./profile-wakeup";
import { checkpointProfileGroup } from "./profile-checkpoint";
import { rebasePreferenceChanges } from "./profile-preferences";
import { createProfileLocalStore } from "./profile-local-store";
/** Account profile orchestration lives exclusively in the trusted shell. Native
 * website commits precede remote outbox draining; remote errors never erase saves. */
import {
  registerHubInitializer,
  getHubSession,
  hubProfileRequest as rawRequest,
  type HubClientSession,
} from "./hub-client-state";
import {
  setActiveProfile,
  setActiveProfileContext,
  setProfileDocumentGuard,
  type ProfileDocumentOptions,
} from "../../runtime/profile-context";
import {
  invalidateProfilePermits,
} from "../../runtime/profile-permissions";
import {
  exportLegacyProfileData,
} from "../../runtime/profile-store";
import {
  drainProfileQueue,
  changeNamespace,
  type ProfileQueue,
} from "../../runtime/profile-sync";
import {
  HUB_LIMITS,
  hubNamespace,
  hubSiteGroup,
  type HubNamespace,
} from "../../runtime/hub-contracts";
import { portableAtlasKey } from "./model";
import { temporaryProfileFailure } from "./profile-errors";
import { loadProfileStream, loadProfileStreamHead } from "./profile-stream";
import { restoreProfileChunks } from "./profile-chunk-restore";
import { createProfileSyncScheduler } from "./profile-sync-scheduler";
import { withProfileGroupLock } from "../../runtime/profile-locks";
import { reserveLegacyOwner, runInitialProfileImport, type ProfileImportEntry } from "./profile-import";
import { legacyWebsiteOriginHints, migrateLegacyOrigin } from "./profile-legacy-migration";
type Writer = {
  epoch: number;
  expiresAt: string;
  siteGroup: string;
  contextId: string;
};
type Stream = {
  namespace: [string, string, string];
  revision: number;
  snapshotRevision: number;
};
type Manifest = {
  limits?: { localBytes?: number; idbBytes?: number };
  initialized: boolean;
  profileId: string;
  revision: number;
  streams: Stream[];
  writers?: Writer[];
};
export type ProfileStatus = {
  localFirst?: LocalFirstStatus;
  state:
    | "restoring"
    | "local"
    | "pending"
    | "synced"
    | "offline"
    | "conflict"
    | "error";
  message: string;
  origin?: string;
  importing?: boolean;
  canContinue?: boolean;
  handoff?: {
    phase: "offered" | "waiting" | "releasing" | "paused";
    siteGroup: string;
    origin?: string;
    error?: string;
    canUseBackup?: boolean;
    backupPending?: boolean;
  };
};
let status: ProfileStatus = {
  state: "restoring",
  message: "Restoring your browser…",
};
export const getProfileStatus = () => status;
const emit = (next: ProfileStatus) => {
  if (activeV2 && status.localFirst && !next.localFirst) next = {...next, localFirst: status.localFirst};
  const releaseError = status.handoff?.phase === "releasing" && status.handoff.error &&
    [...(active?.releases.values() ?? [])].some(r => r.siteGroup === status.handoff!.siteGroup);
  if (releaseError && ["local", "pending", "synced"].includes(next.state) &&
      !Object.hasOwn(next, "handoff"))
    next = { ...next, state: "error", message: status.handoff!.error!,
      origin: status.origin, canContinue: false, handoff: status.handoff };
  const checkpointFailure = !active?.stopped && [...(active?.releases.values() ?? [])].find(r => r.checkpointError);
  if (checkpointFailure && ["local", "pending", "synced"].includes(next.state) &&
      (!next.handoff || next.handoff.siteGroup === checkpointFailure.siteGroup))
    next = {
      ...next, state: "error", canContinue: false, handoff: undefined,
      origin: checkpointFailure.origin,
      message: "This website is still open. Its latest changes have not finished saving for transfer. Retry sync when it is ready.",
    };
  if (active?.incomplete && next.state === "synced")
    next = {
      ...next,
      state: "local",
      message:
        "Portable saves are backed up. Some older website data remains only on this browser and may need sign-in again.",
    };
  else if (active?.legacyRecoveryMessage && next.state === "synced")
    next = { ...next, state: "local", message: active.legacyRecoveryMessage };
  if (status.canContinue && next.canContinue === undefined)
    next = { ...next, canContinue: true, origin: status.origin };
  if (status.handoff && !Object.hasOwn(next, "handoff"))
    next = { ...next, handoff: status.handoff };
  status = next;
  window.dispatchEvent(
    new CustomEvent("atlas:profile-status", { detail: next }),
  );
};
const sha = async (value: string | Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : (value as BufferSource),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const fromTuple = (n: Stream["namespace"]): HubNamespace =>
  n[0] === "atlas"
    ? { kind: "atlas" }
    : {
        kind: n[0] as "local" | "idb" | "cookies",
        origin: n[0] === "cookies" ? "https://" + n[1] : n[1],
        ...(n[0] === "idb" ? { name: n[2] } : {}),
      };
let active: ProfileClient | undefined,
  initializing:
    | {
        identity: string;
        promise: Promise<{ ready: boolean; message?: string }>;
      }
    | undefined;
type ProfileLocalStore = ReturnType<typeof createProfileLocalStore>;
async function uploadPreparedWire(
  prepared: Awaited<ReturnType<ProfileLocalStore["prepareWire"]>>,
  request: typeof rawRequest,
  local: ProfileLocalStore,
  beforeChunk?: () => Promise<void>,
): Promise<unknown> {
  if (!("handle" in prepared)) return prepared;
  try {
    for (let index = 0; index < prepared.hashes.length; index++) {
      await beforeChunk?.();
      const chunk = await local.wireChunk(prepared.handle, index);
      if (chunk.hash !== prepared.hashes[index]) throw Error("Profile chunk integrity mismatch.");
      await request("/chunks", "POST", chunk.body);
    }
    return { codec: "atlas-chunks-v1", hashes: prepared.hashes, bytes: prepared.bytes, sha256: prepared.sha256 };
  } finally {
    // Never keep a large encoded graph in memory after a failed upload.
    await local.releaseWire(prepared.handle).catch(() => {});
  }
}
async function unwire(
  value: any,
  request: typeof rawRequest,
  local: ProfileLocalStore,
): Promise<any> {
  if (value === null) return null;
  if (value.codec === "atlas-chunks-v1") {
    if (
      !Array.isArray(value.hashes) || !value.hashes.length || value.hashes.length > 64 ||
      value.hashes.some((h: unknown) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > HUB_LIMITS.streamBytes
    ) throw Error("Invalid profile chunks.");
    const data = new Uint8Array(value.bytes);
    let length = 0;
    for (const hash of value.hashes) {
      const chunk = await request<{ data: string }>("/chunks/" + hash);
      // Base64 validation/decoding and hashing happen in the local worker too;
      // only bounded ArrayBuffers, never a full decoded graph, cross this agent.
      const bytes = await local.decodeChunk(chunk.data, hash);
      length += bytes.byteLength;
      if (length > data.byteLength) throw Error("PROFILE_STREAM_SIZE_EXCEEDED");
      data.set(new Uint8Array(bytes), length - bytes.byteLength);
    }
    if (length !== value.bytes) throw Error("Profile integrity mismatch.");
    return local.decodeWireBytes(data.buffer, value.sha256);
  }
  return local.decodeWire(value);
}
const prefPrefix = (id: string) => "atlas.profile.user:" + id + ":";
function userData(id?: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    const name =
      id && k.startsWith(prefPrefix(id))
        ? k.slice(prefPrefix(id).length)
        : !id
          ? k
          : "";
    if (portableAtlasKey(name)) {
      const v = localStorage.getItem(k);
      if (v !== null) values[name] = v;
    }
  }
  return values;
}
function restoreUser(id: string, value: any) {
  if (
    value?.format !== "atlas-user-snapshot-v1" ||
    !value.values ||
    typeof value.values !== "object"
  )
    throw Error("Invalid Atlas preferences.");
  if (!Object.hasOwn(value.values, "atlas.onboarded"))
    value.values["atlas.onboarded"] = "true";
  for (const [key, v] of Object.entries(value.values))
    if (portableAtlasKey(key) && typeof v === "string")
      localStorage.setItem(prefPrefix(id) + key, v);
  const windows = Object.entries(value.values).filter(([k]) =>
    k.startsWith("atlas.windows.v1."),
  );
  if (windows.length && !value.values["atlas.tabs"]) {
    const v = JSON.parse(String(windows.at(-1)![1]));
    localStorage.setItem(
      prefPrefix(id) + "atlas.tabs",
      JSON.stringify(v.tabs || []),
    );
  }
}
async function reserveLegacy(id: string) {
  return reserveLegacyOwner(id, localStorage, (run) =>
    navigator.locks.request(
      "atlas-profile-legacy-import",
      { mode: "exclusive" },
      run,
    ),
  );
}

class ProfileClient {
  readonly id: string;
  readonly context: string;
  readonly session: string;
  readonly local: ReturnType<typeof createProfileLocalStore>;
  writers = new Map<string, { namespace: HubNamespace; writer: Writer }>();
  private originFlights = new Map<string, Promise<void>>();
  private readyGroups = new Map<string, number>();
  private localRepairResume = new Map<string, number>();
  timer?: number;
  watcher?: ReturnType<typeof watchProfileWriters>;
  writerHint = 0;
  writerWaiters = new Set<() => void>();
  handoffFlight?: Promise<void>;
  handoffDirty = false;
  tickFlight?: Promise<void>;
  takeovers = new Map<string, Promise<void>>();
  takeoverChoices = new Map<string, { handoffId?: string; backupRequested: boolean; opening: boolean; error?: string }>();
  releases = new Map<string, { id: string; siteGroup: string; epoch: number; origin?: string; fenced?: boolean; fencing?: boolean; checkpointError?: boolean }>();
  flight?: Promise<void>;
  repairFlight?: Promise<void>;
  private repairingGroups = new Set<string>();
  private backupScheduler?: ReturnType<typeof createProfileSyncScheduler>;
  private pendingBackupCheck?: Promise<void>;
  private backupFailureGroups = new Set<string>();
  private lastBackupFailure?: Error;
  stopped = false;
  ready = false;
  incomplete = false;
  cancelImport = false;
  userBase: Record<string, string> = {};
  recovered = false;
  legacyRecoveryMessage = "";
  replacementFlight?: Promise<void>;
  replacementFences = new Set<string>();
  constructor(state: HubClientSession, private readonly manageGuard = true) {
    const g = state.grant!;
    this.id = g.profileId;
    this.context = g.contextId;
    this.session = g.sessionId;
    this.local = createProfileLocalStore(this.id);
    window.addEventListener("atlas:profile-cancel-import", this.cancel);
  }
  same(s: HubClientSession) {
    return (
      this.id === s.grant?.profileId &&
      this.context === s.grant.contextId &&
      this.session === s.grant.sessionId
    );
  }
  check() {
    const s = getHubSession();
    if (this.stopped || active !== this || !s || !this.same(s))
      throw Object.assign(
        Error("The account changed. This operation was stopped."),
        { code: "PROFILE_CONTEXT_CHANGED" },
      );
  }
  request<T = unknown>(path = "", method = "GET", body?: unknown): Promise<T> {
    this.check();
    return rawRequest<T>(path, method, body).then((value) => {
      this.check();
      return value;
    });
  }
  async wire(value: unknown) {
    const prepared = await this.local.prepareWire(value);
    this.check();
    return uploadPreparedWire(prepared, this.request.bind(this), this.local);
  }
  private withGroup<T>(group: string, run: () => Promise<T>): Promise<T> {
    return withProfileGroupLock(this.id, group, async () => {
      this.check();
      return run();
    }, navigator.locks);
  }
  unwire(value: any) {
    return unwire(value, this.request.bind(this), this.local);
  }
  async initialize() {
    setActiveProfile(this.id);
    setActiveProfileContext(this.context);
    // The first signed-in account owns legacy data regardless of cloud state or
    // a later import cancellation. No legacy data is modified by this claim.
    const ownsLegacy = await reserveLegacy(this.id);
    this.check();
    this.incomplete = !!localStorage.getItem(
      "atlas.profile.portability-notice:" + this.id,
    );
    emit({
      state: "restoring",
      message: "Restoring your browser…",
      canContinue: false,
      handoff: undefined,
    });
    // The full normal controller requires its root worker. Only the previous
    // selfboot path retires known legacy workers; neither path wipes saves.
    const runtimeResponse = await fetch("/api/config", { cache: "no-store" });
    if (!runtimeResponse.ok) throw Error("PROFILE_RUNTIME_CONFIG_UNAVAILABLE");
    const runtimeConfig = await runtimeResponse.json();
    const keepsRootWorker = runtimeConfig.runtimeProtocols?.profile?.engine === "scramjet-controller";
    // Only retire known Atlas root workers; unrelated workers are not touched.
    for (const registration of (await navigator.serviceWorker?.getRegistrations?.()) ||
      [])
      if (
        !keepsRootWorker && new URL(registration.scope).pathname === "/" &&
        /\/(?:worker|sw)\.js(?:\?|$)/.test(registration.active?.scriptURL || "")
      )
        await registration.unregister();
    let m = await this.request<Manifest>();
    if (m.profileId !== this.id)
      throw Error("Profile identity did not match this account.");
    setProfileLimits(
      this.id,
      typeof m.limits?.localBytes === "number" &&
        typeof m.limits.idbBytes === "number"
        ? { localBytes: m.limits.localBytes, idbBytes: m.limits.idbBytes }
        : undefined,
    );
    const wasInitialized = m.initialized;
    let retainedInitialImport = false;
    let legacyData: (Awaited<ReturnType<typeof exportLegacyProfileData>> & { values: Record<string, string> }) | undefined;
    const legacy = async () => {
      this.check();
      if (!ownsLegacy) return { snapshots: [], hostStorage: [], cookieStores: [], values: {} };
      if (!legacyData) {
        const values = userData();
        const data = await exportLegacyProfileData(indexedDB, legacyWebsiteOriginHints(values));
        this.check();
        legacyData = { ...data, values };
      }
      return legacyData;
    };
    if (!m.initialized) {
      const r = await this.request<{ importId: string }>("/imports", "POST", {
        claimAccepted: true,
      });
      try {
        emit({
          state: "restoring",
          message: "Saving this browser to your account…",
          importing: true,
        });
        await new Promise((r) => setTimeout(r, 1200));
        const imported = await runInitialProfileImport({
          ownsLegacy,
          cancelled: () => this.cancelImport,
          exportSnapshots: async () => (await legacy()).snapshots,
          readUserData: () => userData(),
          wire: (value) => this.wire(value),
          freeze: () =>
            emit({
              state: "restoring",
              message: "Finishing account setup…",
              importing: false,
            }),
          manifestHash: async (entries) =>
            sha(
              JSON.stringify(
                await Promise.all(
                  entries.map(async (e) => [
                    hubNamespace(e.namespace).key,
                    await sha(JSON.stringify(e.payload)),
                  ]),
                ),
              ),
            ),
          commit: (entries, manifestHash) =>
            this.request<{ acknowledged: boolean }>(
              "/imports/" + r.importId + "/commit",
              "POST",
              { entries, manifestHash },
            ),
        });
        retainedInitialImport = imported.retained;
        // Only an acknowledged retained import can create this notice. A failed
        // or cancelled preparation must not label the empty profile incomplete.
        this.incomplete = imported.retained && imported.nonportable.length > 0;
        const noticeKey = "atlas.profile.portability-notice:" + this.id;
        if (this.incomplete)
          localStorage.setItem(noticeKey, JSON.stringify(imported.nonportable));
        else localStorage.removeItem(noticeKey);
      } catch (e) {
        await this.request("/imports/" + r.importId, "DELETE").catch(() => {});
        throw e;
      }
      m = await this.request<Manifest>();
    }
    // A second old frontend can contain DIFFERENT pre-Hub saves even though the
    // first frontend already initialized this account. Preserve those bytes
    // before cloud hydration, not just on the globally first import. Cancelled
    // first-browser imports still publish only defaults, as promised by Skip.
    if (ownsLegacy && (wasInitialized || retainedInitialImport)) {
      await navigator.locks.request("atlas-profile-legacy-import", async () => {
        const old = await legacy();
        const entries: ProfileImportEntry[] = wasInitialized ? [...old.snapshots] : [];
        if (wasInitialized && Object.keys(old.values).length)
          entries.push({ namespace: { kind: "atlas" }, payload: { format: "atlas-user-snapshot-v1", values: old.values } });
        // Host-only storage cannot always recover HTTP versus HTTPS. Keep its
        // exact raw representation downloadable; never guess an origin.
        if (old.hostStorage.length)
          entries.push({ namespace: { kind: "atlas" }, payload: { format: "atlas-legacy-host-storage-v1", hosts: old.hostStorage } });
        // Preserve divergent legacy jars independently. These wrappers are
        // recovery-only Atlas metadata, not canonical cookie stream payloads.
        for (const source of old.cookieStores)
          entries.push({ namespace: { kind: "atlas" }, payload: {
            format: "atlas-legacy-cookie-store-v1", database: source.database,
            namespace: source.namespace, snapshot: source.payload,
          } });
        const canonicalCookies = new Map<string, string>();
        for (const item of old.snapshots) {
          if (item.namespace.kind !== "cookies") continue;
          for (const cookie of ((item.payload as { cookies?: Array<{ id: string }> }).cookies || []))
            canonicalCookies.set(hubNamespace(item.namespace).key + ":" + cookie.id, JSON.stringify(cookie));
        }
        const differentLegacyCookies = old.cookieStores.some(source =>
          ((source.payload as { cookies?: Array<{ id: string }> }).cookies || []).some(cookie =>
            canonicalCookies.get(hubNamespace(source.namespace).key + ":" + cookie.id) !== JSON.stringify(cookie),
          ),
        );
        const pending = await this.local.queue.list();
        const report = await migrateLegacyOrigin({
          ownsLegacy, profileId: this.id, sourceOrigin: location.origin, storage: localStorage,
          check: () => this.check(), entries: async () => entries,
          blockedGroups: new Set(pending.map(c => hubNamespace(changeNamespace(c)).siteGroup)),
          wire: value => this.wire(value), hash: sha,
          recover: value => this.request("/recoveries", "POST", value),
          manifest: () => this.request<Manifest>(),
          receipt: id => this.request("/receipts/" + id),
          acquire: n => this.request<{ writer: Writer }>("/writers", "POST", { namespace: n }).then(r => r.writer),
          commit: value => this.request("/commits", "POST", value),
          release: (namespace, epoch) => this.releaseReplacementWriter(namespace, epoch),
        });
        if (report.partialGroups.length)
          this.legacyRecoveryMessage = "This address was only partly imported. Its complete older saves are preserved in Recovered saves; existing account saves were kept.";
        else if (report.preservedGroups.length || differentLegacyCookies || (wasInitialized && Object.keys(old.values).length > 0) || old.hostStorage.some(h => h.candidateOrigins.length !== 1))
          this.legacyRecoveryMessage = "Existing account saves were kept. Older saves from this address are preserved in Recovered saves.";
      });
      m = await this.request<Manifest>();
    }
    const pending = await this.local.queue.list();
    // Website data is hydrated by prepareOrigin, under its writer fence, before
    // any website document is mounted. Do not replay every historical website
    // during shell startup: it blocks entry and multiplies restoration traffic.
    // Retained native outboxes are still checked by prepareOrigin before restore.
    // Website storage is restored only by prepareOrigin, under its writer
    // fence, before any document or worker can access the site. Historical
    // websites must not block shell entry or be fetched again on first open.
    // Retained native journals still win over cloud hydration in prepareOrigin;
    // initial and later-origin legacy preservation above remains mandatory.
    const preferences = await this.request<{
      revision: number;
      values: Record<string, string>;
    }>("/preferences");
    const baseKey = "atlas.profile.user.base:" + this.id;
    if (!localStorage.getItem("atlas.profile.user.pending:" + this.id)) {
      restoreUser(this.id, {
        format: "atlas-user-snapshot-v1",
        values: { ...preferences.values },
      });
      this.userBase = preferences.values;
      localStorage.setItem(baseKey, JSON.stringify(this.userBase));
    } else {
      const saved = localStorage.getItem(baseKey);
      if (saved) {
        try {
          this.userBase = JSON.parse(saved);
        } catch {
          throw Error("Local settings recovery is required.");
        }
      } else {
        const local = userData(this.id),
          conflicts = Object.entries(local).filter(
            ([key, value]) =>
              preferences.values[key] !== undefined &&
              preferences.values[key] !== value,
          );
        if (conflicts.length) {
          const id = crypto.randomUUID();
          const ack = await this.request<{ acknowledged: boolean }>(
            "/recoveries",
            "POST",
            {
              id,
              namespace: { kind: "atlas" },
              payload: await this.wire({
                format: "atlas-user-recovery-v1",
                values: Object.fromEntries(conflicts),
              }),
            },
          );
          if (!ack.acknowledged)
            throw Error("Your local settings have not been backed up.");
          for (const [key, value] of Object.entries(preferences.values))
            localStorage.setItem(prefPrefix(this.id) + key, value);
        }
        this.userBase = preferences.values;
        localStorage.setItem(baseKey, JSON.stringify(this.userBase));
      }
    }
    this.check();
    if (this.manageGuard) setProfileDocumentGuard((origin, options) => this.ensureOrigin(origin, options));
    this.timer = window.setInterval(() => void this.tick(), 20000);
    window.addEventListener("online", this.online);
    window.addEventListener("pageshow", this.resume);
    window.addEventListener("pagehide", this.leaving);
    window.document?.addEventListener("visibilitychange", this.resume);
    window.addEventListener("offline", this.offline);
    window.addEventListener("atlas:profile-user-change", this.changed);
    window.addEventListener("atlas:profile-native-change", this.changed);
    window.addEventListener("atlas:replacement-sync", this.replacement);
    window.addEventListener("atlas:profile-cancel-import", this.cancel);
    this.check();
    this.ready = true;
    this.ensureWakeup();
    emit({
      state: pending.length ? "pending" : "synced",
      message: pending.length ? "Sync pending" : "Synced",
    });
    void this.tick();
  }
  cancel = () => {
    this.cancelImport = true;
  };
  ensureWakeup() {
    if (this.stopped || !this.ready || (this.watcher && !this.watcher.closed())) return;
    this.watcher?.close();
    try { this.watcher = watchProfileWriters(this.writersChanged); }
    catch { this.watcher = undefined; } // The independent twenty-second fallback remains active.
  }
  writersChanged = () => {
    if (this.stopped || active !== this) return;
    ++this.writerHint;
    for (const wake of [...this.writerWaiters]) wake();
    if (this.ready && (this.writers.size || this.releases.size))
      void this.processHandoffs().catch((e) => this.syncFailure(e));
  };
  waitForWriterHint(since: number, milliseconds = 1500) {
    if (this.stopped || this.writerHint !== since) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        this.writerWaiters.delete(finish);
        resolve();
      };
      const timer = window.setTimeout(finish, milliseconds);
      this.writerWaiters.add(finish);
    });
  }
  online = (event?: Event) => {
    this.ensureWakeup();
    if (event?.type === "online" && this.backupScheduler?.pending() &&
        !this.backupScheduler.inspect().paused)
      void this.flush().catch(error => this.syncFailure(error));
    void this.tick();
  };
  resume = () => {
    if (window.document?.visibilityState !== "hidden") this.online();
    else this.leaving();
  };
  leaving = () => {
    // Best effort on hide/close; the durable local journal remains the source
    // of truth if the browser exits before a cloud acknowledgement arrives.
    if (!this.stopped && (this.backupScheduler?.pending() ||
        localStorage.getItem("atlas.profile.user.pending:" + this.id)))
      return this.flush().catch((e) => this.syncFailure(e));
  };
  offline = () => {
    void this.markOffline();
    emit({ state: "offline", message: "Saved locally · offline" });
  };
  changed = (event?: Event) => {
    if (this.stopped) return;
    const detail = (event as CustomEvent | undefined)?.detail;
    if (detail?.profileId && detail.profileId !== this.id) return;
    let group = event?.type === "atlas:profile-user-change" ? "@atlas" : undefined;
    try { if (detail?.origin) group = hubSiteGroup(detail.origin); } catch { /* Unknown hints cannot bypass a pause. */ }
    const scheduler = this.backgroundBackup();
    const independent = !!group && this.backupFailureGroups.size > 0 &&
      !this.backupFailureGroups.has("*") && !this.backupFailureGroups.has(group);
    // Keep a permanent backup failure visible while new local edits accrue.
    // A dirty notification is not evidence that repair/quota trouble ended.
    if ((!scheduler.pending() && !scheduler.inspect().paused) || independent)
      emit({ state: "pending", message: "Saved locally · sync pending" });
    // Notifications follow a durable native commit; cloud backup is separately
    // paced. Continuous mutations cannot postpone the first-change deadline.
    scheduler.changed(detail?.kind === "cookies" ? "cookies" : "data", { resumePaused: independent });
  };
  private backgroundBackup() {
    return this.backupScheduler ??= createProfileSyncScheduler({
      run: () => this.flushBackingStore(),
      onError: error => this.syncFailure(error),
      onSuccess: ({ pending }) => {
        if (pending && !this.stopped && active === this)
          emit({ state: "pending", message: "Saved locally · sync pending" });
      },
      retryable: error => temporaryProfileFailure(error) ||
        (error as { code?: string })?.code === "PROFILE_SYNC_PENDING",
      clock: {
        now: () => Date.now(),
        setTimeout: (work, delay) => window.setTimeout(work, delay),
        clearTimeout: handle => window.clearTimeout(handle as number),
      },
    });
  }
  private checkPendingBackups(): Promise<void> {
    if (this.pendingBackupCheck) return this.pendingBackupCheck;
    const flight = (async () => {
      if (this.stopped) return;
      // Worker returns journal metadata, not website payloads. This catches a
      // missed event/reopened durable outbox without an idle cloud request.
      const pending = (await this.local.queue.list()).filter(change =>
        !this.groupRepairPending(hubNamespace(changeNamespace(change)).siteGroup));
      this.check();
      const preferences = !!localStorage.getItem("atlas.profile.user.pending:" + this.id);
      if (pending.length || preferences) {
        const scheduler = this.backgroundBackup();
        if (!scheduler.pending())
          emit({ state: "pending", message: "Saved locally · sync pending" });
        scheduler.reconcileDirty(!preferences &&
          pending.every(change => change.entry.kind === "cookies") ? "cookies" : "data");
      }
    })().finally(() => {
      if (this.pendingBackupCheck === flight) this.pendingBackupCheck = undefined;
    });
    this.pendingBackupCheck = flight;
    return flight;
  }
  replacement = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    void this.prepareReplacement()
      .then(() =>
        window.dispatchEvent(
          new CustomEvent("atlas:replacement-synced", {
            detail: { requestId: detail.requestId, ok: true },
          }),
        ),
      )
      .catch((e) =>
        window.dispatchEvent(
          new CustomEvent("atlas:replacement-synced", {
            detail: {
              requestId: detail.requestId,
              ok: false,
              error: e.message,
            },
          }),
        ),
      );
  };
  writerFenced(group: string) {
    return this.replacementFences.has(group) || (this.repairNamespaces().some(n => hubNamespace(n).siteGroup === group) &&
      this.localRepairResume.get(group) !== this.writers.get(group)?.writer.epoch) ||
      [...this.releases.values()].some(r => r.siteGroup === group && (r.fenced || r.fencing));
  }
  private checkedWriter(group: string, epoch: number, repairing = false): Writer {
    this.check();
    const writer = this.writers.get(group)?.writer;
    const fenced = repairing
      ? this.replacementFences.has(group) || [...this.releases.values()].some(r => r.siteGroup === group && (r.fenced || r.fencing))
      : this.writerFenced(group);
    if (!writer || writer.contextId !== this.context || writer.epoch !== epoch || fenced ||
        !Number.isFinite(Date.parse(writer.expiresAt)) || Date.parse(writer.expiresAt) <= Date.now())
      throw Object.assign(Error("This website's ownership changed while restoring. Your local saves are retained."), { code: "PROFILE_RECOVERY_REQUIRED" });
    return writer;
  }
  async releaseReplacementWriter(namespace: HubNamespace, epoch: number) {
    try {
      const result = await this.request<{ ok: boolean }>("/writers", "DELETE", { namespace, epoch });
      if (result.ok !== true) throw Error("The previous browser has not released its saves.");
      return result;
    } catch (error: any) {
      if (!temporaryProfileFailure(error) && error.code !== "HUB_WRITER_LOST") throw error;
      // DELETE may have succeeded before its response was lost. Verify actual
      // ownership rather than waiting 90s or trying to release a newer writer.
      const m = await this.request<Manifest>();
      if (!Array.isArray(m.writers) || m.writers.some(w => w.siteGroup === hubNamespace(namespace).siteGroup && w.contextId === this.context && w.epoch === epoch))
        throw error;
      return { ok: true };
    }
  }
  prepareReplacement() {
    if (this.replacementFlight) return this.replacementFlight;
    const flight = (async () => {
      this.check();
      await this.tickFlight;
      await this.handoffFlight;
      await this.repairFlight; // Explicit full-browser replacement needs every fenced group settled.
      this.check();
      const owners = [...this.writers.entries()];
      // All native checkpoints run while their website documents are mounted
      // and ownership is still valid. Any failure leaves every page intact.
      for (const [group] of owners)
        if (group !== "@atlas" && !this.writerFenced(group)) await checkpointProfileGroup(group);
      this.check();
      for (const [group] of owners) this.replacementFences.add(group);
      window.dispatchEvent(new CustomEvent("atlas:profile-quiesce"));
      for (const [group, item] of owners)
        if (group !== "@atlas") await this.local.setPermit({
          profileId: this.id, group, contextId: this.context, epoch: item.writer.epoch,
          expiresAt: 0, offline: false, revoked: true,
        });
      await this.flush(); // Positive cloud ACK and empty durable outbox required.
      this.check();
      for (const [group, item] of owners) {
        if (this.writers.get(group)?.writer.epoch !== item.writer.epoch) continue;
        await this.releaseReplacementWriter(item.namespace, item.writer.epoch);
        this.writers.delete(group);
      }
    })().finally(() => { if (this.replacementFlight === flight) this.replacementFlight = undefined; });
    this.replacementFlight = flight;
    return flight;
  }
  async markOffline() {
    for (const [group, item] of this.writers) {
      const releasing = this.writerFenced(group);
      await this.local.setPermit({
        profileId: this.id,
        group,
        contextId: this.context,
        epoch: item.writer.epoch,
        expiresAt: releasing ? 0 : Date.parse(item.writer.expiresAt),
        offline: true,
        revoked: releasing,
      });
    }
  }
  async restore(n: HubNamespace, epoch: number) {
    await this.withGroup(hubNamespace(n).siteGroup, () => this.restoreLocked(n, epoch));
  }
  private async restoreLocked(n: HubNamespace, epoch: number, force = false) {
    // Native readHead validates that the underlying website database still
    // exists. Reuse only the exact established owner, never a different epoch.
    const head = force ? null : await this.local.readHead(n);
    if (head && (epoch === 0 || head.epoch === epoch)) {
      const metadata = await loadProfileStreamHead(
        body => this.request("/stream", "POST", body), n,
      );
      if (head.revision === metadata.revision) return;
    }
    const remote = await loadProfileStream(
      body => this.request("/stream", "POST", body), n,
    );
    await this.hydrateStream(n, remote, epoch, "restore");
  }
  private async hydrateStream(n: HubNamespace, remote: Awaited<ReturnType<typeof loadProfileStream>>, epoch: number, operation: "restore" | "compact") {
    const check = () => {
      this.check();
      if (epoch > 0) this.checkedWriter(hubNamespace(n).siteGroup, epoch, true);
    };
    check();
    const handle = await this.local.beginHydration({ namespace: n, revision: remote.revision,
      snapshotRevision: remote.snapshotRevision, journal: remote.journal.map(({ revision, mode }) => ({ revision, mode })),
      head: { revision: remote.revision, epoch }, operation });
    try {
      const values = [remote.snapshot, ...remote.journal.map(entry => entry.payload)];
      for (let index = 0; index < values.length; index++) {
        check();
        const value = values[index] as any;
        await this.local.hydrateValue(handle, index, value);
        if (value?.codec === "atlas-chunks-v1")
          await restoreProfileChunks(value, {
            read: hash => this.request<{ data: string }>("/chunks/" + hash),
            apply: (part, data) => this.local.hydrateChunk(handle, part, data),
            check,
          });
      }
      check();
      return await this.local.finishHydration(handle);
    } finally { await this.local.abortHydration(handle).catch(() => {}); }
  }
  async writer(n: HubNamespace): Promise<Writer> {
    const group = hubNamespace(n).siteGroup,
      old = this.writers.get(group);
    if (old && Date.parse(old.writer.expiresAt) > Date.now() + 10000)
      return old.writer;
    const result = await this.request<{ writer: Writer }>("/writers", "POST", {
      namespace: n,
    }).catch((e) => { throw this.writerFailure(e, n); });
    this.writers.set(group, { namespace: n, writer: result.writer });
    return result.writer;
  }
  writerFailure(error: any, n: HubNamespace) {
    if (error && ["HUB_WRITER_LOST", "HUB_WRITER_BUSY", "HUB_HANDOFF_EXPIRED"].includes(error.code))
      Object.assign(error, { siteGroup: hubNamespace(n).siteGroup, origin: n.origin });
    return error;
  }
  ensureOrigin(origin: string, { interactive = true }: ProfileDocumentOptions = {}): Promise<void> {
    const group = hubSiteGroup(origin);
    let flight = this.originFlights.get(group);
    if (!flight) {
      flight = this.prepareOrigin(origin).finally(() => {
        if (this.originFlights.get(group) === flight) this.originFlights.delete(group);
      });
      this.originFlights.set(group, flight);
    }
    return flight.catch((e) => {
      if (e.code === "HUB_WRITER_BUSY") {
        if (interactive) emit({
          state: "conflict", message: "This website is open in another browser.",
          origin, canContinue: true, handoff: { phase: "offered", siteGroup: group, origin },
        });
        throw Error("Select Continue here to open this website.");
      }
      throw e;
    });
  }
  private async prepareOrigin(origin: string) {
    this.check();
    const group = hubSiteGroup(origin), prior = this.writers.get(group);
    // Already-live documents never queue behind their own background uploads.
    // Cold/restoring documents recheck all decisions inside the site's lock.
    if (prior && this.readyGroups.get(group) === prior.writer.epoch &&
        Date.parse(prior.writer.expiresAt) > Date.now() + 10000 &&
        !this.repairNamespaces().some(n => hubSiteGroup(n.origin!) === group) &&
        ![...this.releases.values()].some(r => r.siteGroup === group)) return;
    return this.withGroup(group, () => this.prepareOriginLocked(origin));
  }
  private async prepareOriginLocked(origin: string) {
    this.check();
    const n: HubNamespace = { kind: "local", origin },
      group = hubSiteGroup(origin),
      prior = this.writers.get(group);
    const repairPending = this.repairNamespaces().some(n => hubSiteGroup(n.origin!) === group);
    if (repairPending && !(prior && this.localRepairResume.get(group) === prior.writer.epoch &&
        this.readyGroups.get(group) === prior.writer.epoch && Date.parse(prior.writer.expiresAt) > Date.now() + 10000))
      throw Error("Repair synchronization from Your saves before reopening this website.");
    if ([...this.releases.values()].some((r) => r.siteGroup === group))
      throw Object.assign(Error("This website is finishing its saves in this browser."), { code: "PROFILE_HANDOFF_PENDING" });
    try {
      // A writer lease can exist while its saves/permit are still restoring.
      // Only the fully hydrated epoch may take the document-ready fast path.
      if (prior && this.readyGroups.get(group) === prior.writer.epoch && Date.parse(prior.writer.expiresAt) > Date.now() + 10000)
        return;
      const w = await this.writer(n),
        m = await this.request<Manifest>(),
        q = await this.local.queue.list(group);
      for (const stream of m.streams) {
        const ns = fromTuple(stream.namespace);
        if (
          hubNamespace(ns).siteGroup === group &&
          !q.some(
            (c) =>
              hubNamespace({
                kind: c.entry.kind,
                origin: c.entry.origin,
                ...(c.entry.kind === "idb" ? { name: c.entry.name } : {}),
              }).key === hubNamespace(ns).key,
          )
        )
          await this.restoreLocked(ns, w.epoch);
      }
      const pending = q.filter(
        (c) => hubNamespace(changeNamespace(c)).siteGroup === group,
      );
      let fenced = false;
      const nativeQueue = this.local.queue;
      for (const c of pending) {
        const head = await nativeQueue.head(c);
        if (head && head.epoch !== w.epoch) fenced = true;
      }
      if (fenced) {
        await this.recoverLocal(origin);
        await this.restoreGroupLocked(origin, w);
      }
      const latest = this.checkedWriter(group, w.epoch);
      await this.local.setPermit({
        profileId: this.id,
        group,
        contextId: this.context,
        epoch: w.epoch,
        expiresAt: Date.parse(latest.expiresAt),
        offline: false,
        revoked: false,
      });
      this.checkedWriter(group, w.epoch);
      this.readyGroups.set(group, w.epoch);
    } catch (e: any) {
      if (
        prior && this.readyGroups.get(group) === prior.writer.epoch &&
        this.writers.get(group)?.writer.epoch === prior.writer.epoch &&
        (!navigator.onLine || temporaryProfileFailure(e))
      ) {
        await this.markOffline();
        return;
      }
      throw e;
    }
  }
  takeover(origin: string) {
    const group = hubSiteGroup(origin), prior = this.takeovers.get(group);
    if (this.groupRepairPending(group))
      return Promise.reject(Error("Finish the current synchronization repair for this website before continuing it from another browser."));
    if (prior) return prior;
    const choice = { backupRequested: false, opening: false } as { handoffId?: string; backupRequested: boolean; opening: boolean; error?: string };
    this.takeoverChoices.set(group, choice);
    const flight = this.performTakeover(origin, choice).finally(() => {
      if (this.takeovers.get(group) === flight) {
        this.takeovers.delete(group);
        this.takeoverChoices.delete(group);
      }
    });
    this.takeovers.set(group, flight);
    return flight;
  }
  useLatestBackup(origin: string) {
    const group = hubSiteGroup(origin), choice = this.takeoverChoices.get(group), flight = this.takeovers.get(group);
    // A stale confirmation after normal completion never creates another
    // takeover. Explicit consent applies only to this actual pending request.
    if (!choice || !flight || !choice.handoffId || choice.opening ||
        status.handoff?.phase !== "waiting" || status.handoff.siteGroup !== group)
      return Promise.resolve();
    choice.backupRequested = true;
    for (const wake of [...this.writerWaiters]) wake();
    return flight;
  }
  async performTakeover(origin: string, choice: { handoffId?: string; backupRequested: boolean; opening: boolean; error?: string }) {
    const group = hubSiteGroup(origin);
    emit({
      state: "pending", message: "Waiting for your other browser to finish saving…",
      origin, canContinue: false,
      handoff: { phase: "waiting", siteGroup: group, origin, canUseBackup: false },
    });
    let hint = this.writerHint;
    let h = await this.request<any>("/writers/takeover", "POST", {
      namespace: { kind: "local", origin },
    });
    let writer: Writer | undefined;
    const deadline = Date.now() + 125000;
    while (!h.available && h.status !== "ready" && Date.now() < deadline) {
      choice.handoffId = typeof h.handoffId === "string" ? h.handoffId : undefined;
      emit({
        state: choice.error ? "error" : "pending",
        message: choice.error || "Waiting for your other browser to finish saving…",
        origin, canContinue: false,
        handoff: { phase: "waiting", siteGroup: group, origin,
          canUseBackup: !!choice.handoffId, error: choice.error },
      });
      if (!choice.backupRequested) await this.waitForWriterHint(hint);
      this.check();
      hint = this.writerHint;
      if (choice.backupRequested && choice.handoffId) {
        choice.opening = true;
        emit({
          state: "pending", message: "Opening the last saved version…", origin, canContinue: false,
          handoff: { phase: "waiting", siteGroup: group, origin, canUseBackup: false, backupPending: true },
        });
        // Replay only the exact confirmed handoff. The server accepts a lost
        // response retry only while its resulting writer is still this owner.
        try {
          for (let attempt = 0; attempt < 2; ++attempt) {
            try {
              const r = await this.request<{ writer: Writer }>("/writers", "POST", {
                namespace: { kind: "local", origin }, handoffId: choice.handoffId, useLatestBackup: true,
              });
              writer = r.writer;
              break;
            } catch (error) {
              if (attempt === 0 && temporaryProfileFailure(error)) continue;
              throw error;
            }
          }
          break;
        } catch (error: any) {
          choice.error = error.message || "The saved version could not open. Keep waiting or try again.";
          choice.backupRequested = false;
          choice.opening = false;
        }
      }
      h = await this.request<any>("/writers/takeover", "POST", {
        namespace: { kind: "local", origin },
      });
    }
    if (!writer) {
      if (!h.available && h.status !== "ready")
        throw Error("Your other browser has not finished saving. Retry when it is online.");
      choice.opening = true;
      const r = await this.request<{ writer: Writer }>("/writers", "POST", {
        namespace: { kind: "local", origin },
        ...(h.handoffId ? { handoffId: h.handoffId } : {}),
      });
      writer = r.writer;
    }
    if (!writer || !Number.isSafeInteger(writer.epoch) || writer.epoch < 1 ||
        writer.siteGroup !== group || writer.contextId !== this.context ||
        !Number.isFinite(Date.parse(writer.expiresAt)) || Date.parse(writer.expiresAt) <= Date.now())
      throw Error("The saved browser session was not confirmed. Retry to continue.");
    const confirmed = writer;
    await this.withGroup(group, async () => {
      if (this.groupRepairPending(group))
        throw Error("Finish this website's synchronization repair before continuing it.");
      this.writers.set(group, { namespace: { kind: "local", origin }, writer: confirmed });
      this.readyGroups.delete(group);
      await this.recoverLocal(origin);
      await this.restoreGroupLocked(origin, confirmed);
    });
    const pending = (await this.local.queue.list()).length > 0 ||
      !!localStorage.getItem("atlas.profile.user.pending:" + this.id);
    emit({
      state: pending ? "pending" : "synced",
      message: pending ? "Saved locally · sync pending" : "Synced",
      canContinue: false,
      handoff: undefined,
    });
    if (pending) this.backgroundBackup().reconcileDirty();
    window.dispatchEvent(
      new CustomEvent("atlas:profile-ready", { detail: { origin, siteGroup: hubSiteGroup(origin) } }),
    );
  }
  async recoverLocal(origin: string, attempt = 0): Promise<void> {
    // A new archive representation needs a new idempotency domain. An old
    // recovery may already have been ACKed with different bytes before upgrade.
    const group = hubSiteGroup(origin), marker = "atlas.profile.recovery.packed.pending:" + this.id + ":" + group;
    let id = localStorage.getItem(marker);
    if (!id && !(await this.local.pendingNamespaces(group)).some(n => hubNamespace(n).siteGroup === group)) return;
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(marker, id); }
    window.dispatchEvent(new CustomEvent("atlas:profile-quiesce", { detail: { siteGroup: group } }));
    // Read and pack only this site's native data inside the worker. The exact
    // prepared archive is durable before upload and survives a lost response.
    const renew = async () => {
      const item = this.writers.get(group);
      if (!item || Date.parse(item.writer.expiresAt) > Date.now() + 30000) return;
      const result = await this.request<{ writer: Writer }>("/writers", "PUT", { namespace: item.namespace, epoch: item.writer.epoch });
      const writer = result.writer;
      if (this.writers.get(group) !== item || writer.contextId !== this.context || writer.siteGroup !== group ||
          writer.epoch !== item.writer.epoch || !Number.isFinite(Date.parse(writer.expiresAt)) || Date.parse(writer.expiresAt) <= Date.now())
        throw Error("Website ownership was not confirmed. Try again.");
      item.writer = writer; // Keep the local permit fenced while renewing authority.
    };
    await renew();
    const prepared = await this.local.prepareRecovery(id, origin);
    this.check();
    if (!prepared) { localStorage.removeItem(marker); return; }
    const payload = await uploadPreparedWire(prepared.wire, this.request.bind(this), this.local, renew);
    await renew();
    const ack = await this.request<{ acknowledged: boolean; id: string }>("/recoveries", "POST", {
      id, namespace: { kind: "local", origin }, payload,
    });
    if (ack.acknowledged !== true || ack.id !== id)
      throw Error("Offline saves have not been backed up yet.");
    await this.local.finishRecovery(id, origin);
    this.check();
    localStorage.removeItem(marker);
    localStorage.removeItem("atlas.profile.recovery.pending:" + this.id + ":" + group);
    // A completed archive can be replayed after a crash. Any newer committed
    // entries need their own fresh archive/id before a caller may restore.
    if ((await this.local.pendingNamespaces(group)).some(n => hubNamespace(n).siteGroup === group)) {
      if (attempt >= 2) throw Object.assign(Error("New local saves still need a backup. Try repair again."), { code: "PROFILE_SYNC_PENDING" });
      await this.recoverLocal(origin, attempt + 1);
    }
    this.recovered = true;
    emit({ state: "local", message: "Offline saves preserved in Recovered saves." });
  }
  async restoreGroup(origin: string, w: Writer) {
    return this.withGroup(hubSiteGroup(origin), () => this.restoreGroupLocked(origin, w));
  }
  private async restoreGroupLocked(origin: string, w: Writer) {
    const group = hubSiteGroup(origin);
    const currentWriter = () => this.checkedWriter(group, w.epoch);
    currentWriter();
    const m = await this.request<Manifest>();
    for (const stream of m.streams) {
      const n = fromTuple(stream.namespace);
      if (hubNamespace(n).siteGroup === group) {
        currentWriter();
        await this.restoreLocked(n, w.epoch);
      }
    }
    const latest = currentWriter();
    await this.local.setPermit({
      profileId: this.id,
      group,
      contextId: this.context,
      epoch: w.epoch,
      expiresAt: Date.parse(latest.expiresAt),
      offline: false,
      revoked: false,
    });
    currentWriter();
    this.readyGroups.set(group, w.epoch);
  }
  async flush() {
    return this.backgroundBackup().flushNow();
  }
  retryBackup() {
    this.backupFailureGroups.clear();
    this.lastBackupFailure = undefined;
    return this.backgroundBackup().retry();
  }
  private async flushBackingStore() {
    if (this.flight) return this.flight;
    this.flight = this.drain(true)
      .then(() => { this.backupFailureGroups.clear(); this.lastBackupFailure = undefined; })
      .catch((error: any) => {
        const transient = temporaryProfileFailure(error) || error?.code === "PROFILE_SYNC_PENDING";
        this.lastBackupFailure = error?.backupPausedFailure || (transient ? undefined : error);
        this.backupFailureGroups = new Set([401, 403].includes(error?.status) ||
          /AUTH|REVOK|CONTEXT|HUB_PROFILE_QUOTA/.test(error?.code || "")
          ? ["*"] : error?.backupSiteGroups || (transient ? [] : [error?.backupSiteGroup || "*"]));
        throw error;
      })
      .finally(() => { this.flight = undefined; });
    return this.flight;
  }
  async drain(skipPausedGroups = false) {
    if (this.stopped) throw Error("Profile is signed out.");
    const queue = this.local.queue;
    emit({ state: "pending", message: "Saved locally · sync pending" });
    const blocked = new Set(this.repairNamespaces().map(n => hubNamespace(n).siteGroup));
    if (skipPausedGroups) {
      if (this.backupFailureGroups.has("*") && this.lastBackupFailure)
        throw this.lastBackupFailure;
      for (const group of this.backupFailureGroups) blocked.add(group);
    }
    const failedGroups = new Set(blocked);
    let failure: any = blocked.size ? Object.assign(
      (skipPausedGroups && this.lastBackupFailure) || Error("PROFILE_REPAIR_REQUIRED"), {
      backupSiteGroup: blocked.size === 1 ? [...blocked][0] : "*",
    }) : undefined;
    let transientFailure: unknown;
    // A revision/backup problem in one website cannot starve independent saves.
    const pending = await queue.list(), groups = new Map<string, number>();
    for (const change of pending) {
      const group = hubNamespace(changeNamespace(change)).siteGroup;
      if (!blocked.has(group)) groups.set(group, (groups.get(group) || 0) + 1);
    }
    const failed = (group: string, error: any) => {
      this.check();
      if ([401, 403].includes(error.status)) throw error;
      if (temporaryProfileFailure(error) || error.code === "PROFILE_SYNC_PENDING") {
        transientFailure ??= error;
        return;
      }
      failedGroups.add(error.code === "HUB_PROFILE_QUOTA" ? "*" : group);
      if (error.code === "HUB_PROFILE_QUOTA") failure = error;
      failure ??= Object.assign(error, { backupSiteGroup: group });
    };
    const jobs = [...groups], workers = async () => {
      for (;;) {
        const job = jobs.shift();
        if (!job) return;
        const [group, budget] = job;
        try {
          // Bound each turn: foreground restore/handoff already queued on this
          // site runs before the next batch. New writes get a later drain.
          for (let remaining = budget; remaining > 0;) {
            const count = await this.withGroup(group, async () => {
              if (this.repairNamespaces().some(n => hubNamespace(n).siteGroup === group))
                throw Error("PROFILE_REPAIR_REQUIRED");
              const fresh = (await queue.list(group)).filter(c =>
                hubNamespace(changeNamespace(c)).siteGroup === group).slice(0, Math.min(8, remaining));
              if (!fresh.length) return 0;
              await this.drainQueue({ ...queue, list: async () => fresh });
              return fresh.length;
            });
            if (!count) break;
            remaining -= count;
          }
        } catch (error) { failed(group, error); }
      }
    };
    // Two independent sites at most; preferences have their own short stream.
    // Await every started worker before surfacing errors or allowing another
    // drain, even if one worker loses authentication midway through a batch.
    const results = await Promise.allSettled([
      ...Array.from({ length: Math.min(2, jobs.length) }, workers),
      (async () => {
        try { if (!blocked.has("@atlas")) await this.withGroup("@atlas", () => this.drainPreferences()); }
        catch (error) { failed("@atlas", error); }
      })(),
    ]);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;
    if (failure || transientFailure) {
      const selected = (failedGroups.has("*") ? failure : transientFailure) || failure;
      // Keep terminally blocked sites isolated while an independent site's
      // transient outage still receives paced automatic retries.
      if (selected !== failure)
        throw Object.assign(selected as object, { backupSiteGroups: [...failedGroups], backupPausedFailure: failure });
      throw Object.assign(selected, { backupSiteGroups: [...failedGroups] });
    }

    if ((await queue.list()).length || localStorage.getItem("atlas.profile.user.pending:" + this.id)) {
      emit({ state: "pending", message: "Saved locally · sync pending" });
      throw Object.assign(Error("New saves are still pending. Retry synchronization."), {
        code: "PROFILE_SYNC_PENDING",
      });
    }
    this.backupFailureGroups.clear();
    this.lastBackupFailure = undefined;
    emit({ state: "synced", message: "Synced" });
  }
  async drainQueue(queue: ProfileQueue) {
    await drainProfileQueue(queue, {
      reuseAcknowledgedHeads: true,
      encode: (value) => this.wire(value),
      encodeChange: async (change) => {
        const prepared = await this.local.prepareQueueWire(change);
        this.check();
        return uploadPreparedWire(prepared, this.request.bind(this), this.local);
      },
      receipt: async (id) => {
        try {
          return await this.request<any>("/receipts/" + id);
        } catch (e: any) {
          if (e.status === 404) return null;
          throw e;
        }
      },
      writer: (n) => this.writer(n),
      stream: (n) =>
        this.request("/stream", "POST", { namespace: n, headOnly: true }),
      snapshot: async (namespace, expectedRevision) => {
        this.check();
        const remote = await loadProfileStream(
          body => this.request("/stream", "POST", body), namespace,
        );
        // Reduce a pinned acknowledged cloud history, never live native data.
        // New native saves remain in their original durable outbox.
        if (remote.revision !== expectedRevision)
          throw Error("PROFILE_REVISION_CONFLICT");
        const prepared = await this.hydrateStream(namespace, remote, 0, "compact");
        if (!prepared) throw Error("PROFILE_COMPACTION_RESULT_INVALID");
        this.check();
        const payload = await uploadPreparedWire(prepared, this.request.bind(this), this.local);
        return { revision: remote.revision, payload, encoded: true };
      },
      commit: (v) => this.request<{ acknowledged: boolean; revision: number }>("/commits", "POST", v).catch((e) => { throw this.writerFailure(e, v.namespace); }),
    });
  }
  async flushGroup(group: string) {
    // A fenced handoff drains this group completely; unrelated groups remain
    // available. No handoff ACK precedes durable acknowledgement of its saves.
    return this.withGroup(group, () => this.flushGroupLocked(group));
  }
  private async flushGroupLocked(group: string) {
      this.check();
      if (this.repairNamespaces().some(n => hubNamespace(n).siteGroup === group)) throw Error("PROFILE_REPAIR_REQUIRED");
      const native = this.local.queue;
      const queue: ProfileQueue = {
        ...native,
        list: async () => (await native.list(group)).filter(
          (change) => hubNamespace(changeNamespace(change)).siteGroup === group,
        ),
      };
      await this.drainQueue(queue);
      if ((await queue.list()).length)
        throw Object.assign(Error("This website still has saves pending. Retry synchronization."), {
          code: "PROFILE_SYNC_PENDING",
        });
      // A partial drain never emits a global Synced status.
  }
  async drainPreferences() {
    const pendingKey = "atlas.profile.user.pending:" + this.id,
      pending = localStorage.getItem(pendingKey);
    if (pending) {
      const prepKey = "atlas.profile.preferences.prepared:" + this.id;
      let prepared: any;
      try {
        prepared = JSON.parse(localStorage.getItem(prepKey) || "null");
      } catch {}
      // The drain lock serializes same-origin windows, but each shell has its
      // own userBase. Another window may have ACKed settings since this one
      // initialized. Reuse its durable ACKed base instead of forcing a stale
      // CAS, GET and retry for every later change, and preserve unrelated ACKs.
      // This never rewrites a retained prepared request: lost ACKs still replay
      // that exact original idempotency key and payload below.
      const saved = localStorage.getItem("atlas.profile.user.base:" + this.id);
      if (saved !== null) {
        let base: unknown;
        try { base = JSON.parse(saved); } catch { throw Error("Local settings recovery is required."); }
        if (!base || typeof base !== "object" || Array.isArray(base) ||
            Object.values(base).some(value => value !== null && typeof value !== "string"))
          throw Error("Local settings recovery is required.");
        // Older ACKs persisted null deletion tombstones. They mean absence,
        // not corruption, and must not block the next settings save.
        this.userBase = Object.fromEntries(
          Object.entries(base).filter(([, value]) => value !== null),
        ) as Record<string, string>;
      }
      if (!prepared) {
        const values = userData(this.id),
          changes = Object.entries(values)
            .filter(([key, value]) => this.userBase[key] !== value)
            .map(([key, value]) => ({ key, value, base: this.userBase[key] ?? null }));
        if (changes.length) {
          prepared = {
            id: pending,
            changes,
            payload: await this.wire({
              format: "atlas-preferences-patch-v1",
              changes,
            }),
          };
          localStorage.setItem(prepKey, JSON.stringify(prepared));
        }
      }
      if (prepared) {
        const submit = () => this.request<{ acknowledged: boolean; revision: number }>("/preferences", "POST", {
          idempotencyKey: prepared.id, payload: prepared.payload,
        });
        let ack: { acknowledged: boolean; revision: number };
        try { ack = await submit(); }
        catch (error: any) {
          if (error.status !== 409) throw error;
          const remote = await this.request<{ values: Record<string, string> }>("/preferences").catch(() => null);
          const rebased = remote && rebasePreferenceChanges(prepared.changes, remote.values);
          if (!rebased) throw error; // Real settings edits/clears remain explicit conflicts.
          const originals = prepared.localValues ?? Object.fromEntries(prepared.changes.map((c: any) => [c.key, c.value]));
          // A rejected CAS has no receipt. Use a NEW key for the changed payload;
          // retain that exact retry for receipt recovery after a lost response.
          prepared = {
            id: crypto.randomUUID(), changes: rebased, localValues: originals,
            payload: await this.wire({ format: "atlas-preferences-patch-v1", changes: rebased }),
          };
          localStorage.setItem(prepKey, JSON.stringify(prepared));
          ack = await submit(); // One bounded retry, never an unbounded conflict loop.
        }
        if (!ack.acknowledged)
          throw Error("Settings save was not acknowledged.");
        for (const c of prepared.changes) {
          if (c.value === null) delete this.userBase[c.key];
          else this.userBase[c.key] = c.value;
          if (prepared.localValues) {
            const name = prefPrefix(this.id) + c.key, current = localStorage.getItem(name);
            let value = current === prepared.localValues[c.key] ? c.value : current;
            if (current !== prepared.localValues[c.key] && c.key === "atlas.history") {
              // A new local visit during the request must keep both that visit
              // AND the other browser's acknowledged additions. A user clear
              // is not additive, so it deliberately remains unchanged here.
              const merged = rebasePreferenceChanges([
                { key: c.key, base: prepared.localValues[c.key], value: current },
              ], { [c.key]: c.value });
              if (merged) value = merged[0].value;
            }
            if (value !== current) {
              if (value === null) localStorage.removeItem(name);
              else localStorage.setItem(name, value);
            }
          }
        }
        localStorage.setItem(
          "atlas.profile.user.base:" + this.id,
          JSON.stringify(this.userBase),
        );
        localStorage.removeItem(prepKey);
      }
      // A retained request can predate the pending marker captured above.
      // After its ACK, a newer local edit (including a revert) still needs its
      // own save even when no edit happened during this particular request.
      if (localStorage.getItem(pendingKey) === pending &&
          Object.entries(userData(this.id)).every(([key, value]) => this.userBase[key] === value))
        localStorage.removeItem(pendingKey);
    }
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.tickFlight) return this.tickFlight;
    const flight = this.runTick().finally(() => {
      if (this.tickFlight === flight) this.tickFlight = undefined;
    });
    this.tickFlight = flight;
    return flight;
  }
  async runTick() {
    this.ensureWakeup();
    try {
      // A handoff may wait on a real cloud ACK under the drain lock. It must
      // not hold the renewal loop while unrelated local websites keep running.
      if (this.writers.size || this.releases.size)
        void this.processHandoffs().catch(error => this.syncFailure(error));
      const due = [...this.writers].filter(([group, item]) =>
        !this.writerFenced(group) &&
        !(Date.parse(item.writer.expiresAt) - Date.now() > 60000));
      let cursor = 0, unauthorized = false;
      const renew = async () => {
        while (cursor < due.length && !unauthorized) {
          const [group, item] = due[cursor++];
          if (this.writers.get(group) !== item || this.writerFenced(group)) continue;
          try {
            const { writer } = await this.request<{ writer: Writer }>("/writers", "PUT", {
              namespace: item.namespace, epoch: item.writer.epoch,
            });
            // A late renewal must never revive a released/repaired writer.
            if (this.writers.get(group) !== item || this.writerFenced(group)) continue;
            if (writer.epoch !== item.writer.epoch || writer.contextId !== this.context ||
                writer.siteGroup !== group || !Number.isFinite(Date.parse(writer.expiresAt)) ||
                Date.parse(writer.expiresAt) <= Date.now())
              throw Error("PROFILE_WRITER_RESPONSE_INVALID");
            item.writer = writer;
            if (group !== "@atlas") await this.local.setPermit({
              profileId: this.id, group, contextId: this.context,
              epoch: writer.epoch, expiresAt: Date.parse(writer.expiresAt),
              offline: false, revoked: false,
            });
          } catch (error: any) {
            if (this.writers.get(group) !== item || this.writerFenced(group)) continue;
            unauthorized ||= [401, 403].includes(error?.status);
            await this.syncFailure(this.writerFailure(error, item.namespace));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, due.length) }, renew));
      if (!unauthorized) await this.checkPendingBackups();
    } catch (e: any) { await this.syncFailure(e); }
  }
  private repairNamespaces(): HubNamespace[] {
    const value = localStorage.getItem("atlas.profile.repair.pending:" + this.id);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw Error("The saved repair record needs recovery.");
    for (const n of parsed) {
      hubNamespace(n);
      if (!["local", "idb", "cookies"].includes(n.kind)) throw Error("Invalid repair namespace.");
    }
    return parsed;
  }
  private groupRepairPending(group: string): boolean {
    return this.repairingGroups.has(group) || this.repairNamespaces().some(n => hubNamespace(n).siteGroup === group);
  }
  private updateRepairMarker(group: string, additions: HubNamespace[]) {
    // Only this bounded localStorage read/modify/write needs account metadata
    // serialization. Never hold it across network, checkpoint or hydration.
    return navigator.locks.request("atlas-profile-repair-marker:" + this.id, async () => {
      this.check();
      const current = new Map(this.repairNamespaces().filter(n => hubNamespace(n).siteGroup !== group)
        .map(n => [hubNamespace(n).key, n]));
      for (const n of additions) current.set(hubNamespace(n).key, n);
      const marker = "atlas.profile.repair.pending:" + this.id;
      if (current.size) localStorage.setItem(marker, JSON.stringify([...current.values()]));
      else localStorage.removeItem(marker);
    });
  }
  private async resumeLocalAfterRepair(group: string, origin: string, epoch: number) {
    this.check();
    const item = this.writers.get(group);
    if (!item || item.writer.epoch !== epoch || this.replacementFences.has(group) ||
        [...this.releases.values()].some(r => r.siteGroup === group && (r.fenced || r.fencing)))
      throw Error("PROFILE_RECOVERY_REQUIRED");
    const { writer } = await this.request<{ writer: Writer }>("/writers", "PUT", { namespace: item.namespace, epoch });
    if (this.writers.get(group) !== item || writer.contextId !== this.context || writer.siteGroup !== group ||
        writer.epoch !== epoch || !Number.isFinite(Date.parse(writer.expiresAt)) || Date.parse(writer.expiresAt) <= Date.now())
      throw Error("PROFILE_RECOVERY_REQUIRED");
    item.writer = writer;
    this.checkedWriter(group, epoch, true);
    if (await this.local.resumePermit({ profileId: this.id, group, contextId: this.context, epoch,
      expiresAt: Date.parse(writer.expiresAt), offline: false, revoked: false }) !== true)
      throw Error("PROFILE_RECOVERY_REQUIRED");
    try {
      this.checkedWriter(group, epoch, true);
      this.localRepairResume.set(group, epoch);
      this.readyGroups.set(group, epoch);
    } catch (error) {
      await this.local.revokePermit({ profileId: this.id, group, contextId: this.context, epoch });
      throw error;
    }
    // Native bytes never changed. The repair marker/outbox remain pending;
    // this is local availability, not a claim of completed cloud repair.
    window.dispatchEvent(new CustomEvent("atlas:profile-ready", { detail: { origin, siteGroup: group, localOnly: true } }));
  }
  /** Explicit choice: archive durable local changes before adopting cloud history.
   * No force-takeover, changed revision base, or unacknowledged queue deletion. */
  repairSync(): Promise<void> {
    if (this.repairFlight) return this.repairFlight;
    let resume: { group: string; origin: string; epoch: number; usable: boolean; restoreStarted: boolean } | undefined;
    const flight = (async () => {
        const pendingRepairs = new Map(this.repairNamespaces().map(n => [hubNamespace(n).key, n]));
        const namespaces = new Map<string, HubNamespace>(pendingRepairs);
        for (const n of await this.local.pendingNamespaces()) {
          namespaces.set(hubNamespace(n).key, n);
        }
        if (!namespaces.size) throw Error("No website saves need repair. Use Retry sync to check again.");
        const origins = [...new Set([...namespaces.values()].map(n => n.origin!))];
        const groups = new Map(origins.map(origin => [hubSiteGroup(origin), origin]));
        for (const [group, origin] of groups) {
          await this.withGroup(group, async () => {
          this.repairingGroups.add(group);
          try {
          this.check();
          if ([...this.releases.values()].some(r => r.siteGroup === group) || this.takeovers.has(group))
            throw Error("Finish this website's transfer before repairing its saves.");
          const prior = this.writers.get(group);
          const usable = !!prior && this.readyGroups.get(group) === prior.writer.epoch && !this.writerFenced(group);
          // The ordinary writer endpoint rejects other owners; repair never bypasses it.
          const { writer } = await this.request<{ writer: Writer }>("/writers", "POST", { namespace: { kind: "local", origin } });
          if (writer.siteGroup !== group || writer.contextId !== this.context ||
              !Number.isSafeInteger(writer.epoch) || writer.epoch < 1 || !Number.isFinite(Date.parse(writer.expiresAt)) || Date.parse(writer.expiresAt) <= Date.now())
            throw Error("Website ownership was not confirmed. Try again.");
          await checkpointProfileGroup(group);
          this.check();
          for (const n of await this.local.pendingNamespaces(group))
            if (hubNamespace(n).siteGroup === group) namespaces.set(hubNamespace(n).key, n);
          // Mark only the group we actually fence. A failure in this group must
          // not fence untouched websites that have not begun repair yet.
          for (const [key, n] of namespaces) if (hubNamespace(n).siteGroup === group) pendingRepairs.set(key, n);
          await this.updateRepairMarker(group, [...pendingRepairs.values()].filter(n => hubNamespace(n).siteGroup === group));
          resume = { group, origin, epoch: writer.epoch, usable, restoreStarted: false };
          this.localRepairResume.delete(group);
          this.writers.set(group, { namespace: { kind: "local", origin }, writer });
          this.readyGroups.delete(group);
          window.dispatchEvent(new CustomEvent("atlas:profile-quiesce", { detail: { siteGroup: group } }));
          await this.local.setPermit({ profileId: this.id, group, contextId: this.context,
            epoch: writer.epoch, expiresAt: 0, offline: false, revoked: true });
          // recoverLocal requires the Hub ACK and then a durable local recovery copy.
          await this.recoverLocal(origin);
          const manifest = await this.request<Manifest>();
          const restore = new Map([...namespaces].filter(([, n]) => hubNamespace(n).siteGroup === group));
          for (const stream of manifest.streams) {
            const n = fromTuple(stream.namespace);
            if (hubNamespace(n).siteGroup === group) restore.set(hubNamespace(n).key, n);
          }
          // Include locally changed namespaces absent from the cloud manifest too.
          for (const n of restore.values()) {
            resume.restoreStarted = true;
            await this.restoreLocked(n, writer.epoch, true);
          }
          const latest = this.checkedWriter(group, writer.epoch, true);
          await this.local.setPermit({ profileId: this.id, group, contextId: this.context,
            epoch: writer.epoch, expiresAt: Date.parse(latest.expiresAt), offline: false, revoked: false });
          this.checkedWriter(group, writer.epoch, true);
          this.readyGroups.set(group, writer.epoch);
          this.localRepairResume.delete(group);
          resume = undefined;
          for (const [key, n] of pendingRepairs) if (hubNamespace(n).siteGroup === group) pendingRepairs.delete(key);
          await this.updateRepairMarker(group, []);
          window.dispatchEvent(new CustomEvent("atlas:profile-ready", { detail: { origin, siteGroup: group } }));
          } finally { this.repairingGroups.delete(group); }
          });
        }
        await this.drain(); // Only real queue/settings acknowledgements may emit Synced.
        return origins;
    })().catch(async error => {
      let resumed = false;
      if (resume?.usable && !resume.restoreStarted) {
        try {
          const failed = resume;
          await this.withGroup(failed.group, () => this.resumeLocalAfterRepair(failed.group, failed.origin, failed.epoch));
          resumed = true;
        }
        catch { /* Unknown ownership/auth or changed native publication stays fenced. */ }
      }
      await this.syncFailure(error);
      if (resumed) emit({ state: "error", origin: resume!.origin,
        message: "Saved locally · sync paused. This website is available here; repair synchronization to back it up." });
      throw error;
    })
      .finally(() => { if (this.repairFlight === flight) this.repairFlight = undefined; })
      .then(() => {
        this.check();
        if (this.backupScheduler?.inspect().paused)
          void this.retryBackup().catch(error => this.syncFailure(error));
      });
    this.repairFlight = flight;
    return flight;
  }
  processHandoffs() {
    if (this.stopped) return Promise.resolve();
    this.handoffDirty = true;
    if (this.handoffFlight) return this.handoffFlight;
    const flight = (async () => {
      do {
        this.handoffDirty = false;
        await this.releaseRequestedGroups();
      } while (this.handoffDirty && !this.stopped);
    })().finally(() => {
      if (this.handoffFlight === flight) this.handoffFlight = undefined;
    });
    this.handoffFlight = flight;
    return flight;
  }
  async releaseRequestedGroups() {
    const pending = await this.request<{
      requests: Array<{ id: string; siteGroup: string; epoch: number }>;
    }>("/writers/requests");
    for (const r of pending.requests) {
      if (!this.releases.has(r.id)) {
        const item = this.writers.get(r.siteGroup);
        // Never fence a newer local epoch in response to an obsolete request.
        if (item && item.writer.epoch !== r.epoch) continue;
        this.releases.set(r.id, { ...r, origin: item?.namespace.origin });
      }
    }
    let failure: unknown;
    for (const r of [...this.releases.values()]) {
      if (!this.releases.has(r.id) || this.groupRepairPending(r.siteGroup)) continue;
      try {
      await this.withGroup(r.siteGroup, async () => {
      if (!this.releases.has(r.id) || this.groupRepairPending(r.siteGroup)) return;
      this.check();
      const item = this.writers.get(r.siteGroup), origin = r.origin;
      if (!r.fenced && !r.fencing) {
        // The native game's save must run while its live root and writer permit
        // still exist. Teardown alone does not save Cookie Clicker's live game.
        delete r.checkpointError;
        try { await checkpointProfileGroup(r.siteGroup); }
        catch (error) {
          r.checkpointError = true;
          throw Object.assign(error instanceof Error ? error : Error(String(error)), {
            checkpointSiteGroup: r.siteGroup, checkpointOrigin: origin,
          });
        }
        this.check();
        if (this.releases.get(r.id) !== r || this.writers.get(r.siteGroup) !== item) return;
        // Suppress late renewals before the asynchronous native permit fence.
        // If that durable fence fails, retry it without saving a disposed game.
        r.fencing = true;
        window.dispatchEvent(new CustomEvent("atlas:profile-quiesce", { detail: { siteGroup: r.siteGroup } }));
      }
      emit({
        state: "pending", message: "Finishing this website's saves for your other browser…",
        canContinue: false, origin,
        handoff: { phase: "releasing", siteGroup: r.siteGroup, origin },
      });
      if (!r.fenced) {
        if (item && r.siteGroup !== "@atlas")
          await this.local.setPermit({
            profileId: this.id, group: r.siteGroup, contextId: this.context,
            epoch: item.writer.epoch, expiresAt: 0, offline: false, revoked: true,
          });
        r.fenced = true;
      }
      // Both the journal drain and idempotent ACK can resume after a lost response.
      await this.flushGroupLocked(r.siteGroup);
      let acknowledged = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await this.request<{ acknowledged: boolean }>("/writers/requests/" + r.id + "/ack", "POST", { flushed: true });
          if (result.acknowledged !== true)
            throw Object.assign(Error("The save handoff has not been acknowledged."), { code: "PROFILE_ACK_INVALID" });
          acknowledged = true;
          break;
        } catch (error) {
          if (attempt === 0 && temporaryProfileFailure(error)) continue;
          throw this.writerFailure(error, { kind: "local", origin: origin || "https://" + r.siteGroup });
        }
      }
      if (!acknowledged) throw Error("The save handoff has not been acknowledged.");
      if (this.writers.get(r.siteGroup)?.writer.epoch === r.epoch) this.writers.delete(r.siteGroup);
      this.releases.delete(r.id);
      emit({
        state: "conflict", message: "This website continued in your other browser.",
        origin, canContinue: !!origin,
        handoff: { phase: "paused", siteGroup: r.siteGroup, origin },
      });
      });
      } catch (error) {
        // A busy native game or offline save in one website group must not
        // starve independent sites that can finish their own handoffs now.
        const e = error instanceof Error ? error : Error(String(error));
        if (["HUB_WRITER_LOST", "HUB_WRITER_BUSY", "HUB_HANDOFF_EXPIRED"].includes((e as any).code) && (e as any).siteGroup) {
          await this.syncFailure(e);
          continue;
        }
        if (r.fenced || r.fencing) {
          Object.assign(e, { handoffSiteGroup: r.siteGroup });
          if ((e as any).code !== "PROFILE_SYNC_PENDING")
            emit({
              state: "error", message: e.message, canContinue: false, origin: r.origin,
              handoff: { phase: "releasing", siteGroup: r.siteGroup, origin: r.origin, error: e.message },
            });
        }
        failure ??= e;
      }
    }
    if (failure) throw failure;
  }
  async syncFailure(e: any) {
    if (this.stopped || active !== this) return;
    if (e.checkpointSiteGroup) {
      // Keep the real page available for its own Save/Export controls and keep
      // renewing ownership. A failed native save is not a completed transfer.
      if (!status.handoff || status.handoff.siteGroup === e.checkpointSiteGroup)
        emit({
          state: "error",
          message: "This website is still open. Its latest changes have not finished saving for transfer. Retry sync when it is ready.",
          origin: e.checkpointOrigin, canContinue: false, handoff: undefined,
        });
      return;
    }
    if (e.code === "PROFILE_SYNC_PENDING") {
      emit({ state: "pending", message: "Saved locally · sync pending" });
      return;
    }
    if (["HUB_WRITER_LOST", "HUB_WRITER_BUSY", "HUB_HANDOFF_EXPIRED"].includes(e.code) && e.siteGroup) {
      const item = this.writers.get(e.siteGroup), origin = e.origin ?? item?.namespace.origin;
      window.dispatchEvent(new CustomEvent("atlas:profile-quiesce", { detail: { siteGroup: e.siteGroup } }));
      if (item) await this.local.setPermit({
        profileId: this.id, group: e.siteGroup, contextId: this.context,
        epoch: item.writer.epoch, expiresAt: 0, offline: false, revoked: true,
      });
      this.writers.delete(e.siteGroup);
      for (const [id, r] of this.releases) if (r.siteGroup === e.siteGroup) this.releases.delete(id);
      if (!status.handoff || status.handoff.siteGroup === e.siteGroup)
        emit({
          state: "conflict", message: "This website continued in your other browser. Your local saves are retained.",
          origin, canContinue: !!origin,
          handoff: { phase: "paused", siteGroup: e.siteGroup, origin },
        });
      return;
    }
    if (e.handoffSiteGroup) return; // Nonterminal release failures already retain their own retryable detail.
    if (e.code === "HUB_WRITER_LOST") {
      window.dispatchEvent(new CustomEvent("atlas:profile-quiesce"));
      for (const [group, item] of this.writers)
        if (group !== "@atlas")
          await this.local.setPermit({
            profileId: this.id,
            group,
            contextId: this.context,
            epoch: item.writer.epoch,
            expiresAt: 0,
            offline: false,
            revoked: true,
          });
      this.writers.clear();
    }
    if (!navigator.onLine) {
      await this.markOffline();
      emit({ state: "offline", message: "Saved locally · offline" });
    } else if (temporaryProfileFailure(e) && this.writers.size) {
      await this.markOffline();
      emit({
        state: this.releases.size ? "error" : "local",
        message: "Saved locally · cloud sync unavailable. Retrying…",
      });
    } else
      emit({
        state:
          e.code === "HUB_WRITER_LOST" || /RECOVERY|CONFLICT/.test(e.message)
            ? "conflict"
            : "error",
        message:
          "Saved locally · sync paused. " +
          (e.message || "Retry your connection."),
      });
  }
  stop() {
    this.stopped = true;
    this.readyGroups.clear();
    this.localRepairResume.clear();
    if (active === this)
      emit({ state: "local", message: "Saved locally", canContinue: false, handoff: undefined });
    const revocations: Promise<void>[] = [];
    for (const [group, item] of this.writers)
      if (group !== "@atlas")
        revocations.push(this.local.revokePermit({
          profileId: this.id,group,contextId:this.context,epoch:item.writer.epoch,
        }).then(()=>{}));
    // Do not terminate the transaction worker before durable revocation settles.
    // A rejected operation never counts as a saved/acknowledged write.
    void Promise.allSettled(revocations).then(() => this.local.dispose());
    clearInterval(this.timer);
    this.backupScheduler?.stop();
    this.watcher?.close();
    this.watcher = undefined;
    for (const wake of [...this.writerWaiters]) wake();
    invalidateProfilePermits(indexedDB, this.id, this.context);
    window.removeEventListener("online", this.online);
    window.removeEventListener("pageshow", this.resume);
    window.removeEventListener("pagehide", this.leaving);
    window.document?.removeEventListener("visibilitychange", this.resume);
    window.removeEventListener("offline", this.offline);
    window.removeEventListener("atlas:profile-user-change", this.changed);
    window.removeEventListener("atlas:profile-native-change", this.changed);
    window.removeEventListener("atlas:replacement-sync", this.replacement);
    window.removeEventListener("atlas:profile-cancel-import", this.cancel);
    if (this.manageGuard && active === this) setProfileDocumentGuard(undefined);
  }
}
registerHubInitializer(async (state) => {
  if (state.uiOnlyLab || state.browsingAvailable === false)
    return { ready: false, message: "The browsing runtime has not been activated for this environment." };
  // Native local storage is the only application path. Old build flags/query
  // parameters must never revive the retired replication client or its queues.
  const identity = state.grant!.profileId + ':' + state.grant!.contextId + ':' + state.grant!.sessionId;
  if (activeV2?.same(state)) return {ready:true};
  if (initializing?.identity === identity) return initializing.promise;
  activeV2?.stop();activeV2=undefined;active?.stop();active=undefined;
  const promise = import('./local-first-profile.ts').then(module => module.createLocalFirstProfile(state,{
    current:getHubSession,
    onStatus(localFirst) {
      const backup = localFirst.backup;
      status = {state:backup.state === 'idle' ? 'local' : ['conflict','error','offline'].includes(backup.state) ? backup.state as 'conflict'|'error'|'offline' : 'pending',
        message:backup.message,localFirst,canContinue:false};
      window.dispatchEvent(new CustomEvent('atlas:profile-status',{detail:status}));
    },
  })).then(client => {
    const current=getHubSession();
    if(!current||!client.same(current)){client.stop();throw Object.assign(new Error('The account changed during local initialization.'),{code:'PROFILE_CONTEXT_CHANGED'});}
    activeV2=client;return {ready:true};
  }).finally(()=>{if(initializing?.identity===identity)initializing=undefined;});
  initializing={identity,promise};return promise;
});
export async function flushProfile() {
  // Closing/logout never forces a v2 export or waits for cloud publication.
  if (activeV2) return;
  await active?.flush();
}
export async function prepareProfileReplacement(options: { acceptRecoveredSaves?: boolean } = {}) {
  if (activeV2) {
    const backup = activeV2.backup.status();
    if (backup.state !== 'idle' && options.acceptRecoveredSaves !== true)
      throw Object.assign(new Error('Some current changes are only saved on this browser. Keep this address available until a backup completes.'),{code:'PROFILE_MIGRATION_REVIEW_REQUIRED'});
    return;
  }
  if (!active || !active.ready) throw Error("Your browser is still restoring. Retry before leaving this address.");
  // A durable recovery copy is not the same as adopting a different old save.
  // Review must happen before any current writer is fenced or released.
  if ((active.incomplete || active.legacyRecoveryMessage) && options.acceptRecoveredSaves !== true)
    throw Object.assign(Error(active.legacyRecoveryMessage ||
      "Some older website data remains only in this browser. Keep this address available for recovery; not every value could be transferred."), {
      code: "PROFILE_MIGRATION_REVIEW_REQUIRED",
    });
  await active.prepareReplacement();
}
export function stopProfile() {
  activeV2?.stop();activeV2=undefined;
  active?.stop();
  active = undefined;
  setProfileLimits(null);
  setActiveProfileContext(undefined);
}
function profileContinuationOrigin(explicitOrigin?: string): string {
  const handoff = status.handoff;
  const origin = explicitOrigin ?? handoff?.origin ?? (!handoff ? status.origin : undefined);
  if (!origin) throw Error("Open this website again to continue here.");
  const group = hubSiteGroup(origin);
  if (handoff && group !== handoff.siteGroup)
    throw Error("Select the website that is waiting to continue.");
  return origin;
}
export async function continueProfileHere(explicitOrigin?: string) {
  const origin = profileContinuationOrigin(explicitOrigin);
  if (!active) throw Error("Sign in again to continue.");
  await active.takeover(origin);
}
window.addEventListener("atlas:profile-continue", (event) => {
  let origin: string;
  try {
    origin = profileContinuationOrigin((event as CustomEvent<{ origin?: string }>).detail?.origin);
  } catch (error) {
    emit({ ...status, state: "conflict", message: (error as Error).message });
    return;
  }
  const client = active;
  void continueProfileHere(origin).catch((e) => {
    if (active !== client || client?.stopped) return;
    emit({
      state: "conflict", message: e.message, origin, canContinue: true,
      handoff: { phase: "offered", siteGroup: hubSiteGroup(origin), origin },
    });
  });
});
export async function useLastSavedProfileHere(explicitOrigin?: string) {
  const origin = profileContinuationOrigin(explicitOrigin);
  if (!active) throw Error("Sign in again to continue.");
  await active.useLatestBackup(origin);
}
window.addEventListener("atlas:profile-use-backup", (event) => {
  const client = active;
  void useLastSavedProfileHere((event as CustomEvent<{ origin?: string }>).detail?.origin).catch((e) => {
    if (active !== client || client?.stopped) return;
    emit({ ...status, state: "error", message: e.message });
  });
});
window.addEventListener("atlas:profile-retry", () => {
  if (activeV2) {void activeV2.retry().catch(()=>{});return;}
  const client = active;
  if (!client) return;
  void client.tick();
  void client.retryBackup().catch(error => client.syncFailure(error));
});

export async function repairProfileSync() {
  if (activeV2) {await activeV2.retry();return;}
  const client = active;
  if (!client || client.stopped) throw Error("Sign in to Atlas Hub before repairing synchronization.");
  await client.repairSync();
}

export async function listProfileRecoveries() {
  return rawRequest<{
    recoveries: Array<{
      id: string;
      namespace: string;
      bytes: number;
      createdAt: string;
    }>;
  }>("/recoveries");
}
export async function downloadProfileRecovery(id: string) {
  const client = active;
  if (!client) throw Error("Sign in to view your recovered saves.");
  client.check();
  const r = await client.request<any>("/recoveries/" + id),
    value = await client.unwire(r.payload),
    file = await client.local.recoveryFile(value),
    url = URL.createObjectURL(file.blob),
    a = document.createElement("a");
  client.check();
  a.href = url;
  a.download = "atlas-recovered-save-" + id + file.extension;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
