/** Trusted frontend selected-node native resource owner. Never transfer this
 * object, signed ticket, owner socket, upstream bytes, or browser cookies to a
 * website. Its document-bound port returns public URL-only results; only
 * anonymous-CORS-authorized font snapshots use a captured private Blob binding. */
import {
  createNativeResourcePreparer,
  type NativeResourceIdentity,
  type NativeResourceDescriptor,
  type NativeResourceUpload,
  type NativeFontSnapshot,
} from "./native-resource-preparer.ts";
import { describeDocumentBootFailure } from "./document-boot-diagnostics.ts";
export const NATIVE_RESOURCE_DOCUMENT_PROTOCOL = "atlas-native-resource-v1";
export type NativeResourceOwnerGrant = NativeResourceIdentity &
  Readonly<{
    frontendOrigin: string;
    expiresAt: number;
    ownerTicket: string;
    role: "frontend-resource-owner-v1";
    purpose: "native-resource-owner";
  }>;
type Owner = Window & typeof globalThis;
type PreparerOptions = Parameters<typeof createNativeResourcePreparer>[0];
type BindingInput = Pick<
  PreparerOptions,
  | "documentId"
  | "documentURL"
  | "topLevelURL"
  | "fetch"
  | "contentPolicies"
  | "coep"
  | "transform"
  | "forbiddenOrigins"
> & { port: MessagePort };
const failure = (code: string) => Object.assign(new TypeError(code), { code });
const own = (value: any, allowed: string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const cap = /^[A-Za-z0-9_-]{43}$/,
  identifier = /^[A-Za-z0-9_-]{16,96}$/;
const same = (a: NativeResourceIdentity, b: NativeResourceIdentity) =>
  a.nodeId === b.nodeId &&
  a.resourceOrigin === b.resourceOrigin &&
  a.leaseHash === b.leaseHash &&
  a.generation === b.generation;
export async function createNativeResourceOwner(options: {
  identity: () => NativeResourceIdentity;
  /** Trusted issuer must mint a new purpose-separated signed ticket on refresh. */
  grant: (
    identity: NativeResourceIdentity,
    context: { refresh: boolean; signal: AbortSignal },
  ) => Promise<NativeResourceOwnerGrant>;
  window?: Owner;
  timeoutMs?: number;
  renewBeforeMs?: number;
  onUnavailable?: (code: string) => void;
}) {
  const owner = options.window ?? window,
    frontend = owner.location.origin,
    timeoutMs = options.timeoutMs ?? 10000,
    renewBeforeMs = options.renewBeforeMs ?? 60000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isSafeInteger(renewBeforeMs) ||
    renewBeforeMs < 1 ||
    renewBeforeMs > 3600000
  )
    throw failure("native_owner_invalid_limits");
  const snapshot = Object.freeze({ ...options.identity() });
  const resourceOrigin = new URL(snapshot.resourceOrigin);
  if (
    resourceOrigin.protocol !== "https:" ||
    resourceOrigin.origin !== snapshot.resourceOrigin ||
    !snapshot.nodeId ||
    !/^[a-f0-9]{64}$/.test(snapshot.leaseHash) ||
    !Number.isSafeInteger(snapshot.generation) ||
    snapshot.generation < 1 ||
    !/^https:\/\//.test(frontend)
  )
    throw failure("native_owner_invalid_assignment");
  const nativeFetch = owner.fetch.bind(owner),
    NativeWebSocket = owner.WebSocket;
  let live = true,
    expiresAt = 0,
    socket: WebSocket | undefined,
    ownerCap = "",
    renewTimer: ReturnType<typeof setTimeout> | undefined,
    expiryTimer: ReturnType<typeof setTimeout> | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    lastPong = Date.now();
  const registrationController = new AbortController();
  type UploadRecord = {
    id: string;
    cancelled: boolean;
    waiter?: {
      type: string;
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    };
  };
  const uploads = new Map<string, UploadRecord>();
  type DocumentBinding = {
    documentId: string;
    port: MessagePort;
    live: boolean;
    ready: Promise<void>;
    fulfill: () => void;
    reject: (e: Error) => void;
    enrollmentNonce: string;
    enrolled: boolean;
    next: number;
    invalid: number;
    timer?: ReturnType<typeof setTimeout>;
    preparer: ReturnType<typeof createNativeResourcePreparer>;
    pending: Map<number, AbortController>;
    dispose: (code?: string) => void;
    enroll: (url: string) => Promise<void>;
  };
  const documents = new Map<string, DocumentBinding>();
  let renewal: Promise<void> | undefined;
  const bindingFlights = new Set<Promise<void>>();
  const check = () => {
    if (!live) throw failure("native_owner_disposed");
    if (!same(snapshot, options.identity())) {
      dispose("native_owner_assignment_changed");
      throw failure("native_owner_assignment_changed");
    }
    if (expiresAt && Date.now() >= expiresAt) {
      dispose("native_owner_expired");
      throw failure("native_owner_expired");
    }
  };
  const send = (value: object) => {
    check();
    if (
      socket?.readyState !== NativeWebSocket.OPEN ||
      socket.bufferedAmount > 256 * 1024
    )
      throw failure("native_owner_control_unavailable");
    socket.send(JSON.stringify(value));
  };
  const rejectUpload = (record: UploadRecord, error: Error) => {
    if (record.waiter) {
      clearTimeout(record.waiter.timer);
      record.waiter.reject(error);
      record.waiter = undefined;
    }
  };
  function dispose(code = "native_owner_disposed") {
    if (!live) return;
    live = false;
    registrationController.abort();
    clearTimeout(renewTimer);
    clearTimeout(expiryTimer);
    clearInterval(heartbeat);
    for (const doc of [...documents.values()]) doc.dispose(code);
    for (const record of uploads.values()) rejectUpload(record, failure(code));
    uploads.clear();
    try {
      socket?.close(1000, "Native resource owner closed");
    } catch {}
    if (ownerCap)
      void nativeFetch(snapshot.resourceOrigin + "/native-resource/v1/owners", {
        method: "DELETE",
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        headers: { Authorization: "Bearer " + ownerCap },
      }).catch(() => {});
    options.onUnavailable?.(code);
  }
  async function json(url: string, init: RequestInit) {
    check();
    const controller = new AbortController(),
      abort = () => controller.abort();
    registrationController.signal.addEventListener("abort", abort, {
      once: true,
    });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await nativeFetch(snapshot.resourceOrigin + url, {
        ...init,
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      check();
      if (!response.ok || !response.body)
        throw failure("native_owner_registration_failed");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 16384) {
          await reader.cancel();
          throw failure("native_owner_invalid_grant");
        }
        chunks.push(result.value);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      check();
      return JSON.parse(new TextDecoder().decode(data));
    } finally {
      clearTimeout(timer);
      registrationController.signal.removeEventListener("abort", abort);
    }
  }
  async function grant(refresh: boolean) {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(),
      abort = () => controller.abort();
    registrationController.signal.addEventListener("abort", abort, {
      once: true,
    });
    try {
      const value = await Promise.race([
        options.grant(snapshot, { refresh, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(failure("native_owner_ticket_timeout"));
          }, timeoutMs);
        }),
      ]);
      check();
      if (
        !value ||
        value.role !== "frontend-resource-owner-v1" ||
        value.purpose !== "native-resource-owner" ||
        !same(snapshot, value) ||
        value.frontendOrigin !== frontend ||
        !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= Date.now() ||
        typeof value.ownerTicket !== "string" ||
        !/^[A-Za-z0-9_.-]{1,32768}$/.test(value.ownerTicket)
      )
        throw failure("native_owner_ticket_denied");
      return value;
    } finally {
      clearTimeout(timer);
      registrationController.signal.removeEventListener("abort", abort);
    }
  }
  const schedule = () => {
    clearTimeout(expiryTimer);
    clearTimeout(renewTimer);
    expiryTimer = setTimeout(
      () => dispose("native_owner_expired"),
      Math.max(1, expiresAt - Date.now()),
    );
    renewTimer = setTimeout(
      autoRenew,
      Math.max(
        1000,
        expiresAt -
          Date.now() -
          Math.min(renewBeforeMs, Math.max(1000, (expiresAt - Date.now()) / 3)),
      ),
    );
  };
  function autoRenew() {
    void renew().catch(() => {
      if (!live) return;
      if (Date.now() >= expiresAt) {
        dispose("native_owner_expired");
        return;
      }
      // A transient issuer/control error must not revoke a still-valid owner.
      // Keep its hard terminal deadline and retry at one bounded cadence.
      clearTimeout(renewTimer);
      renewTimer = setTimeout(
        autoRenew,
        Math.min(5000, Math.max(1, expiresAt - Date.now())),
      );
    });
  }
  async function renew() {
    if (renewal) return renewal;
    renewal = (async () => {
      await Promise.all([...bindingFlights]);
      check();
      const renewed = await grant(true);
      if (renewed.expiresAt <= expiresAt)
        throw failure("native_owner_ticket_stale");
      const response = await json("/native-resource/v1/owners/renew", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + renewed.ownerTicket,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ capability: ownerCap }),
      });
      check();
      if (
        !own(response, ["expiresAt", "enrollments"]) ||
        !Number.isSafeInteger(response.expiresAt) ||
        response.expiresAt <= expiresAt ||
        response.expiresAt > renewed.expiresAt ||
        !Array.isArray(response.enrollments) ||
        response.enrollments.length > 32
      )
        throw failure("native_owner_invalid_renewal");
      const seen = new Set<string>();
      for (const entry of response.enrollments) {
        if (
          !own(entry, ["documentId", "enrollment"]) ||
          !identifier.test(entry.documentId) ||
          typeof entry.enrollment !== "string" ||
          seen.has(entry.documentId)
        )
          throw failure("native_owner_invalid_renewal");
        seen.add(entry.documentId);
      }
      if ([...documents.keys()].some((id) => !seen.has(id)))
        throw failure("native_owner_missing_enrollment");
      expiresAt = response.expiresAt;
      schedule();
      await Promise.all(
        response.enrollments.map(
          (entry: { documentId: string; enrollment: string }) =>
            documents.get(entry.documentId)?.enroll(entry.enrollment),
        ),
      );
      check();
    })();
    try {
      return await renewal;
    } finally {
      renewal = undefined;
    }
  }
  const waitUpload = (record: UploadRecord, type: string) =>
    new Promise<any>((resolve, reject) => {
      if (record.waiter) throw failure("native_owner_upload_state");
      record.waiter = {
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          record.waiter = undefined;
          reject(failure("native_owner_upload_timeout"));
        }, timeoutMs),
      };
    });
  async function abortUpload(record: UploadRecord) {
    if (!uploads.has(record.id)) return;
    record.cancelled = true;
    rejectUpload(record, failure("native_resource_aborted"));
    const ack = waitUpload(record, "upload-aborted");
    void ack.catch(() => {});
    try {
      send({ type: "abort-upload", uploadId: record.id });
      await ack;
    } catch {
      dispose("native_owner_abort_unconfirmed");
    } finally {
      uploads.delete(record.id);
    }
  }
  async function upload(
    value: NativeResourceUpload,
    identity: NativeResourceIdentity,
    signal: AbortSignal,
  ) {
    check();
    if (
      !same(snapshot, identity) ||
      signal.aborted ||
      !documents.get(value.documentId)?.live
    )
      throw failure("native_resource_aborted");
    if (uploads.size >= 4 || value.body.byteLength > 8 * 1024 * 1024)
      throw failure("native_owner_upload_limit");
    const bytes = value.body.slice(),
      id = Array.from(owner.crypto.getRandomValues(new Uint8Array(16)), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
      record: UploadRecord = { id, cancelled: false };
    uploads.set(id, record);
    let cleanup: Promise<void> | undefined;
    const abort = () => {
      cleanup ??= abortUpload(record);
    };
    signal.addEventListener("abort", abort, { once: true });
    const active = () => {
      check();
      if (signal.aborted || record.cancelled)
        throw failure("native_resource_aborted");
    };
    try {
      active();
      const digest = Array.from(
        new Uint8Array(
          await owner.crypto.subtle.digest("SHA-256", bytes as BufferSource),
        ),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      active();
      const ready = waitUpload(record, "upload-ready");
      send({
        type: "begin",
        uploadId: id,
        documentId: value.documentId,
        sourceURL: value.sourceURL,
        kind: value.kind,
        mime: value.mime,
        bodyBytes: bytes.byteLength,
        sha256: digest,
        policy: value.policy,
      });
      await ready;
      active();
      for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
        while (socket!.bufferedAmount > 128 * 1024) {
          await new Promise((resolve) => setTimeout(resolve, 4));
          active();
        }
        active();
        const part = bytes.subarray(
            offset,
            Math.min(offset + 65536, bytes.byteLength),
          ),
          frame = new Uint8Array(32 + part.byteLength);
        frame.set(new TextEncoder().encode(id));
        frame.set(part, 32);
        socket!.send(frame);
      }
      active();
      const committed = waitUpload(record, "resource-ready");
      send({ type: "commit", uploadId: id });
      const result = await committed;
      active();
      const url = new URL(result.url);
      if (
        url.origin !== snapshot.resourceOrigin ||
        !/^\/native-resource\/v1\/resource\/[A-Za-z0-9_-]{43}$/.test(
          url.pathname,
        ) ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw failure("native_owner_invalid_resource");
      return url.href;
    } catch (error) {
      if (live && !cleanup) cleanup = abortUpload(record);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (cleanup) await cleanup;
      else uploads.delete(id);
    }
  }
  const signed = await grant(false);
  try {
    const registered = await json("/native-resource/v1/owners", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + signed.ownerTicket,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (
      !own(registered, [
        "capability",
        "websocket",
        "resourceOrigin",
        "expiresAt",
      ]) ||
      !cap.test(registered.capability) ||
      registered.websocket !==
        "/native-resource/v1/owner/" + registered.capability ||
      registered.resourceOrigin !== snapshot.resourceOrigin ||
      !Number.isSafeInteger(registered.expiresAt) ||
      registered.expiresAt <= Date.now() ||
      registered.expiresAt > signed.expiresAt
    )
      throw failure("native_owner_invalid_grant");
    ownerCap = registered.capability;
    expiresAt = registered.expiresAt;
    const address = new URL(registered.websocket, snapshot.resourceOrigin);
    address.protocol = "wss:";
    socket = new NativeWebSocket(address);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(failure("native_owner_control_timeout")),
        timeoutMs,
      );
      let ready = false;
      socket!.addEventListener("message", (event) => {
        if (!live) return;
        try {
          check();
          if (typeof event.data !== "string" || event.data.length > 4096)
            throw failure("native_owner_invalid_control");
          const value = JSON.parse(event.data);
          if (!ready) {
            if (
              !own(value, ["type", "capability"]) ||
              value.type !== "ready" ||
              value.capability !== "native-resource-gateway-v1"
            )
              throw failure("native_owner_invalid_control");
            ready = true;
            clearTimeout(timer);
            lastPong = Date.now();
            resolve();
            return;
          }
          if (own(value, ["type"]) && value.type === "pong") {
            lastPong = Date.now();
            return;
          }
          if (value.type === "error")
            throw failure("native_owner_upload_denied");
          if (
            !own(value, ["type", "uploadId", "url"]) ||
            !["upload-ready", "resource-ready", "upload-aborted"].includes(
              value.type,
            ) ||
            typeof value.uploadId !== "string"
          )
            throw failure("native_owner_invalid_control");
          const record = uploads.get(value.uploadId);
          if (!record) return;
          if (record.cancelled && value.type !== "upload-aborted") return;
          if (record.waiter?.type !== value.type)
            throw failure("native_owner_upload_state");
          const waiter = record.waiter!;
          record.waiter = undefined;
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        } catch {
          clearTimeout(timer);
          reject(failure("native_owner_invalid_control"));
          dispose("native_owner_invalid_control");
        }
      });
      socket!.addEventListener("close", () => {
        clearTimeout(timer);
        reject(failure("native_owner_control_closed"));
        dispose("native_owner_control_closed");
      });
      socket!.addEventListener("error", () => {
        clearTimeout(timer);
        reject(failure("native_owner_control_failed"));
        dispose("native_owner_control_failed");
      });
    });
    check();
    schedule();
    heartbeat = setInterval(() => {
      try {
        if (Date.now() - lastPong > 45000)
          throw failure("native_owner_heartbeat_timeout");
        send({ type: "ping" });
      } catch {
        dispose("native_owner_control_unavailable");
      }
    }, 15000);
  } catch (error) {
    dispose("native_owner_registration_failed");
    throw error;
  }
  return {
    async bind(input: BindingInput) {
      if (renewal) await renewal;
      check();
      if (
        !identifier.test(input.documentId) ||
        documents.has(input.documentId) ||
        documents.size >= 32
      )
        throw failure("native_owner_invalid_document");
      // Reserve identity BEFORE asynchronous registration; no duplicate document can
      // inherit a port while registration/hydration is in flight.
      let readyResolve!: () => void, readyReject!: (e: Error) => void;
      const initialReady = new Promise<void>((r, j) => {
        readyResolve = r;
        readyReject = j;
      });
      void initialReady.catch(() => {});
      let registrationDone!: () => void;
      const registrationFlight = new Promise<void>(
        (resolve) => (registrationDone = resolve),
      );
      bindingFlights.add(registrationFlight);
      const port = input.port,
        record = {} as DocumentBinding;
      const fontWaiters = new Map<
        string,
        {
          target: number;
          resolve: (url: string) => void;
          reject: (error: Error) => void;
          cleanup: () => void;
        }
      >();
      const fontBindings = new Map<string, number>();
      const post = (value: object, transfer: Transferable[] = []) => {
        if (record.live)
          port.postMessage(
            {
              protocol: NATIVE_RESOURCE_DOCUMENT_PROTOCOL,
              documentId: input.documentId,
              ...value,
            },
            transfer,
          );
      };
      const docDispose = (code = "native_resource_document_disposed") => {
        if (!record.live) return;
        post({ type: "disposed" });
        record.live = false;
        documents.delete(input.documentId);
        clearTimeout(record.timer);
        record.reject(failure(code));
        for (const controller of record.pending.values()) controller.abort();
        record.pending.clear();
        for (const waiter of fontWaiters.values()) {
          waiter.cleanup();
          waiter.reject(failure("native_resource_document_disposed"));
        }
        fontWaiters.clear();
        fontBindings.clear();
        record.preparer?.dispose();
        port.removeEventListener("message", receive);
        port.close();
        if (live)
          try {
            send({ type: "revoke-document", documentId: input.documentId });
          } catch {
            dispose("native_owner_control_unavailable");
          }
      };
      Object.assign(record, {
        documentId: input.documentId,
        port,
        live: true,
        ready: initialReady,
        fulfill: readyResolve,
        reject: readyReject,
        enrollmentNonce: "",
        enrolled: false,
        next: 1,
        invalid: 0,
        pending: new Map(),
        dispose: docDispose,
      });
      documents.set(input.documentId, record);
      record.enroll = (value: string) => {
        check();
        if (!record.live) throw failure("native_resource_document_disposed");
        const url = new URL(value, snapshot.resourceOrigin);
        if (
          url.origin !== snapshot.resourceOrigin ||
          !/^\/native-resource\/v1\/enroll\/[A-Za-z0-9_-]{43}$/.test(
            url.pathname,
          ) ||
          url.search ||
          url.hash
        )
          throw failure("native_owner_invalid_enrollment");
        clearTimeout(record.timer);
        if (record.enrollmentNonce && !record.enrolled)
          record.reject(failure("native_resource_enrollment_superseded"));
        record.enrolled = false;
        record.enrollmentNonce = owner.crypto.randomUUID();
        if (record.ready !== initialReady || record.next !== 1) {
          record.ready = new Promise<void>((r, j) => {
            record.fulfill = r;
            record.reject = j;
          });
          void record.ready.catch(() => {});
        }
        record.timer = setTimeout(
          () => docDispose("native_resource_enrollment_timeout"),
          timeoutMs,
        );
        post({ type: "enroll", url: url.href, nonce: record.enrollmentNonce });
        return record.ready;
      };
      const revokeFonts = (target: number) => {
        for (const [fontId, sequence] of fontBindings) {
          if (sequence !== target) continue;
          fontBindings.delete(fontId);
          post({ type: "font-revoke", fontId });
        }
      };
      const bindFont = (
        target: number,
        font: NativeFontSnapshot,
        signal: AbortSignal,
      ) => {
        check();
        if (!record.live || signal.aborted || !record.pending.has(target))
          return Promise.reject(failure("native_resource_aborted"));
        const fontId = owner.crypto.randomUUID();
        return new Promise<string>((resolve, reject) => {
          const stop = (code: string) => {
            const waiter = fontWaiters.get(fontId);
            if (!waiter) return;
            fontWaiters.delete(fontId);
            waiter.cleanup();
            post({ type: "font-revoke", fontId });
            reject(failure(code));
          };
          const abort = () => stop("native_resource_aborted");
          const timer = setTimeout(
            () => stop("native_resource_font_binding_timeout"),
            timeoutMs,
          );
          const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          };
          fontWaiters.set(fontId, { target, resolve, reject, cleanup });
          signal.addEventListener("abort", abort, { once: true });
          const body = font.body.slice().buffer;
          post(
            {
              type: "font-snapshot",
              sequence: target,
              fontId,
              mime: font.mime,
              body,
            },
            [body],
          );
        });
      };
      const prepare = async (
        descriptor: NativeResourceDescriptor,
        signal?: AbortSignal,
        onScriptContext?: (binding: {
          identity: string;
          baseURL: string;
        }) => void,
        onFont?: (
          font: NativeFontSnapshot,
          identity: NativeResourceIdentity,
          signal: AbortSignal,
        ) => Promise<string>,
      ) => {
        await record.ready;
        check();
        if (!record.live) throw failure("native_resource_document_disposed");
        return record.preparer.prepare(
          descriptor,
          signal,
          onScriptContext,
          onFont,
        );
      };
      function receive(event: MessageEvent) {
        if (!record.live) return;
        const value = event.data;
        if (
          !own(value, [
            "protocol",
            "documentId",
            "type",
            "sequence",
            "descriptor",
            "target",
            "nonce",
            "fontId",
            "fontURL",
          ]) ||
          value.protocol !== NATIVE_RESOURCE_DOCUMENT_PROTOCOL ||
          value.documentId !== input.documentId ||
          value.sequence !== record.next ||
          !Number.isSafeInteger(record.next)
        )
          return invalid();
        record.next++;
        if (value.type === "font-bound") {
          const waiter =
            typeof value.fontId === "string" && fontWaiters.get(value.fontId);
          if (
            !waiter ||
            value.target !== waiter.target ||
            !record.pending.has(waiter.target) ||
            typeof value.fontURL !== "string" ||
            !/^blob:null\/[a-f0-9-]{36}$/i.test(value.fontURL)
          )
            return invalid();
          check();
          fontWaiters.delete(value.fontId);
          waiter.cleanup();
          fontBindings.set(value.fontId, waiter.target);
          waiter.resolve(value.fontURL);
          return;
        }
        if (
          value.type === "enrolled" &&
          typeof value.nonce === "string" &&
          value.nonce === record.enrollmentNonce &&
          !value.descriptor &&
          !value.target
        ) {
          record.enrolled = true;
          clearTimeout(record.timer);
          record.fulfill();
          return;
        }
        if (value.type === "enrollment-error") {
          docDispose("native_resource_enrollment_failed");
          return;
        }
        if (value.type === "dispose") {
          docDispose();
          return;
        }
        if (value.type === "cancel" && Number.isSafeInteger(value.target)) {
          record.pending.get(value.target)?.abort();
          return;
        }
        if (
          value.type !== "prepare" ||
          !own(value.descriptor, [
            "url",
            "kind",
            "crossOrigin",
            "integrity",
            "nonce",
            "scriptContext",
          ])
        )
          return invalid();
        const sequence = value.sequence;
        if (record.pending.size >= 4) {
          post({
            type: "error",
            sequence,
            code: "native_resource_request_limit",
          });
          return;
        }
        const controller = new AbortController();
        record.pending.set(sequence, controller);
        let scriptContext: { identity: string; baseURL: string } | undefined;
        void prepare(
          value.descriptor,
          controller.signal,
          (binding) => {
            scriptContext = binding;
          },
          (font, _identity, signal) => bindFont(sequence, font, signal),
        )
          .then(
            (url) => {
              if (record.live && !controller.signal.aborted)
                post({
                  type: "resource",
                  sequence,
                  url,
                  ...(scriptContext ? { scriptContext } : {}),
                });
            },
            (cause) => {
              revokeFonts(sequence);
              if (record.live)
                post({
                  type: "error",
                  sequence,
                  code: controller.signal.aborted
                    ? "native_resource_aborted"
                    : describeDocumentBootFailure("graph", cause).code,
                });
            },
          )
          .finally(() => record.pending.delete(sequence));
        function invalid() {
          if (++record.invalid >= 4)
            docDispose("native_resource_invalid_protocol");
        }
      }
      port.addEventListener("message", receive);
      port.start();
      try {
        const response = await json("/native-resource/v1/documents", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + ownerCap,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            documentId: input.documentId,
            documentURL: input.documentURL,
            topLevelURL: input.topLevelURL,
          }),
        });
        check();
        if (!record.live) throw failure("native_resource_document_disposed");
        if (
          !own(response, ["documentId", "enrollment"]) ||
          response.documentId !== input.documentId ||
          typeof response.enrollment !== "string"
        )
          throw failure("native_owner_invalid_document_grant");
        record.preparer = createNativeResourcePreparer({
          ...input,
          frontendOrigin: frontend,
          selectedIdentity: () => {
            check();
            return snapshot;
          },
          upload,
        });
        record.enroll(response.enrollment);
        return {
          get ready() {
            return record.ready;
          },
          prepare,
          dispose: docDispose,
        };
      } catch (error) {
        docDispose();
        throw error;
      } finally {
        registrationDone();
        bindingFlights.delete(registrationFlight);
      }
    },
    renew,
    dispose,
    stats() {
      return {
        live,
        documents: documents.size,
        uploads: uploads.size,
        expiresAt,
      };
    },
  };
}

/** Call inside the original trusted opaque-document bootstrap BEFORE website
 * scripts. This function is self-contained so a trusted builder may serialize
 * its exact implementation; it never exposes its port or enrollment image. */
export function createNativeResourceClient(options: {
  port: MessagePort;
  documentId: string;
  resourceOrigin: string;
  timeoutMs?: number;
  Image?: typeof Image;
}) {
  "use strict";
  const protocol = "atlas-native-resource-v1",
    port = options.port,
    documentId = options.documentId,
    timeout = options.timeoutMs ?? 10000;
  const apply = Reflect.apply,
    NativeURL = URL,
    NativeBlob = Blob,
    NativeMap = Map,
    nativeCreateObjectURL = URL.createObjectURL,
    nativeRevokeObjectURL = URL.revokeObjectURL,
    nativeMapGet = Map.prototype.get,
    nativeMapSet = Map.prototype.set,
    nativeMapDelete = Map.prototype.delete,
    nativeMapClear = Map.prototype.clear,
    nativeMapValues = Map.prototype.values,
    nativeMapSize = Object.getOwnPropertyDescriptor(
      Map.prototype,
      "size",
    )!.get!,
    nativeBufferLength = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )!.get!,
    NativePromise = Promise,
    NativeError = TypeError,
    NativeImage = options.Image ?? Image,
    NativeRegExpExec = RegExp.prototype.exec,
    NativeArrayIncludes = Array.prototype.includes,
    NativeDefineProperty = Object.defineProperty;
  const failureCodes = [
    "ORIGINAL_POLICY_DENIED",
    "ORIGINAL_POLICY_UNSUPPORTED",
    "ORIGINAL_PLAN_UNSUPPORTED",
    "NATIVE_RESOURCE_PREPARATION_FAILED",
    "NATIVE_FONT_DEPENDENCY_UNSUPPORTED",
    "CSS_CONDITIONAL_IMPORT_UNSUPPORTED",
    "UNSUPPORTED_RESOURCE_PATH",
    "STORAGE_INITIALIZATION_FAILED",
    "COOKIE_INITIALIZATION_FAILED",
    "NETWORK_INITIALIZATION_FAILED",
    "POLICY_INITIALIZATION_FAILED",
    "RESOURCE_GRAPH_FAILED",
    "RUNTIME_INITIALIZATION_FAILED",
    "DOCUMENT_WRITE_FAILED",
    "DOCUMENT_INITIALIZATION_FAILED",
    "RESOURCE_MIME_REJECTED",
    "RESOURCE_INTEGRITY_REJECTED",
    "RESOURCE_LIMIT_EXCEEDED",
    "RESOURCE_TRANSPORT_FAILED",
    "TRUSTED_TYPES_REJECTED",
  ];
  const nativeSetTimeout = setTimeout,
    nativeClearTimeout = clearTimeout,
    nativeKeys = Object.keys;
  const listen = EventTarget.prototype.addEventListener,
    remove = EventTarget.prototype.removeEventListener,
    post = MessagePort.prototype.postMessage,
    start = MessagePort.prototype.start,
    close = MessagePort.prototype.close;
  const dataGetter = Object.getOwnPropertyDescriptor(
      MessageEvent.prototype,
      "data",
    )!.get!,
    srcSetter = Object.getOwnPropertyDescriptor(
      NativeImage.prototype,
      "src",
    )?.set;
  const urlGetters = Object.fromEntries(
    [
      "origin",
      "pathname",
      "search",
      "hash",
      "href",
      "protocol",
      "username",
      "password",
      "hostname",
    ].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(NativeURL.prototype, name)!.get!,
    ]),
  );
  if (
    !srcSetter ||
    apply(NativeRegExpExec, /^[A-Za-z0-9_-]{16,96}$/, [documentId]) === null ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 120000
  )
    throw new NativeError("native_resource_client_invalid");
  const read = (url: URL, key: string) => apply(urlGetters[key], url, []);
  const expectedOrigin = read(new NativeURL(options.resourceOrigin), "origin");
  const frontendHost = globalThis.location?.href
    ? read(new NativeURL(globalThis.location.href), "hostname")
    : undefined;
  if (
    expectedOrigin !== options.resourceOrigin ||
    !expectedOrigin.startsWith("https://")
  )
    throw new NativeError("native_resource_client_invalid");
  const strict = (value: any, allowed: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    for (const key of nativeKeys(value))
      if (!allowed.includes(key)) return false;
    return true;
  };
  let live = true,
    next = 1,
    initial = true,
    invalid = 0,
    readyResolve!: () => void,
    readyReject!: (error: Error) => void,
    ready = new NativePromise<void>((r, j) => {
      readyResolve = r;
      readyReject = j;
    });
  void ready.catch(() => {});
  type Waiting = {
    resolve: (url: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    detach: () => void;
    scriptContext?: string;
    acceptScriptContext?: (baseURL: string) => void;
  };
  const pending = new NativeMap<number, Waiting>();
  const fontURLs = new NativeMap<string, string>();
  let fontBytes = 0;
  const get = (map: Map<any, any>, key: any) => apply(nativeMapGet, map, [key]);
  const set = (map: Map<any, any>, key: any, value: any) =>
    apply(nativeMapSet, map, [key, value]);
  const del = (map: Map<any, any>, key: any) =>
    apply(nativeMapDelete, map, [key]);
  const size = (map: Map<any, any>) => apply(nativeMapSize, map, []);
  const revokeFont = (fontId: string) => {
    const url = get(fontURLs, fontId);
    if (!url) return;
    del(fontURLs, fontId);
    apply(nativeRevokeObjectURL, NativeURL, [url]);
  };
  let enrollmentCancel: (() => void) | undefined;
  const send = (value: object) =>
    apply(post, port, [{ protocol, documentId, sequence: next++, ...value }]);
  const error = (code: string) => {
    const value = new NativeError(code);
    NativeDefineProperty(value, "code", { value: code });
    return value;
  };
  const dispose = () => {
    if (!live) return;
    try {
      send({ type: "dispose" });
    } catch {}
    live = false;
    enrollmentCancel?.();
    readyReject(error("native_resource_client_disposed"));
    for (const item of apply(nativeMapValues, pending, [])) {
      nativeClearTimeout(item.timer);
      item.detach();
      item.reject(error("native_resource_client_disposed"));
    }
    apply(nativeMapClear, pending, []);
    for (const url of apply(nativeMapValues, fontURLs, []))
      apply(nativeRevokeObjectURL, NativeURL, [url]);
    apply(nativeMapClear, fontURLs, []);
    apply(remove, port, ["message", receive]);
    apply(close, port, []);
  };
  function receive(event: MessageEvent) {
    if (!live) return;
    const value = apply(dataGetter, event, []);
    if (
      !strict(value, [
        "protocol",
        "documentId",
        "type",
        "url",
        "nonce",
        "sequence",
        "code",
        "scriptContext",
        "fontId",
        "mime",
        "body",
      ]) ||
      value.protocol !== protocol ||
      value.documentId !== documentId
    ) {
      if (++invalid >= 4) dispose();
      return;
    }
    if (value.type === "enroll") {
      try {
        if (
          typeof value.url !== "string" ||
          typeof value.nonce !== "string" ||
          value.nonce.length > 128
        )
          throw error("native_resource_enrollment_invalid");
        const url = new NativeURL(value.url);
        if (
          read(url, "origin") !== expectedOrigin ||
          apply(
            NativeRegExpExec,
            /^\/native-resource\/v1\/enroll\/[A-Za-z0-9_-]{43}$/,
            [read(url, "pathname")],
          ) === null ||
          read(url, "search") ||
          read(url, "hash")
        )
          throw error("native_resource_enrollment_invalid");
        enrollmentCancel?.();
        if (!initial) {
          ready = new NativePromise<void>((r, j) => {
            readyResolve = r;
            readyReject = j;
          });
          void ready.catch(() => {});
        }
        initial = false;
        const image = new NativeImage();
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          nativeClearTimeout(timer);
          apply(remove, image, ["load", loaded]);
          apply(remove, image, ["error", failed]);
          enrollmentCancel = undefined;
          if (!live) return;
          send({
            type: ok ? "enrolled" : "enrollment-error",
            nonce: value.nonce,
          });
          if (ok) readyResolve();
          else {
            readyReject(error("native_resource_enrollment_failed"));
            dispose();
          }
        };
        const loaded = () => finish(true),
          failed = () => finish(false),
          timer = nativeSetTimeout(failed, timeout);
        enrollmentCancel = () => finish(false);
        apply(listen, image, ["load", loaded]);
        apply(listen, image, ["error", failed]);
        apply(srcSetter!, image, [read(url, "href")]);
      } catch {
        readyReject(error("native_resource_enrollment_failed"));
        dispose();
      }
      return;
    }
    if (value.type === "disposed") {
      dispose();
      return;
    }
    if (value.type === "font-revoke") {
      if (typeof value.fontId === "string") revokeFont(value.fontId);
      return;
    }
    if (value.type === "font-snapshot") {
      try {
        const item = get(pending, value.sequence);
        const bytes = apply(nativeBufferLength, value.body, []);
        if (
          !item ||
          typeof value.fontId !== "string" ||
          apply(NativeRegExpExec, /^[a-f0-9-]{36}$/i, [value.fontId]) ===
            null ||
          get(fontURLs, value.fontId) ||
          typeof value.mime !== "string" ||
          apply(NativeRegExpExec, /^font\/(?:woff2?|ttf|otf)$/, [
            value.mime,
          ]) === null ||
          bytes < 1 ||
          bytes > 8 * 1024 * 1024 ||
          fontBytes + bytes > 32 * 1024 * 1024 ||
          size(fontURLs) >= 128
        )
          throw error("native_resource_invalid_font_snapshot");
        const font = new NativeBlob([value.body], { type: value.mime });
        const url = apply(nativeCreateObjectURL, NativeURL, [font]);
        if (
          apply(NativeRegExpExec, /^blob:null\/[a-f0-9-]{36}$/i, [url]) === null
        ) {
          apply(nativeRevokeObjectURL, NativeURL, [url]);
          throw error("native_resource_invalid_font_blob");
        }
        fontBytes += bytes;
        set(fontURLs, value.fontId, url);
        send({
          type: "font-bound",
          target: value.sequence,
          fontId: value.fontId,
          fontURL: url,
        });
      } catch {
        dispose();
      }
      return;
    }
    const item = get(pending, value.sequence);
    if (!item) return;
    del(pending, value.sequence);
    nativeClearTimeout(item.timer);
    item.detach();
    if (value.type !== "resource" || typeof value.url !== "string") {
      item.reject(
        error(
          value.type === "error" &&
            typeof value.code === "string" &&
            apply(NativeArrayIncludes, failureCodes, [value.code])
            ? value.code
            : "native_resource_failed",
        ),
      );
      return;
    }
    try {
      const url = new NativeURL(value.url);
      if (
        read(url, "origin") !== expectedOrigin ||
        apply(
          NativeRegExpExec,
          /^\/native-resource\/v1\/resource\/[A-Za-z0-9_-]{43}$/,
          [read(url, "pathname")],
        ) === null ||
        read(url, "search") ||
        read(url, "hash")
      )
        throw error("native_resource_invalid_url");
      if (item.scriptContext) {
        if (
          !strict(value.scriptContext, ["identity", "baseURL"]) ||
          value.scriptContext.identity !== item.scriptContext ||
          typeof value.scriptContext.baseURL !== "string" ||
          value.scriptContext.baseURL.length > 16384
        )
          throw error("native_resource_invalid_script_context");
        const base = new NativeURL(value.scriptContext.baseURL);
        if (
          !["http:", "https:"].includes(read(base, "protocol")) ||
          read(base, "username") ||
          read(base, "password") ||
          read(base, "hostname") === frontendHost ||
          read(base, "hostname") ===
            read(new NativeURL(expectedOrigin), "hostname")
        )
          throw error("native_resource_invalid_script_context");
        item.acceptScriptContext?.(read(base, "href"));
      } else if (value.scriptContext !== undefined)
        throw error("native_resource_invalid_script_context");
      item.resolve(read(url, "href"));
    } catch {
      item.reject(error("native_resource_invalid_url"));
      dispose();
    }
  }
  apply(listen, port, ["message", receive]);
  apply(start, port, []);
  return {
    get ready() {
      return ready;
    },
    async prepare(
      descriptor: NativeResourceDescriptor,
      signal?: AbortSignal,
      acceptScriptContext?: (baseURL: string) => void,
    ) {
      await ready;
      if (!live || signal?.aborted) throw error("native_resource_aborted");
      if (
        !strict(descriptor, [
          "url",
          "kind",
          "crossOrigin",
          "integrity",
          "nonce",
          "scriptContext",
        ]) ||
        typeof descriptor.url !== "string" ||
        descriptor.url.length > 16384 ||
        !["image", "style", "script", "audio", "video"].includes(
          descriptor.kind,
        ) ||
        (descriptor.crossOrigin !== undefined &&
          !["anonymous", "use-credentials"].includes(descriptor.crossOrigin)) ||
        (descriptor.integrity !== undefined &&
          (typeof descriptor.integrity !== "string" ||
            descriptor.integrity.length > 16384)) ||
        (descriptor.nonce !== undefined &&
          (typeof descriptor.nonce !== "string" ||
            descriptor.nonce.length > 1024)) ||
        (descriptor.scriptContext !== undefined &&
          (descriptor.kind !== "script" ||
            typeof descriptor.scriptContext !== "string" ||
            apply(NativeRegExpExec, /^atlas-script-context:[a-f0-9]{32}$/, [
              descriptor.scriptContext,
            ]) === null)) ||
        size(pending) >= 4
      )
        throw error("native_resource_request_denied");
      const sequence = next;
      return new NativePromise<string>((resolve, reject) => {
        const cancelled = () => {
          const item = get(pending, sequence);
          if (!item) return;
          del(pending, sequence);
          nativeClearTimeout(item.timer);
          item.detach();
          send({ type: "cancel", target: sequence });
          reject(error("native_resource_aborted"));
        };
        const timer = nativeSetTimeout(cancelled, timeout),
          detach = () => signal?.removeEventListener("abort", cancelled);
        set(pending, sequence, {
          resolve,
          reject,
          timer,
          detach,
          scriptContext: descriptor.scriptContext,
          acceptScriptContext,
        });
        signal?.addEventListener("abort", cancelled, { once: true });
        send({ type: "prepare", descriptor });
      });
    },
    dispose,
  };
}
