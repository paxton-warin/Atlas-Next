import { createPrivateCookieLocalView } from "./cookie-local-view.ts";
import {createCookieLocalReceiptReader, COOKIE_LOCAL_RECEIPT_PROBE} from "./cookie-local-receipt.ts";
import { createCookieViewCache, type CookieViewClock } from "./cookie-view-cache.ts";
import { createCookieReadBatch } from "./cookie-read-batch.ts";
/** Opaque-document synchronous cookie descriptor. All authority is in the
 * independently running trusted worker; no optimistic mirror or cookie parser.
 * Every accessor uses the explicit encrypted result rendezvous (not offline
 * native equivalence). Native XHR primitives are captured before website hooks. */
import {
  COOKIE_RESULT_PROTOCOL,
  openCookieResult,
  type CookieOperation,
  validateCookieViewEntries, cookieViewString,
} from "./sandbox-cookie-result.ts";
export async function createSandboxDocumentCookie(options: {
  documentId: string;
  endpoint: string;
  port: MessagePort;
  window?: Window & typeof globalThis;
  readyTimeoutMs?: number;
  /** Normal controller: reuse completed read results only until the next microtask. */
  batchReads?: boolean;
  /** V2: native completion receipts only; never HTTP or online-state gating. */
  localOnly?: boolean;
  /** Normal profile only: causally invalidated completed views, never a TTL cache. */
  viewClock?: CookieViewClock;
}) {
  const owner = options.window ?? window,
    { documentId, port } = options;
  const apply = Reflect.apply,
    dataGetter = Object.getOwnPropertyDescriptor(
      owner.MessageEvent.prototype,
      "data",
    )!.get!,
    postMessage = owner.MessagePort.prototype.postMessage,
    add = owner.EventTarget.prototype.addEventListener,
    remove = owner.EventTarget.prototype.removeEventListener,
    start = owner.MessagePort.prototype.start,
    close = owner.MessagePort.prototype.close,
    fill = owner.Uint8Array.prototype.fill;
  const endpoint = new URL(options.endpoint, owner.location.href);
  if (
    !/^[A-Za-z0-9_-]{16,96}$/.test(documentId) ||
    endpoint.origin !== owner.location.origin ||
    !/^\/browse\/cookies\/result\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new TypeError("Invalid cookie result endpoint");
  const XHR = owner.XMLHttpRequest,
    open = XHR.prototype.open,
    send = XHR.prototype.send,
    responseHeader = XHR.prototype.getResponseHeader,
    header = XHR.prototype.setRequestHeader;
  const nativeNavigator=owner.navigator,nativeOnline=owner.Navigator&&Object.getOwnPropertyDescriptor(owner.Navigator.prototype,'onLine')?.get;
  const responseText = Object.getOwnPropertyDescriptor(
      XHR.prototype,
      "responseText",
    )!.get!,
    status = Object.getOwnPropertyDescriptor(XHR.prototype, "status")!.get!;
  const post = (value: unknown) => apply(postMessage, port, [value]),
    parse = JSON.parse.bind(JSON),
    stringify = JSON.stringify.bind(JSON);
  const batch = options.batchReads ? createCookieReadBatch(owner, callback => owner.queueMicrotask(callback)) : undefined;
  const viewCache = options.viewClock ? createCookieViewCache(options.viewClock) : undefined;
  let localReceipt: ReturnType<typeof createCookieLocalReceiptReader> = null;
  const localState = createPrivateCookieLocalView();
  let localRevision = 0, localStale = true,
    localURL = '', localExpires: number | null = null, localView = '';
  let priorBatchKey: string | undefined, batchKeyKnown = false;
  let live = true,
    sequence = 0,
    key: Uint8Array | undefined,
    version = 0,
    documentURL = "",
    websiteOrigin = "";
  let receive: EventListener | undefined,
    messageError: EventListener | undefined;
  const dispose = () => {
    if (!live) return;
    live = false;
    batch?.invalidate();
    viewCache?.clear();
    try {
      post({ protocol: COOKIE_RESULT_PROTOCOL, documentId, type: "dispose" });
    } catch {}
    localReceipt?.dispose(); localReceipt = null;
    localState.clear(); localView = ''; localStale = true;
    if (key) apply(fill, key, [0]);
    if (receive) apply(remove, port, ["message", receive]);
    if (messageError) apply(remove, port, ["messageerror", messageError]);
    apply(close, port, []);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = owner.setTimeout(() => {
      dispose();
      reject(new DOMException("Cookie binding timed out", "TimeoutError"));
    }, options.readyTimeoutMs ?? 10000);
    receive = (event) => {
      const data = apply(dataGetter, event, []);
      if (
        !live ||
        data?.protocol !== COOKIE_RESULT_PROTOCOL ||
        data?.documentId !== documentId
      )
        return;
      if (
        !key &&
        data.type === "ready" &&
        data.key instanceof owner.Uint8Array &&
        data.key.length === 32
      ) {
        const initial = new URL(data.documentURL);
        if (
          !/^https?:$/.test(initial.protocol) ||
          initial.username ||
          initial.password ||
          initial.origin === endpoint.origin
        ) {
          dispose();
          owner.clearTimeout(timer);
          reject(
            new DOMException("Invalid cookie website binding", "SecurityError"),
          );
          return;
        }
        initial.hash = "";
        documentURL = initial.href;
        websiteOrigin = initial.origin;
        key = data.key;
        if (options.localOnly) {
          if (data.localMode !== 2 || !validateCookieViewEntries(data.entries) ||
              !Number.isSafeInteger(data.cookieRevision) || data.cookieRevision < 0 || data.viewVersion !== 0 ||
              (data.expiresAt !== null && !Number.isFinite(data.expiresAt)) ||
              cookieViewString(data.entries,owner.Date.now()) !== data.view) {
            dispose();owner.clearTimeout(timer);reject(new DOMException('Invalid initialized local cookie view','SecurityError'));return;
          }
          localState.replace(data.entries, owner.Date.now()); localRevision = data.cookieRevision;
          localURL = documentURL; localExpires = data.expiresAt; localView = data.view; localStale = false;
          localReceipt = createCookieLocalReceiptReader({host:owner, documentId, grant:data.localReceipt});
          if (!localReceipt || localReceipt.read(0) !== COOKIE_LOCAL_RECEIPT_PROBE ||
              (localReceipt.splitOperations && localReceipt.read(0, "set") !== COOKIE_LOCAL_RECEIPT_PROBE)) {
            dispose(); owner.clearTimeout(timer);
            reject(new DOMException("Browser-local cookie receipts are unsupported; original data is retained", "NotSupportedError"));
            return;
          }
        }
        owner.clearTimeout(timer);
        resolve();
      } else if (options.localOnly && data.type === 'invalidate') {
        if (!Number.isSafeInteger(data.cookieRevision) || data.cookieRevision > localRevision) localStale = true;
      } else if (data.type === "revoked") {
        owner.clearTimeout(timer);
        dispose();
        reject(
          new DOMException("Cookie document revoked", "InvalidStateError"),
        );
      }
    };
    messageError = () => {
      owner.clearTimeout(timer);
      dispose();
      reject(new DOMException("Cookie binding failed", "InvalidStateError"));
    };
    apply(add, port, ["message", receive]);
    apply(add, port, ["messageerror", messageError]);
    apply(start, port, []);
  });
  function access(operation: CookieOperation, line?: string) {
    if(!options.localOnly&&nativeOnline&&apply(nativeOnline,nativeNavigator,[])===false)
      throw new DOMException('Cookie access is unavailable while this browser is completely offline; committed cookies are retained.','NetworkError');
    if (!live || !key)
      throw new DOMException("Cookie document disposed", "InvalidStateError");
    if (options.localOnly && operation === 'get' && !localStale && localURL === documentURL &&
        (localExpires === null || owner.Date.now() < localExpires)) return localView;
    const epoch = options.localOnly ? undefined : options.viewClock?.current();
    const useViewCache = !!viewCache && epoch !== undefined;
    const batchKey = !useViewCache ? options.viewClock?.batchKey?.() : undefined;
    if (!options.localOnly && operation === "get") {
      if (!useViewCache && options.viewClock && (!batchKeyKnown || batchKey !== priorBatchKey)) {
        batch?.clear(); priorBatchKey = batchKey; batchKeyKnown = true;
      }
      const cached = useViewCache
        ? viewCache!.get(documentURL, owner.Date.now(), epoch)
        : batch?.get(documentURL, owner.Date.now());
      if (cached !== undefined) return cached;
    } else {
      batch?.invalidate(); viewCache?.clear();
      options.viewClock?.invalidate();
    }
    if (!Number.isSafeInteger(++sequence)) {
      dispose();
      throw new DOMException("Cookie sequence exhausted", "InvalidStateError");
    }
    const expected = { documentId, sequence, operation };
    post({
      protocol: COOKIE_RESULT_PROTOCOL,
      documentId,
      sequence,
      type: operation,
      url: documentURL,
      ...(operation === "set" ? { line } : {}),
    });
    let authenticatedOperationFailure = false;
    try {
      let packet: string | undefined;
      let xhr: XMLHttpRequest | undefined;
      if (options.localOnly) {
        packet = localReceipt?.read(sequence, operation);
        if (packet === undefined) {
          post({protocol:COOKIE_RESULT_PROTOCOL,documentId,type:'receipt',sequence,operation});
          packet = localReceipt?.read(sequence, operation);
        }
        if (packet === undefined) throw new DOMException("Local cookie acknowledgement unavailable; the write may be durable", "InvalidStateError");
      } else {
      xhr = new XHR();
      apply(open, xhr, ["POST", endpoint.href, false]);
      apply(header, xhr, ["Content-Type", "text/plain;charset=UTF-8"]);
      apply(send, xhr, [stringify({ sequence })]);
      if (apply(status, xhr, []) !== 200)
        throw new DOMException(
          "Cookie result unavailable; a completed write may already be durable",
          "NetworkError",
        );
      const envelope = parse(apply(responseText, xhr, []));
      if (!envelope?.ok || typeof envelope.packet !== "string")
        throw new DOMException("Cookie result unavailable", "NetworkError");
      packet = envelope.packet;
      }
      const result = openCookieResult(key, packet!, expected);
      const previousVersion = version;
      if (result.viewVersion < version)
        throw new DOMException("Stale cookie result", "SecurityError");
      version = result.viewVersion;
      if (result.error) {
        authenticatedOperationFailure = options.localOnly === true; localStale = true;
        throw new DOMException("Cookie operation failed", result.error);
      }
      if (options.localOnly) {
        if (result.localMode !== 2) throw new DOMException('Invalid local cookie result','SecurityError');
        if (operation === 'get') {
          localView = localState.replace(result.entries!,owner.Date.now()); localRevision = result.cookieRevision!;
          localURL = documentURL; localExpires = result.expiresAt; localStale = false;
          return localView;
        }
        const delta = result.delta!;
        const current = !localStale && localURL === documentURL &&
          delta.baseVersion === previousVersion && delta.baseRevision === localRevision;
        if (current) {
          localView = localState.update(delta,owner.Date.now());localRevision = result.cookieRevision!;
          localExpires = localState.expiresAt;
          localStale = false;
        } else localStale = true;
        // Setters expose no jar snapshot; the accepted change is locally durable.
        // A causal gap refreshes on the next getter rather than inventing a view.
        return '';
      }
      if (xhr) options.viewClock?.authorize?.(apply(responseHeader, xhr, ["x-atlas-cookie-view-epoch"]));
      // Only the worker's completed, authenticated result may seed the batch.
      if (operation === "get") {
        if (useViewCache) viewCache!.remember(result.view, documentURL, result.expiresAt, epoch);
        // No new cache permission is required for r14's existing same-job
        // batch. A fence/epoch transition during the result invalidates it.
        else if (!options.viewClock || batchKey === options.viewClock.batchKey?.())
          batch?.remember(result.view, documentURL, result.expiresAt);
      } else if (!viewCache) batch?.remember(result.view, documentURL, result.expiresAt);
      return result.view;
    } catch (error) {
      if (!authenticatedOperationFailure) dispose();
      throw error;
    } finally {
      if (operation === "set") options.viewClock?.invalidate();
    }
  }
  return Object.freeze({
    get: () => access("get"),
    setURL(value: string) {
      const url = new URL(value);
      if (url.origin !== websiteOrigin || url.username || url.password)
        throw new DOMException(
          "Cookie website origin is immutable",
          "SecurityError",
        );
      url.hash = "";
      documentURL = url.href;
    },
    set(value: unknown) {
      if (typeof value === "symbol")
        throw new TypeError("Cookie value cannot be a Symbol");
      access("set", String(value));
    },
    install(target = owner, currentURL?: () => string) {
      const updateURL = () => {
        if (!currentURL) return;
        const url = new URL(currentURL());
        if (url.origin !== websiteOrigin || url.username || url.password)
          throw new DOMException("Cookie website origin is immutable", "SecurityError");
        url.hash = "";
        documentURL = url.href;
      };
      Object.defineProperty(target.Document.prototype, "cookie", {
        configurable: true,
        enumerable: true,
        get() {
          if (this !== target.document)
            throw new TypeError("Illegal invocation");
          updateURL();
          return access("get");
        },
        set(value) {
          if (this !== target.document)
            throw new TypeError("Illegal invocation");
          updateURL();
          if (typeof value === "symbol")
            throw new TypeError("Cookie value cannot be a Symbol");
          access("set", String(value));
        },
      });
      Reflect.deleteProperty(target, "cookieStore");
    },
    dispose,
  });
}
