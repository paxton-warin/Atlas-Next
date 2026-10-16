/** Trusted-only reservation broker. It does not accept website-selected storage,
 * headers, parent identities, modules or arbitrary frontend destinations. It is
 * bound only to the default runtime's original-document controller. */
import {
  rendererTarget,
  prepareOpaqueDocument,
  type RendererFetch,
} from "./opaque-renderer.ts";
type Owner = Window & typeof globalThis;
type Reservation = Readonly<{
  helperURL: string;
  childId: string;
  secret: string;
}>;
const PROTOCOL = "atlas-renderer-v1";
const failure = (code: string) => Object.assign(new Error(code), { code });
export function createRendererHelperBroker(options: {
  window: Owner;
  parentDocumentId: string;
  parentWindow: Window;
  website: string;
  activeParent: () => boolean;
  authorizeFrame: (url: string) => void;
  reserveHelper: (scriptHashes: readonly string[]) => Promise<Reservation>;
  fetchResource: RendererFetch;
  fetchResourceFactory?: () => RendererFetch;
  timeoutMs?: number;
  /** Test scheduler seam only; it receives neither secret nor capabilities. */
  beforeGrant?: () => Promise<void>;
  beforeAttest?: () => Promise<void>;
}) {
  const w = options.window,
    origin = w.location.origin,
    parent = options.parentWindow;
  if (
    !/^[A-Za-z0-9_-]{16,96}$/.test(options.parentDocumentId) ||
    !["https://chatgpt.com", "https://chat.openai.com"].includes(
      new URL(options.website).origin,
    )
  )
    throw failure("RENDERER_PARENT_DENIED");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30000)
    throw failure("RENDERER_TIMEOUT_INVALID");
  const post = w.MessagePort.prototype.postMessage,
    start = w.MessagePort.prototype.start,
    close = w.MessagePort.prototype.close,
    add = w.EventTarget.prototype.addEventListener;
  const data = Object.getOwnPropertyDescriptor(
      w.MessageEvent.prototype,
      "data",
    )!.get!,
    ports = Object.getOwnPropertyDescriptor(
      w.MessageEvent.prototype,
      "ports",
    )!.get!;
  const send = (
    p: MessagePort,
    value: unknown,
    transfer: Transferable[] = [],
  ) => Reflect.apply(post, p, [value, transfer]);
  const listen = (
    p: MessagePort,
    fn: (data: any, ports: readonly MessagePort[]) => void,
  ) => {
    Reflect.apply(add, p, [
      "message",
      (e: MessageEvent) =>
        fn(Reflect.apply(data, e, []), Reflect.apply(ports, e, [])),
    ]);
    Reflect.apply(start, p, []);
  };
  const pending = new Map<string, any>();
  let live = true,
    ignored = 0,
    preparing = 0;
  const parentLive = () => live && options.activeParent();
  function belongs(child: Window) {
    try {
      return parentLive() && child !== parent && child.parent === parent;
    } catch {
      return false;
    }
  }
  function stop(entry: any, error?: Error) {
    if (entry.closed) return;
    entry.closed = true;
    w.clearTimeout(entry.timer);
    pending.delete(entry.childId);
    for (const p of [entry.rendezvous, entry.final])
      if (p) Reflect.apply(close, p, []);
    if (error) entry.reject(error);
  }
  const receive = async (event: MessageEvent) => {
    const m = Reflect.apply(data, event, []),
      transfers = Reflect.apply(ports, event, []) as readonly MessagePort[];
    const entry =
      m && typeof m === "object" ? pending.get(m.childId) : undefined;
    if (
      !event.isTrusted ||
      event.origin !== "null" ||
      !entry ||
      entry.accepted ||
      m.protocol !== PROTOCOL ||
      m.type !== "renderer-ready" ||
      m.parentDocumentId !== options.parentDocumentId ||
      m.secret !== entry.secret ||
      Object.keys(m).length !== 5 ||
      transfers.length !== 1 ||
      event.source !== entry.child ||
      !belongs(entry.child)
    ) {
      ignored++;
      return;
    }
    entry.accepted = true;
    entry.rendezvous = transfers[0];
    try {
      await options.beforeGrant?.();
      if (entry.closed || !belongs(entry.child))
        throw failure("RENDERER_PARENT_STALE");
      // The controller-created final channel travels only through the original
      // helper closure's rendezvous. Never deliver it to a reusable WindowProxy.
      const channel = new w.MessageChannel(),
        documentNonce =
          w.crypto.randomUUID().replaceAll("-", "") +
          w.crypto.randomUUID().replaceAll("-", "");
      entry.final = channel.port1;
      let acknowledged = false,
        written = false,
        challenge: string | undefined;
      listen(channel.port1, (reply, extra) => {
        if (
          entry.closed ||
          extra.length ||
          !belongs(entry.child) ||
          reply?.protocol !== PROTOCOL ||
          reply.childId !== entry.childId ||
          reply.documentNonce !== documentNonce
        )
          return;
        if (
          reply.type === "grant-ack" &&
          !acknowledged &&
          reply.active === true
        ) {
          acknowledged = true;
          send(channel.port1, {
            protocol: PROTOCOL,
            type: "content",
            childId: entry.childId,
            documentNonce,
            html: entry.prepared.html,
          });
          return;
        }
        if (reply.type === "written" && acknowledged && !written) {
          written = true;
          void (async () => {
            await options.beforeAttest?.();
            if (entry.closed || !belongs(entry.child)) return;
            challenge = w.crypto.randomUUID().replaceAll("-", "");
            send(channel.port1, {
              protocol: PROTOCOL,
              type: "attest",
              childId: entry.childId,
              documentNonce,
              challenge,
            });
          })().catch((error) => stop(entry, error as Error));
          return;
        }
        if (
          reply.type === "attestation" &&
          written &&
          challenge &&
          reply.challenge === challenge &&
          reply.active === true
        ) {
          entry.resolve(
            Object.freeze({
              resources: entry.prepared.resources,
              originalDocumentAttested: true as const,
            }),
          );
          stop(entry);
          return;
        }
        if (reply.type === "failed")
          stop(entry, failure("RENDERER_CONTENT_FAILED"));
      });
      send(
        entry.rendezvous,
        {
          protocol: PROTOCOL,
          type: "grant",
          parentDocumentId: options.parentDocumentId,
          childId: entry.childId,
          documentNonce,
        },
        [channel.port2],
      );
    } catch (error) {
      stop(entry, error as Error);
    }
  };
  Reflect.apply(add, w, ["message", receive]);
  return Object.freeze({
    async reserve(input: { url: string; slot: number }) {
      if (
        !parentLive() ||
        !Number.isInteger(input.slot) ||
        input.slot < 0 ||
        input.slot >= 8 ||
        pending.size + preparing >= 8
      )
        throw failure("RENDERER_RESERVATION_DENIED");
      // Reserve a trusted slot BEFORE the first source/hash/API await. Repeated
      // src mutations on one website frame cannot multiply preparing fetches.
      preparing++;
      try {
      const target = rendererTarget(input.url, options.website);
      if (!target) throw failure("RENDERER_DESTINATION_DENIED");
      options.authorizeFrame(target.href);
      let child: Window;
      try {
        child = parent.frames[input.slot];
      } catch {
        throw failure("RENDERER_WINDOW_DENIED");
      }
      if (!child || !belongs(child)) throw failure("RENDERER_WINDOW_DENIED");
      const prepared = await prepareOpaqueDocument(
        w,
        target,
        options.fetchResourceFactory?.() ?? options.fetchResource,
      );
      if (!parentLive() || parent.frames[input.slot] !== child)
        throw failure("RENDERER_PARENT_STALE");
      const tree = new w.DOMParser().parseFromString(
        prepared.html,
        "text/html",
      );
      const scripts = Array.from(tree.querySelectorAll("script"));
      if (
        !scripts.length ||
        scripts.length > 8 ||
        scripts.some((s) => s.hasAttribute("src"))
      )
        throw failure("RENDERER_PREPARED_SHAPE");
      const scriptHashes = await Promise.all(
        scripts.map(async (script) => {
          const bytes = new Uint8Array(
            await w.crypto.subtle.digest(
              "SHA-256",
              new w.TextEncoder().encode(script.textContent ?? ""),
            ),
          );
          return "'sha256-" + w.btoa(String.fromCharCode(...bytes)) + "'";
        }),
      );
      const grant = await options.reserveHelper(scriptHashes),
        helper = new URL(grant.helperURL);
      if (!parentLive() || parent.frames[input.slot] !== child)
        throw failure("RENDERER_PARENT_STALE");
      if (
        helper.origin !== origin ||
        helper.username ||
        helper.password ||
        helper.search ||
        helper.hash ||
        helper.pathname !==
          "/browse/renderer/v1/" +
            options.parentDocumentId +
            "/" +
            grant.childId ||
        !/^rndr_[a-f0-9]{32}$/.test(grant.childId) ||
        !/^([a-f0-9]{64})$/.test(grant.secret) ||
        pending.has(grant.childId)
      )
        throw failure("RENDERER_HELPER_ADDRESS_DENIED");
      let resolve!: (v: any) => void, reject!: (e: Error) => void;
      const ready = new Promise<{
        resources: number;
        originalDocumentAttested: true;
      }>((a, b) => {
        resolve = a;
        reject = b;
      });
      const entry = {
        ...grant,
        child,
        prepared,
        resolve,
        reject,
        accepted: false,
        closed: false,
        timer: 0,
      };
      pending.set(grant.childId, entry);
      entry.timer = w.setTimeout(
        () => stop(entry, failure("RENDERER_DOCUMENT_TIMEOUT")),
        timeoutMs,
      );
      return Object.freeze({
        helperURL: helper.href,
        childId: grant.childId,
        ready,
        cancel() {
          stop(entry, failure("RENDERER_CANCELLED"));
        },
      });
      } finally { preparing--; }
    },
    get pending() {
      return pending.size;
    },
    get ignored() {
      return ignored;
    },
    dispose() {
      if (!live) return;
      live = false;
      w.removeEventListener("message", receive);
      for (const entry of [...pending.values()])
        stop(entry, failure("RENDERER_PARENT_STALE"));
    },
  });
}
