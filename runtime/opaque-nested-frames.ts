/** General HTTP(S) child documents use the same trusted top-level controller as
 * their parent. The website receives only a reserved opaque frontend URL; the
 * original child bootstrap offers its private capabilities directly to top. */
import { rendererTarget } from "./opaque-renderer.ts";
import { resolveDocumentOrigin, type DocumentOrigin } from "./document-origin.ts";
export function nestedDocumentSandbox(mode: DocumentOrigin, sandbox: string | null) {
  return (sandbox ?? "allow-scripts allow-popups")
    .split(/\s+/)
    .filter((v) => v && v !== "allow-same-origin")
    .concat(resolveDocumentOrigin(mode) === "same-origin" ? ["allow-same-origin"] : [])
    .join(" ");
}
export function createOpaqueNestedFrames(options: {
  window: Window & typeof globalThis;
  documentOrigin?: DocumentOrigin;
  client: any;
  documentId: string;
  frontend: string;
  live: () => boolean;
  send: (message: object) => void;
  registerWindow(
    target: Window,
    origin: string | null,
    requestId?: number,
  ): void;
}) {
  const { window: win, client } = options;
  const documentOrigin = resolveDocumentOrigin(options.documentOrigin);
  const get = (element: Element, name: string): string | null =>
    client.natives.call("Element.prototype.getAttribute", element, name);
  const set = (element: Element, name: string, value: string) =>
    client.natives.call("Element.prototype.setAttribute", element, name, value);
  const remove = (element: Element, name: string) =>
    client.natives.call("Element.prototype.removeAttribute", element, name);
  const prototype = win.HTMLIFrameElement.prototype;
  const previousSrc = Object.getOwnPropertyDescriptor(prototype, "src")!;
  const previousSrcdoc = Object.getOwnPropertyDescriptor(prototype, "srcdoc");
  const previousSet = win.Element.prototype.setAttribute;
  type Record = { id: number; url: string; frameURL?: string; timer: number };
  const records = new Map<HTMLIFrameElement, Record>();
  const byId = new Map<number, HTMLIFrameElement>();
  let next = 0,
    live = true;
  const nativeSetTimeout = win.setTimeout.bind(win),
    nativeClearTimeout = win.clearTimeout.bind(win);
  const frame = (value: any): value is HTMLIFrameElement =>
    value?.nodeType === 1 &&
    value.localName === "iframe" &&
    value.ownerDocument === win.document;
  function logical(value: string) {
    if (value.startsWith(client.context.prefix.href))
      value = client.restoreurl(value);
    const u = new URL(value, client.url.href);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return;
    return u;
  }
  function cancel(element: HTMLIFrameElement) {
    const r = records.get(element);
    if (!r) return;
    records.delete(element);
    byId.delete(r.id);
    nativeClearTimeout(r.timer);
    options.send({
      protocol: 2,
      documentId: options.documentId,
      type: "nested-cancel",
      requestId: r.id,
    });
    if (element.contentWindow) {
      client.nativeOpaqueWindows.delete(element.contentWindow);
      options.registerWindow(element.contentWindow, null);
    }
  }
  function inspect(element: HTMLIFrameElement) {
    if (!live || !options.live() || !element.isConnected) return;
    const value = get(element, "runtimekit-attr-src") ?? get(element, "src");
    if (!value) return;
    let url: URL | undefined;
    try {
      url = logical(value);
    } catch {
      return;
    }
    if (!url || rendererTarget(url.href, client.url.href)) return;
    if (records.get(element)?.url === url.href) return;
    cancel(element);
    remove(element, "src");
    remove(element, "srcdoc");
    set(element, "runtimekit-attr-src", url.href);
    // Match only the trusted document composition; website attributes cannot
    // select the child's physical origin mode.
    const sandbox = get(element, "sandbox");
    if (sandbox !== null && !sandbox.split(/\s+/).includes("allow-scripts")) {
      element.dispatchEvent(new win.Event("error"));
      return;
    }
    set(
      element,
      "sandbox",
      nestedDocumentSandbox(documentOrigin, sandbox),
    );
    const child = element.contentWindow;
    let slot = -1;
    for (let i = 0; i < win.length && i < 32; i++)
      if (win.frames[i] === child) {
        slot = i;
        break;
      }
    if (slot < 0) {
      element.dispatchEvent(new win.Event("error"));
      return;
    }
    const id = ++next;
    const r: Record = {
      id,
      url: url.href,
      timer: nativeSetTimeout(() => {
        if (records.get(element) !== r) return;
        cancel(element);
        element.dispatchEvent(new win.Event("error"));
      }, 30000),
    };
    records.set(element, r);
    byId.set(id, element);
    options.send({
      protocol: 2,
      documentId: options.documentId,
      type: "nested-reserve",
      requestId: id,
      url: url.href,
      slot,
    });
  }
  function source(element: HTMLIFrameElement, value: string) {
    let u: URL | undefined;
    try {
      u = logical(value);
    } catch {}
    if (!u) return false;
    if (rendererTarget(u.href, client.url.href)) return false;
    cancel(element);
    set(element, "runtimekit-attr-src", u.href);
    remove(element, "src");
    remove(element, "srcdoc");
    queueMicrotask(() => inspect(element));
    return true;
  }
  if (previousSrc?.configurable)
    Object.defineProperty(prototype, "src", {
      ...previousSrc,
      get() {
        return get(this, "runtimekit-attr-src") ?? previousSrc.get!.call(this);
      },
      set(value) {
        if (!source(this, String(value))) previousSrc.set!.call(this, value);
      },
    });
  // Srcdoc has a different inherited logical origin and policy contract. Never
  // turn it into an unbrokered native document; keep this explicit until its
  // inherited-policy adapter is implemented.
  if (previousSrcdoc?.configurable)
    Object.defineProperty(prototype, "srcdoc", {
      ...previousSrcdoc,
      set() {
        throw new win.DOMException(
          "Inline child documents require inherited-policy preparation.",
          "NotSupportedError",
        );
      },
    });
  win.Element.prototype.setAttribute = function (name, value) {
    const key = String(name).toLowerCase();
    if (frame(this) && key === "src" && source(this, String(value))) return;
    if (frame(this) && key === "srcdoc")
      throw new win.DOMException(
        "Inline child documents require inherited-policy preparation.",
        "NotSupportedError",
      );
    return previousSet.call(this, name, value);
  };
  function scan(node: Node) {
    if (frame(node)) inspect(node);
    if (node instanceof win.Element || node instanceof win.Document)
      for (const element of Array.from(node.querySelectorAll("iframe")).slice(
        0,
        64,
      ))
        inspect(element as HTMLIFrameElement);
  }
  const observer = new win.MutationObserver((changes) => {
    for (const [element] of records) if (!element.isConnected) cancel(element);
    for (const change of changes.slice(0, 64)) {
      if (change.type === "attributes" && frame(change.target))
        inspect(change.target);
      for (const node of Array.from(change.addedNodes).slice(0, 32)) scan(node);
    }
  });
  observer.observe(win.document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "runtimekit-attr-src"],
  });
  const parsed = () => scan(win.document);
  client.natives.call(
    "EventTarget.prototype.addEventListener",
    win.document,
    "DOMContentLoaded",
    parsed,
    { once: true },
  );
  return {
    receive(message: any) {
      if (!live || !options.live() || message.type !== "nested-result")
        return false;
      const element = byId.get(message.requestId),
        r = element && records.get(element);
      if (!element || !r) return true;
      if (message.phase === "reserved") {
        try {
          const u = new URL(message.frameURL);
          if (
            u.origin !== options.frontend ||
            !/^\/browse\/frame\/doc_[a-f0-9]{32}$/.test(u.pathname) ||
            u.search ||
            u.hash ||
            u.username ||
            u.password ||
            !element.isConnected
          )
            throw Error();
          const origin = new URL(message.origin);
          if (
            !/^https?:$/.test(origin.protocol) ||
            origin.origin !== message.origin
          )
            throw Error();
          r.frameURL = u.href;
          if (element.contentWindow)
            options.registerWindow(element.contentWindow, origin.origin, r.id);
          if (element.contentWindow)
            client.nativeOpaqueWindows.add(element.contentWindow);
          remove(element, "srcdoc");
          set(element, "src", u.href);
        } catch {
          cancel(element);
          element.dispatchEvent(new win.Event("error"));
        }
      } else if (message.phase === "ready") nativeClearTimeout(r.timer);
      else if (message.phase === "navigate") {
        const nextURL = message.url;
        cancel(element);
        if (typeof nextURL === "string") source(element, nextURL);
      } else if (message.phase === "error") {
        cancel(element);
        element.dispatchEvent(new win.Event("error"));
      }
      return true;
    },
    dispose() {
      if (!live) return;
      live = false;
      observer.disconnect();
      for (const [element] of records) cancel(element);
      client.natives.call(
        "EventTarget.prototype.removeEventListener",
        win.document,
        "DOMContentLoaded",
        parsed,
      );
      if (previousSrc?.configurable)
        Object.defineProperty(prototype, "src", previousSrc);
      if (previousSrcdoc?.configurable)
        Object.defineProperty(prototype, "srcdoc", previousSrcdoc);
      win.Element.prototype.setAttribute = previousSet;
    },
  };
}
