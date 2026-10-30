/** Trusted frontend assignment/relay coordinator. Raw owner capabilities and
 * relay credentials stay in this realm/cache; no website grant includes them.
 * Private protocol component only: this does not activate App/Popout routing. */
import {
  leaseRetryDelay,
  normalizeBrowsingLease,
  type LeaseFailure,
} from "../web/src/browsing-session.ts";
import { createSandboxRelay } from "./sandbox-relay.ts";
import {
  sandboxRelayURL,
  type SandboxRelayAssignment,
} from "./sandbox-relay-protocol.ts";

export const FRONTEND_ASSIGNMENT_KEY = "atlas.frontendAssignment.v2";
export const FRONTEND_ASSIGNMENT_LOCK = "atlas-frontend-assignment-v2";
const CHANNEL = "atlas-frontend-assignment-v2";
const RENEW_MS = 5 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const INITIAL_REQUEST =
  /^v1\.[1-9][0-9]{9,15}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
type InitialRequest = {
  requestId: string;
  browserSessionId: string;
  requestExpiresAt: number;
};
export type FrontendAssignment = {
  protocol: 2;
  session: string;
  sessionHash: string;
  generation: number;
  frontendOrigin: string;
  relayOrigin: string;
  runtimeOrigin?: string;
  ticket: string;
  relayTicket?: string;
  leaseExpiresAt: number;
  ticketExpiresAt: number;
  serverTime: number;
  expiresLocally?: number;
  browserSessionId: string;
  node: { id: string; name: string };
  pendingCommit: boolean;
  replaces?: string;
  reservationExpiresAt?: number;
};
type OwnerRef = Pick<FrontendAssignment, "session" | "sessionHash"> & {
  generation?: number;
  nodeId?: string;
};
type Reason =
  | "startup"
  | "renew"
  | "restore"
  | "selection"
  | "reconnect"
  | "peer";
type Pending = {
  previous: OwnerRef;
  candidate: FrontendAssignment;
  reason: Reason;
  stage: "reserved" | "commit-intent";
};
export type FrontendAssignmentRecord = {
  version: 2;
  revision: number;
  validatedAt: number;
  active: FrontendAssignment | null;
  pending: Pending | null;
  /** Persisted before allocation; never discard an ambiguous initial request. */
  initial?: InitialRequest | null;
};
export type FrontendRelay = Awaited<ReturnType<typeof createSandboxRelay>>;
export type AssignmentState = {
  status: "connecting" | "ready" | "retrying" | "revoked" | "invalid" | "error";
  code?: string;
  retryIn?: number;
};
type Options = {
  workerURL: string | URL;
  window?: Window & typeof globalThis;
  frontendOrigin?: string;
  storage?: Pick<Storage, "getItem" | "setItem">;
  locks?: Pick<LockManager, "request">;
  fetch?: typeof fetch;
  crypto?: Crypto;
  /** Test/embedding seam. Default ALWAYS probes the actual dedicated relay. */
  createRelay?: (assignment: FrontendAssignment) => Promise<FrontendRelay>;
  requestTimeoutMs?: number;
  now?: () => number;
  visible?: () => boolean;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  events?: boolean;
  channel?:
    | Pick<
        BroadcastChannel,
        "postMessage" | "addEventListener" | "removeEventListener" | "close"
      >
    | false;
  /** Trusted runtime/profile namespace. Each coordinator owns a fresh channel
   * so closing the last tab does not hand a closed endpoint to the next tab. */
  channelName?: string;
  initialSession?: { session: string; generation?: number; nodeId?: string };
  onAssignment?: (event: {
    assignment: FrontendAssignment;
    previous: FrontendAssignment | null;
    reason: Reason;
    identityChanged: boolean;
  }) => void;
  onState?: (state: AssignmentState) => void;
};
const failure = (
  code: string,
  retryable = true,
  message = code,
): LeaseFailure => Object.assign(new Error(message), { code, retryable });
const same = (
  a: FrontendAssignment | null | undefined,
  b: FrontendAssignment,
) =>
  a?.session === b.session &&
  a.generation === b.generation &&
  a.node.id === b.node.id &&
  a.relayOrigin === b.relayOrigin;
const ownerRef = (lease: FrontendAssignment): OwnerRef => ({
  session: lease.session,
  sessionHash: lease.sessionHash,
  generation: lease.generation,
  nodeId: lease.node.id,
});
const relayAssignment = (
  lease: FrontendAssignment,
): SandboxRelayAssignment => ({
  origin: lease.relayOrigin,
  ticket: lease.relayTicket ?? lease.ticket,
  generation: lease.generation,
  sessionHash: lease.sessionHash,
});
const origin = (value: string) => {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.href !== url.origin + "/" ||
    url.username ||
    url.password
  )
    throw failure("INVALID_FRONTEND_ASSIGNMENT", false);
  return url.origin;
};
function shape(value: any, frontend: string): value is FrontendAssignment {
  try {
    return (
      value?.protocol === 2 &&
      TOKEN.test(value.session) &&
      HASH.test(value.sessionHash) &&
      Number.isSafeInteger(value.generation) &&
      value.generation > 0 &&
      value.frontendOrigin === frontend &&
      (!value.runtimeOrigin || value.runtimeOrigin === frontend) &&
      origin(value.relayOrigin) === value.relayOrigin &&
      typeof value.ticket === "string" &&
      !!value.ticket &&
      TOKEN.test(value.browserSessionId) &&
      typeof value.node?.id === "string" &&
      value.node.id.length > 0 &&
      value.node.id.length <= 256 &&
      typeof value.node.name === "string" &&
      value.node.name.length <= 256 &&
      typeof value.pendingCommit === "boolean" &&
      [value.serverTime, value.ticketExpiresAt, value.leaseExpiresAt].every(
        Number.isFinite,
      ) &&
      value.ticketExpiresAt > value.serverTime &&
      value.leaseExpiresAt > value.serverTime &&
      (!value.pendingCommit ||
        (HASH.test(value.replaces) &&
          Number.isFinite(value.reservationExpiresAt)))
    );
  } catch {
    return false;
  }
}

export function createFrontendAssignmentCoordinator(options: Options) {
  const win =
    options.window ?? (typeof window === "undefined" ? undefined : window);
  const frontend = origin(options.frontendOrigin ?? win!.location.origin);
  const storage = options.storage ?? win!.localStorage;
  const locks = options.locks ?? win?.navigator.locks;
  if (!locks?.request)
    throw failure(
      "FRONTEND_COORDINATION_REQUIRED",
      false,
      "Shared frontend assignment changes require Web Locks.",
    );
  const fetcher = options.fetch ?? win!.fetch.bind(win);
  const crypto = options.crypto ?? win?.crypto ?? globalThis.crypto;
  const now = options.now ?? Date.now,
    schedule = options.schedule ?? setTimeout,
    cancel = options.cancel ?? clearTimeout;
  const visible =
    options.visible ??
    (() => !win || win.document.visibilityState === "visible");
  const channel =
    options.channel === false
      ? undefined
      : (options.channel ??
        (win?.BroadcastChannel
          ? new win.BroadcastChannel(options.channelName ?? CHANNEL)
          : undefined));
  const factory =
    options.createRelay ??
    ((assignment: FrontendAssignment) =>
      createSandboxRelay({
        assignment: relayAssignment(assignment),
        workerURL: options.workerURL,
        window: win,
      }));
  const timeout = options.requestTimeoutMs ?? 15000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
    throw failure("INVALID_COORDINATOR_TIMEOUT", false);
  let active: FrontendAssignment | null = null,
    relay: FrontendRelay | undefined,
    stopped = false,
    started = false,
    changing = false,
    epoch = 0,
    attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined,
    retireTimer: ReturnType<typeof setTimeout> | undefined,
    checking: Promise<FrontendAssignment> | undefined,
    queuedAuthority = false;
  const retired = new Set<FrontendRelay>(),
    requests = new Set<AbortController>();
  let state: AssignmentState = { status: "connecting" };
  const notify = (value: AssignmentState) => {
    state = value;
    try {
      options.onState?.(value);
    } catch {}
  };
  const guard = (version: number) => {
    if (stopped || version !== epoch)
      throw failure("FRONTEND_OPERATION_STALE", true);
  };
  async function digest(value: string) {
    return [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    ]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  }
  async function validate(value: any, previous?: FrontendAssignment | null) {
    if (
      !shape(value, frontend) ||
      (await digest(value.session)) !== value.sessionHash
    )
      throw failure("INVALID_FRONTEND_ASSIGNMENT", false);
    sandboxRelayURL(relayAssignment(value), frontend.startsWith("https:"));
    const normalized = normalizeBrowsingLease(value, previous ?? undefined);
    return {
      ...normalized,
      expiresLocally: now() + value.ticketExpiresAt - value.serverTime,
    } as FrontendAssignment;
  }
  const empty = (): FrontendAssignmentRecord => ({
    version: 2,
    revision: 0,
    validatedAt: 0,
    active: null,
    pending: null,
    initial: null,
  });
  function read(): FrontendAssignmentRecord {
    let text: string | null;
    try {
      text = storage.getItem(FRONTEND_ASSIGNMENT_KEY);
    } catch {
      throw failure("FRONTEND_STORAGE_UNAVAILABLE", false);
    }
    if (text === null) return empty();
    try {
      const value = JSON.parse(text);
      const p = value.pending,
        initial = value.initial ?? null;
      if (
        value.version !== 2 ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Number.isFinite(value.validatedAt) ||
        (initial !== null &&
          (!initial ||
            !INITIAL_REQUEST.test(initial.requestId) ||
            !TOKEN.test(initial.browserSessionId) ||
            !Number.isSafeInteger(initial.requestExpiresAt) ||
            initial.requestExpiresAt <= 0)) ||
        (value.active !== null && !shape(value.active, frontend)) ||
        (p !== null &&
          (!p ||
            !shape(p.candidate, frontend) ||
            !TOKEN.test(p.previous?.session) ||
            !HASH.test(p.previous?.sessionHash) ||
            !["reserved", "commit-intent"].includes(p.stage) ||
            ![
              "startup",
              "renew",
              "restore",
              "selection",
              "reconnect",
              "peer",
            ].includes(p.reason)))
      )
        throw Error();
      return { ...value, initial };
    } catch {
      throw failure("INVALID_FRONTEND_CACHE", false);
    }
  }
  function remember(record: FrontendAssignmentRecord) {
    const next = { ...record, revision: record.revision + 1 },
      text = JSON.stringify(next);
    try {
      storage.setItem(FRONTEND_ASSIGNMENT_KEY, text);
      if (storage.getItem(FRONTEND_ASSIGNMENT_KEY) !== text) throw Error();
    } catch {
      throw failure("FRONTEND_STORAGE_UNAVAILABLE", false);
    }
    try {
      channel?.postMessage({
        protocol: CHANNEL,
        revision: next.revision,
        sessionHash: next.active?.sessionHash,
      });
    } catch {}
    return next;
  }
  async function api(
    path: string,
    body: object,
    headers: HeadersInit = {},
    method = "POST",
  ) {
    const controller = new AbortController();
    requests.add(controller);
    const deadline = schedule(() => controller.abort(), timeout);
    try {
      const response = await fetcher(path, {
        method,
        credentials: "same-origin",
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => {
        // A successful mutation may already have committed even when its body
        // is truncated or replaced. Keep its journal and resolve authoritatively.
        throw failure("CONTROL_RESPONSE_INVALID", true);
      });
      if (!response.ok) {
        const value = response.headers.get("Retry-After"),
          seconds = value == null ? NaN : Number(value),
          date = value == null ? NaN : Date.parse(value);
        throw Object.assign(
          new Error(
            typeof data.error === "string"
              ? data.error
              : "Control request failed.",
          ),
          {
            status: response.status,
            code:
              typeof data.code === "string" ? data.code : "CONTROL_UNAVAILABLE",
            retryable:
              typeof data.retryable === "boolean"
                ? data.retryable
                : response.status >= 500 || response.status === 429,
            retryAfter: Number.isFinite(seconds)
              ? seconds
              : Number.isFinite(date)
                ? Math.max(0, (date - now()) / 1000)
                : undefined,
          },
        );
      }
      return data;
    } finally {
      cancel(deadline);
      requests.delete(controller);
    }
  }
  async function describe(ref: OwnerRef, intent: "restore" | "renew") {
    try {
      return await validate(
        await api("/api/browse/controller/session", {
          intent,
          session: ref.session,
          generation: ref.generation,
        }),
        active,
      );
    } catch (error) {
      if ((error as LeaseFailure).code === "SESSION_GENERATION_MISMATCH")
        return validate(
          await api("/api/browse/controller/session", {
            intent: "restore",
            session: ref.session,
          }),
          active,
        );
      if (
        (error as LeaseFailure).code === "SESSION_EXPIRED" &&
        intent === "renew"
      )
        return validate(
          await api("/api/browse/controller/session", {
            intent: "restore",
            session: ref.session,
            generation: ref.generation,
          }),
          active,
        );
      throw error;
    }
  }
  function reap() {
    for (const old of retired)
      if (!old.pending && !old.webSockets) {
        old.dispose();
        retired.delete(old);
      }
    if (retired.size && !stopped) retireTimer = schedule(reap, 1000);
  }
  function retire(old?: FrontendRelay) {
    if (!old) return;
    retired.add(old);
    if (retireTimer) cancel(retireTimer);
    reap();
  }
  async function probe(lease: FrontendAssignment, version: number) {
    guard(version);
    if (retired.size >= 3) throw failure("RELAY_RETIREMENT_LIMIT", true);
    const candidate = await factory(lease);
    try {
      guard(version);
      return candidate;
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  }
  async function activate(
    lease: FrontendAssignment,
    record: FrontendAssignmentRecord,
    reason: Reason,
    version: number,
    prepared?: FrontendRelay,
    persist = true,
  ) {
    guard(version);
    const previous = active;
    let candidate = prepared;
    const expected = relayAssignment(lease);
    if (
      candidate &&
      (candidate.assignment.origin !== expected.origin ||
        candidate.assignment.sessionHash !== expected.sessionHash ||
        candidate.assignment.generation !== expected.generation ||
        candidate.assignment.ticket !== expected.ticket)
    )
      throw failure("INVALID_PROBED_RELAY", false);
    if (!candidate && relay && same(active, lease)) {
      if (relay.assignment.ticket !== (lease.relayTicket ?? lease.ticket))
        await relay.replace(relayAssignment(lease));
      guard(version);
    } else if (!candidate) candidate = await probe(lease, version);
    try {
      guard(version);
      // Peer-cache adoption must neither renew its authoritative timestamp nor
      // broadcast another write; otherwise two windows can echo forever and
      // postpone the actual five-minute server renewal indefinitely.
      const saved = persist
        ? remember({
            ...record,
            active: lease,
            pending: null,
            initial: null,
            validatedAt: now(),
          })
        : record;
      if (candidate) {
        const old = relay;
        relay = candidate;
        retire(old);
      }
      active = lease;
      attempt = 0;
      notify({ status: "ready" });
      try {
        options.onAssignment?.({
          assignment: lease,
          previous,
          reason,
          identityChanged: !same(previous, lease),
        });
      } catch {}
      return { lease, record: saved };
    } catch (error) {
      candidate?.dispose();
      throw error;
    }
  }
  async function confirm(
    record: FrontendAssignmentRecord,
    pending: Pending,
    version: number,
  ) {
    guard(version);
    let candidate: FrontendRelay | undefined;
    try {
      candidate = await probe(pending.candidate, version);
      record = remember({
        ...record,
        pending: { ...pending, stage: "commit-intent" },
      });
      guard(version);
      const confirmed = await validate(
        await api("/api/browse/controller/commit", {
          previousSession: pending.previous.session,
          session: pending.candidate.session,
          generation: pending.candidate.generation,
        }),
        active,
      );
      if (
        confirmed.pendingCommit ||
        confirmed.session !== pending.candidate.session ||
        confirmed.sessionHash !== pending.candidate.sessionHash ||
        confirmed.node.id !== pending.candidate.node.id ||
        confirmed.generation !== pending.candidate.generation ||
        confirmed.relayOrigin !== pending.candidate.relayOrigin
      )
        throw failure("INVALID_FRONTEND_COMMIT", false);
      guard(version);
      // Commit returns refreshed credentials. The already-probed candidate
      // cannot silently keep its older ticket or promote an unprobed endpoint.
      if (
        candidate.assignment.ticket !==
        (confirmed.relayTicket ?? confirmed.ticket)
      )
        await candidate.replace(relayAssignment(confirmed));
      guard(version);
      const result = await activate(
        confirmed,
        record,
        pending.reason,
        version,
        candidate,
      );
      candidate = undefined;
      return result;
    } catch (error) {
      if (
        [
          "INVALID_SESSION",
          "SESSION_REVOKED",
          "SESSION_GENERATION_MISMATCH",
        ].includes((error as LeaseFailure).code || "")
      ) {
        // A candidate reservation can expire/be revoked while the old active
        // owner is still valid. A commit error is NOT authoritative revocation
        // of that previous owner: reconcile the journal before labeling it.
        throw Object.assign(failure("COMMIT_REQUIRES_RECONCILIATION", true), {
          causeCode: (error as LeaseFailure).code,
        });
      }
      throw error;
    } finally {
      candidate?.dispose();
    }
  }
  async function accept(
    lease: FrontendAssignment,
    record: FrontendAssignmentRecord,
    reason: Reason,
    version: number,
    previous?: OwnerRef,
  ) {
    guard(version);
    if (!lease.pendingCommit) {
      // Even the FIRST relay probe can fail. Persist its already-authorized pin
      // before probing so a network outage/reload never allocates another node.
      if (record.active?.session !== lease.session && !record.pending)
        record = remember({
          ...record,
          active: lease,
          initial: null,
          validatedAt: now(),
        });
      return activate(lease, record, reason, version);
    }
    if (
      !previous ||
      lease.replaces !== previous.sessionHash ||
      (reason === "restore" &&
        previous.nodeId &&
        lease.node.id !== previous.nodeId)
    )
      throw failure("INVALID_FRONTEND_REPLACEMENT", false);
    const pending: Pending = {
      previous,
      candidate: lease,
      reason,
      stage: "reserved",
    };
    record = remember({ ...record, pending }); // MUST succeed before probe/ambiguous commit.
    return confirm(record, pending, version);
  }
  async function recoverPending(
    record: FrontendAssignmentRecord,
    version: number,
  ) {
    const pending = record.pending!;
    let candidate: FrontendAssignment;
    try {
      candidate = await describe(ownerRef(pending.candidate), "restore");
    } catch (error) {
      if (
        !["INVALID_SESSION", "SESSION_REVOKED"].includes(
          (error as LeaseFailure).code || "",
        )
      )
        throw error;
      // An expired/cancelled RESERVATION is not proof that the original owner
      // expired. Validate it; never allocate blindly after a generic failure.
      const previous = await describe(pending.previous, "restore");
      return accept(previous, record, "restore", version, pending.previous);
    }
    guard(version);
    if (!candidate.pendingCommit)
      return activate(candidate, record, pending.reason, version);
    // Candidate-first is essential after an ambiguous successful commit. Only
    // an UNCOMMITTED candidate needs its predecessor checked; availability of
    // the old traffic node is not an ownership test and cannot block an
    // explicitly selected healthy replacement.
    try {
      await describe(pending.previous, "restore");
    } catch (error) {
      if (
        ["SESSION_REVOKED", "INVALID_SESSION"].includes(
          (error as LeaseFailure).code || "",
        )
      )
        throw error;
      if ((error as LeaseFailure).retryable === false) throw error;
    }
    guard(version);
    const previous =
      candidate.replaces === pending.previous.sessionHash
        ? pending.previous
        : candidate.replaces === pending.candidate.sessionHash
          ? ownerRef(pending.candidate)
          : undefined;
    return accept(candidate, record, pending.reason, version, previous);
  }
  async function initialAssignment(
    record: FrontendAssignmentRecord,
    reason: Reason,
    version: number,
    allowRetirement = true,
  ): Promise<{ lease: FrontendAssignment; record: FrontendAssignmentRecord }> {
    let initial = record.initial;
    if (!initial) {
      // Establish the HttpOnly browser binding BEFORE any lease can exist.
      // Losing this bootstrap response is harmless: it allocated nothing.
      const prepared = await api("/api/browse/controller/bootstrap", {});
      guard(version);
      if (
        !INITIAL_REQUEST.test(prepared?.requestId) ||
        !TOKEN.test(prepared?.browserSessionId) ||
        !Number.isSafeInteger(prepared.requestExpiresAt) ||
        !Number.isSafeInteger(prepared.serverTime) ||
        prepared.requestExpiresAt <= prepared.serverTime ||
        prepared.requestExpiresAt - prepared.serverTime > 30 * 60_000
      )
        throw failure("INVALID_INITIAL_REQUEST", false);
      initial = {
        requestId: prepared.requestId,
        browserSessionId: prepared.browserSessionId,
        requestExpiresAt: prepared.requestExpiresAt,
      };
      // This verified write MUST finish before POST new. Reload and peer windows
      // recover this same signed request rather than selecting a second node.
      record = remember({ ...record, initial });
    }
    let lease: FrontendAssignment;
    try {
      lease = await validate(
        await api("/api/browse/controller/session", {
          intent: "new",
          requestId: initial.requestId,
        }),
      );
    } catch (error) {
      if (
        !allowRetirement ||
        (error as LeaseFailure).code !== "INITIAL_REQUEST_EXPIRED"
      )
        throw error;
      // Exact expired-request retirement is not outage failover. It confirms the
      // deterministic previous lease is gone before any fresh allocation exists.
      const retired = await api("/api/browse/controller/initial-retire", {
        requestId: initial.requestId,
      });
      guard(version);
      if (
        retired?.ok !== true ||
        retired.retiredRequestId !== initial.requestId ||
        !Number.isSafeInteger(retired.serverTime)
      )
        throw failure("INVALID_INITIAL_RETIREMENT", false);
      record = remember({ ...record, initial: null });
      return initialAssignment(record, reason, version, false);
    }
    guard(version);
    if (
      lease.browserSessionId !== initial.browserSessionId ||
      lease.pendingCommit
    )
      throw failure("INITIAL_REQUEST_BINDING_MISMATCH", false);
    return accept(lease, record, reason, version);
  }
  async function reconcile(
    version: number,
    authoritative: boolean,
    reason: Reason,
  ) {
    guard(version);
    let record = read();
    if (record.pending) return recoverPending(record, version);
    if (record.initial) return initialAssignment(record, "startup", version);
    const saved = record.active ?? active;
    if (saved) {
      if (
        !authoritative &&
        same(active, saved) &&
        now() - record.validatedAt < RENEW_MS - 1000 &&
        (saved.expiresLocally ?? 0) > now() + 60000
      )
        return activate(saved, record, "peer", version, undefined, false);
      const lease = await describe(
        ownerRef(saved),
        reason === "startup" || !same(active, saved) ? "restore" : "renew",
      );
      guard(version);
      if (
        !lease.pendingCommit &&
        (lease.session !== saved.session ||
          lease.node.id !== saved.node.id ||
          lease.relayOrigin !== saved.relayOrigin)
      )
        throw failure("INVALID_FRONTEND_ASSIGNMENT", false);
      return accept(
        lease,
        record,
        lease.pendingCommit ? "restore" : reason,
        version,
        ownerRef(saved),
      );
    }
    if (options.initialSession) {
      const initial = options.initialSession;
      const ref = { ...initial, sessionHash: await digest(initial.session) };
      const lease = await describe(ref, "restore");
      return accept(lease, record, "restore", version, ref);
    }
    return initialAssignment(record, "startup", version);
  }
  function later(delay: number) {
    if (timer) cancel(timer);
    if (!stopped)
      timer = schedule(() => {
        void check({ reason: "renew" }).catch(() => {});
      }, delay);
  }
  function report(error: LeaseFailure) {
    if (stopped || error.code === "FRONTEND_OPERATION_STALE") return;
    if (["SESSION_REVOKED", "INVALID_SESSION"].includes(error.code || "")) {
      notify({
        status: error.code === "SESSION_REVOKED" ? "revoked" : "invalid",
        code: error.code,
      });
      if (timer) cancel(timer);
    } else if (error.retryable === false)
      notify({ status: "error", code: error.code });
    else {
      const delay = leaseRetryDelay(attempt++, error.retryAfter);
      notify({ status: "retrying", code: error.code, retryIn: delay });
      later(delay);
    }
  }
  function check(
    input: { authoritative?: boolean; reason?: Reason } = {},
  ): Promise<FrontendAssignment> {
    if (stopped)
      return Promise.reject(failure("FRONTEND_COORDINATOR_STOPPED", false));
    if (checking) {
      if (input.authoritative) queuedAuthority = true;
      return checking;
    }
    if (!input.authoritative && !visible()) {
      later(RENEW_MS);
      return active
        ? Promise.resolve(active)
        : Promise.reject(failure("FRONTEND_DOCUMENT_HIDDEN", true));
    }
    const version = epoch;
    checking = locks!
      .request(FRONTEND_ASSIGNMENT_LOCK, () =>
        reconcile(
          version,
          input.authoritative === true,
          input.reason ?? "renew",
        ),
      )
      .then(({ lease }) => {
        guard(version);
        later(RENEW_MS);
        return lease;
      })
      .catch((error: LeaseFailure) => {
        if (version === epoch) report(error);
        throw error;
      })
      .finally(() => {
        checking = undefined;
        if (queuedAuthority && !stopped) {
          queuedAuthority = false;
          void check({ authoritative: true }).catch(() => {});
        }
      });
    return checking;
  }
  const resume = () => {
    if (visible()) void check({ authoritative: true }).catch(() => {});
  };
  const hint = () => {
    if (visible()) void check().catch(() => {});
  };
  const storageHint = (event: StorageEvent) => {
    if (event.key === FRONTEND_ASSIGNMENT_KEY) hint();
  };
  const broadcastHint = (event: MessageEvent) => {
    if (event.data?.protocol === CHANNEL) hint();
  };
  function attach() {
    if (started) return;
    started = true;
    channel?.addEventListener("message", broadcastHint);
    if (options.events !== false && win) {
      win.addEventListener("online", resume);
      win.addEventListener("pageshow", resume);
      win.addEventListener("storage", storageHint);
      win.document.addEventListener("visibilitychange", resume);
      win.document.addEventListener("resume", resume);
    }
  }
  return {
    start() {
      attach();
      return check({ authoritative: true, reason: "startup" });
    },
    check,
    async selectNode(nodeId: string, csrf: string) {
      if (changing) throw failure("SESSION_BUSY", true);
      changing = true;
      const version = ++epoch;
      try {
        const { lease } = await locks!.request(
          FRONTEND_ASSIGNMENT_LOCK,
          async () => {
            const initial = read();
            if (
              initial.pending?.reason === "selection" &&
              initial.pending.candidate.node.id !== nodeId
            )
              throw failure(
                "SESSION_BUSY",
                true,
                "A previous selection must resolve before another node is selected.",
              );
            const previous = await reconcile(version, true, "peer");
            guard(version);
            const lease = await validate(
              await api(
                "/api/admin/nodes/controller-select",
                { session: previous.lease.session, node: nodeId },
                { "x-atlas-csrf": csrf },
              ),
              previous.lease,
            );
            guard(version);
            if (!lease.pendingCommit || lease.node.id !== nodeId)
              throw failure("INVALID_FRONTEND_SELECTION", false);
            return accept(
              lease,
              previous.record,
              "selection",
              version,
              ownerRef(previous.lease),
            );
          },
        );
        later(RENEW_MS);
        return lease;
      } catch (error) {
        if (version === epoch) report(error as LeaseFailure);
        throw error;
      } finally {
        changing = false;
      }
    },
    /** Explicit user action only. Unknown/revoked stored owners never cause this
     * fresh allocation through startup, retry, resume or a BroadcastChannel hint. */
    async reconnect() {
      if (changing) throw failure("SESSION_BUSY", true);
      changing = true;
      const version = ++epoch;
      try {
        const { lease } = await locks!.request(
          FRONTEND_ASSIGNMENT_LOCK,
          async () => {
            guard(version);
            let record = read();
            // Explicit reconnect is not permission to discard an ambiguous
            // commit. Resolve its candidate before deciding which live owner
            // the new reservation replaces.
            if (record.pending)
              record = (await recoverPending(record, version)).record;
            guard(version);
            if (record.initial)
              return initialAssignment(record, "reconnect", version);
            const previous = record.active ?? active;
            const replace =
              previous && !["revoked", "invalid"].includes(state.status);
            if (!replace)
              return initialAssignment(record, "reconnect", version);
            const lease = await validate(
              await api("/api/browse/controller/session", {
                intent: "new",
                ...(replace
                  ? {
                      session: previous.session,
                      generation: previous.generation,
                    }
                  : {}),
              }),
            );
            return accept(
              lease,
              record,
              "reconnect",
              version,
              replace ? ownerRef(previous) : undefined,
            );
          },
        );
        later(RENEW_MS);
        return lease;
      } catch (error) {
        if (version === epoch) report(error as LeaseFailure);
        throw error;
      } finally {
        changing = false;
      }
    },
    /** Stable facade: renewed credentials never require a website-frame remount. */
    transport: {
      request(...args: Parameters<FrontendRelay["request"]>) {
        if (!relay) return Promise.reject(failure("RELAY_NOT_READY"));
        return relay.request(...args);
      },
      connectWebSocket(...args: Parameters<FrontendRelay["connectWebSocket"]>) {
        if (!relay) throw failure("RELAY_NOT_READY");
        return relay.connectWebSocket(...args);
      },
      get assignment() {
        if (!relay) throw failure("RELAY_NOT_READY");
        return relay.assignment;
      },
    },
    get current() {
      return active;
    },
    get state() {
      return state;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ++epoch;
      if (timer) cancel(timer);
      if (retireTimer) cancel(retireTimer);
      for (const controller of requests) controller.abort();
      channel?.removeEventListener("message", broadcastHint);
      channel?.close();
      if (options.events !== false && win) {
        win.removeEventListener("online", resume);
        win.removeEventListener("pageshow", resume);
        win.removeEventListener("storage", storageHint);
        win.document.removeEventListener("visibilitychange", resume);
        win.document.removeEventListener("resume", resume);
      }
      relay?.dispose();
      for (const old of retired) old.dispose();
      retired.clear();
    },
  };
}
