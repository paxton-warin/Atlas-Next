/** Trusted, parent-document-bound dedicated-worker authority. Entry source is
 * same-logical-origin, worker-src checked before EVERY hop, and transferred only
 * after MIME/size/header checks. Worker requests use the WORKER response policy,
 * not the parent's connect-src. No website selects a storage namespace/node. */
import { bindSandboxNetwork } from "./sandbox-network.ts";
import { bindSandboxIndexedDB } from "./sandbox-idb.ts";
import {
  createOriginalDocumentPolicy,
  type OriginalDocumentPolicy,
} from "./original-document-policy.ts";
type NetworkOptions = Parameters<typeof bindSandboxNetwork>[0];
type WorkerRequest = Readonly<{
  workerId: string;
  url: string;
  kind: "classic" | "module";
  credentials: "omit" | "same-origin" | "include";
}>;
const failure = (code: string) => Object.assign(new Error(code), { code });
const keys = (value: object, allowed: readonly string[]) =>
  Object.keys(value).every((k) => allowed.includes(k));
const workerId = /^worker_[a-f0-9]{48}$/;
const sourceMIME = /^(?:text|application)\/(?:java|ecma)script$/i;
export function createSandboxWorkerBroker(options: {
  documentId: string;
  documentURL: string;
  frontendOrigin: string;
  forbiddenOrigins?: string[];
  originalPolicy?: OriginalDocumentPolicy;
  fetch: NetworkOptions["fetch"];
  /** Trusted rebinding after entry redirects, never a child-selected backend. */
  workerFetch?: (input: {
    parentDocumentId: string;
    documentId: string;
    documentURL: string;
  }) => NetworkOptions["fetch"];
  factory: IDBFactory;
  post(message: object, transfer: Transferable[]): void;
  channel?: () => MessageChannel;
  timeoutMs?: number;
}) {
  const logical = new URL(options.documentURL),
    frontend = new URL(options.frontendOrigin);
  const forbidden = new Set(
    [frontend, ...(options.forbiddenOrigins ?? []).map((u) => new URL(u))].map(
      (u) => u.hostname,
    ),
  );
  const timeoutMs = options.timeoutMs ?? 15000;
  if (
    !/^https?:$/.test(logical.protocol) ||
    logical.username ||
    logical.password ||
    forbidden.has(logical.hostname) ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(options.documentId) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw failure("worker_broker_invalid_options");
  type Record = {
    live: boolean;
    settled: boolean;
    controller: AbortController;
    close: (() => void)[];
    bytes: number;
  };
  const records = new Map<string, Record>();
  let live = true,
    nextRequest = 0,
    retainedBytes = 0;
  const channel = options.channel ?? (() => new MessageChannel());
  const close = (id: string) => {
    const record = records.get(id);
    if (!record || !record.live) return;
    record.live = false;
    record.controller.abort();
    for (const dispose of record.close.splice(0).reverse()) {
      try {
        dispose();
      } catch {}
    }
    retainedBytes -= record.bytes;
    record.bytes = 0;
    // A transport ignoring cancellation still occupies its bounded slot.
    if (record.settled) records.delete(id);
  };
  const checked = (value: string) => {
    if (typeof value !== "string" || value.length > 16384)
      throw failure("worker_source_url_denied");
    const u = new URL(
      options.originalPolicy?.upgradeURL(value) ?? value,
      logical,
    );
    if (
      u.origin !== logical.origin ||
      !/^https?:$/.test(u.protocol) ||
      u.username ||
      u.password ||
      forbidden.has(u.hostname)
    )
      throw failure("worker_source_url_denied");
    u.hash = "";
    return u;
  };
  async function source(input: WorkerRequest, record: Record) {
    let url = checked(input.url),
      redirects = 0,
      total = 0;
    const check = () => {
      if (!live || !record.live || record.controller.signal.aborted)
        throw failure("worker_source_aborted");
    };
    for (;;) {
      check();
      options.originalPolicy?.checkURL({
        url: url.href,
        kind: "worker",
        redirectCount: redirects,
      });
      const response = await options.fetch(
        {
          url: url.href,
          method: "GET",
          headers: [],
          mode: "same-origin",
          credentials:
            input.kind === "classic" ? "same-origin" : input.credentials,
          redirect: "manual",
          destination: "worker",
        },
        Object.freeze({
          documentId: options.documentId,
          documentURL: logical.href,
          origin: logical.origin,
          signal: record.controller.signal,
          preflight: false,
          requestOrigin: logical.origin,
          responseTaint: "basic",
          redirectCount: redirects,
          referrerURL: logical.href,
        }),
      );
      check();
      if (
        !response ||
        response.url !== url.href ||
        response.redirected ||
        !(response.body instanceof ArrayBuffer) ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599 ||
        !Array.isArray(response.headers) ||
        response.headers.length > 128 ||
        (total += response.body.byteLength) > 8 * 1024 * 1024
      )
        throw failure("worker_source_invalid_response");
      let headerBytes = 0;
      for (const pair of response.headers)
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some((v) => typeof v !== "string" || /[\0\r\n]/.test(v)) ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0]) ||
          /^set-cookie2?$/i.test(pair[0]) ||
          (headerBytes += pair[0].length + pair[1].length) > 65536
        )
          throw failure("worker_source_invalid_headers");
      const values = (name: string) =>
        response.headers
          .filter(([k]) => k.toLowerCase() === name)
          .map(([, v]) => v);
      const locations = values("location");
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        locations.length
      ) {
        if (++redirects > 20 || new Set(locations).size !== 1)
          throw failure("worker_source_redirect_denied");
        url = checked(new URL(locations[0], url).href);
        continue;
      }
      const types = values("content-type"),
        type = types[0]?.split(";")[0].trim();
      if (
        response.status < 200 ||
        response.status >= 300 ||
        [204, 205].includes(response.status) ||
        types.length !== 1 ||
        !sourceMIME.test(type)
      )
        throw failure("worker_source_mime_denied");
      const charset = types[0].match(
        /;\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
      );
      if (charset && !/^(?:utf-?8|us-ascii)$/i.test(charset[1] ?? charset[2]))
        throw failure("worker_source_encoding_denied");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
        throw failure("worker_source_encoding_denied");
      }
      const contentPolicies = values("content-security-policy").flatMap((v) =>
        v
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      );
      if (contentPolicies.length > 32)
        throw failure("worker_source_policy_limit");
      const policy = createOriginalDocumentPolicy({
        documentURL: url.href,
        contentPolicies,
      });
      // Blob workers inherit the parent's native compilation CSP. Do not
      // pretend mutable website-side API wrappers can impose a stricter worker
      // response policy. Hold that finite path in trusted code before granting.
      if (policy.trustedTypes.csp || options.originalPolicy?.trustedTypes.csp)
        throw failure("WORKER_TRUSTED_TYPES_UNSUPPORTED");
      for (const kind of ["javascript", "wasm"] as const) {
        let parentAllows = true;
        try {
          options.originalPolicy?.checkEval(kind);
        } catch {
          parentAllows = false;
        }
        if (parentAllows) {
          try {
            policy.checkEval(kind);
          } catch {
            throw failure("WORKER_RESPONSE_COMPILATION_UNSUPPORTED");
          }
        }
      }
      if (retainedBytes + response.body.byteLength > 32 * 1024 * 1024)
        throw failure("worker_source_parent_byte_limit");
      record.bytes = response.body.byteLength;
      retainedBytes += record.bytes;
      return {
        value: Object.freeze({ url: url.href, source: text, contentPolicies }),
        policy,
      };
    }
  }
  async function grant(input: WorkerRequest) {
    if (
      !live ||
      !workerId.test(input.workerId) ||
      records.has(input.workerId) ||
      records.size >= 16 ||
      !["classic", "module"].includes(input.kind) ||
      !["omit", "same-origin", "include"].includes(input.credentials)
    )
      throw failure("worker_grant_denied");
    const record: Record = {
      live: true,
      settled: false,
      controller: new AbortController(),
      close: [],
      bytes: 0,
    };
    records.set(input.workerId, record);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = source(input, record);
    void operation
      .finally(() => {
        record.settled = true;
        if (!record.live) records.delete(input.workerId);
      })
      .catch(() => {});
    try {
      const prepared = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            close(input.workerId);
            reject(failure("worker_source_timeout"));
          }, timeoutMs);
        }),
      ]);
      if (!live || !record.live) throw failure("worker_source_aborted");
      const network = channel(),
        indexedDB = channel();
      for (const c of [network, indexedDB])
        record.close.push(() => {
          c.port1.close();
          c.port2.close();
        });
      const networkBinding = bindSandboxNetwork({
        port: network.port1,
        documentId: input.workerId,
        documentURL: prepared.value.url,
        frontendOrigin: options.frontendOrigin,
        forbiddenOrigins: options.forbiddenOrigins,
        fetch:
          options.workerFetch?.({
            parentDocumentId: options.documentId,
            documentId: input.workerId,
            documentURL: prepared.value.url,
          }) ?? options.fetch,
        originalPolicy: prepared.policy,
      });
      record.close.push(networkBinding.dispose);
      const idbBinding = bindSandboxIndexedDB({
        port: indexedDB.port1,
        documentId: input.workerId,
        website: prepared.value.url,
        frontendOrigin: options.frontendOrigin,
        factory: options.factory,
      });
      record.close.push(idbBinding.dispose);
      return {
        source: prepared.value,
        network: network.port2,
        indexedDB: indexedDB.port2,
        dispose: () => close(input.workerId),
      };
    } catch (error) {
      close(input.workerId);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    grant,
    /** Called only for the captured parent control endpoint; no window listener.
     * True means the operation name belongs to this protocol, even if invalid. */
    receive(message: any, incomingPorts = 0) {
      if (
        !message ||
        !["worker-create", "worker-release"].includes(message.type)
      )
        return false;
      if (
        !live ||
        incomingPorts ||
        message.protocol !== 2 ||
        message.documentId !== options.documentId
      )
        return true;
      if (message.type === "worker-release") {
        if (
          keys(message, ["protocol", "documentId", "type", "workerId"]) &&
          workerId.test(message.workerId)
        )
          close(message.workerId);
        return true;
      }
      if (
        !keys(message, [
          "protocol",
          "documentId",
          "type",
          "requestId",
          "workerId",
          "url",
          "kind",
          "credentials",
        ]) ||
        !Number.isSafeInteger(message.requestId) ||
        message.requestId !== nextRequest + 1 ||
        !workerId.test(message.workerId)
      )
        return true;
      nextRequest = message.requestId;
      const requestId = message.requestId,
        id = message.workerId;
      void grant({
        workerId: id,
        url: message.url,
        kind: message.kind,
        credentials: message.credentials,
      }).then(
        (result) => {
          if (!live || !records.get(id)?.live) {
            result.dispose();
            return;
          }
          try {
            options.post(
              {
                protocol: 2,
                documentId: options.documentId,
                type: "worker-grant",
                requestId,
                workerId: id,
                ok: true,
                source: result.source,
              },
              [result.network, result.indexedDB],
            );
          } catch {
            result.dispose();
          }
        },
        (error) => {
          if (!live) return;
          const code = [
            "WORKER_RESPONSE_COMPILATION_UNSUPPORTED",
            "WORKER_TRUSTED_TYPES_UNSUPPORTED",
          ].includes(error?.code)
            ? error.code
            : error?.code === "original_policy_denied"
              ? "WORKER_POLICY_DENIED"
              : "WORKER_SOURCE_FAILED";
          try {
            options.post(
              {
                protocol: 2,
                documentId: options.documentId,
                type: "worker-grant",
                requestId,
                workerId: id,
                ok: false,
                code,
              },
              [],
            );
          } catch {}
        },
      );
      return true;
    },
    dispose() {
      if (!live) return;
      live = false;
      for (const id of records.keys()) close(id);
    },
    stats: () =>
      Object.freeze({
        live,
        workers: records.size,
        retainedSourceBytes: retainedBytes,
      }),
  };
}
