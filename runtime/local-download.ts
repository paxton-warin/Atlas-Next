type LocalDownloadOptions = {
  pageURL(): string;
  nativeBlobURL(logicalURL: string): string;
};

/** Downloads do not enter the proxy service worker. Retain the original anchor,
 * event, filename and user activation; temporarily substitute a native local
 * URL for the default download action. Do not fetch or copy the Blob, or change ordinary HTTP downloads. */
export function createLocalDownloadInstaller(host: Window & typeof globalThis) {
  const getAttribute = host.Element.prototype.getAttribute;
  const setAttribute = host.Element.prototype.setAttribute;
  const removeAttribute = host.Element.prototype.removeAttribute;
  const hasAttribute = host.Element.prototype.hasAttribute;
  const addEventListener = host.EventTarget.prototype.addEventListener;
  const removeEventListener = host.EventTarget.prototype.removeEventListener;
  const closest = host.Element.prototype.closest;
  const documents = new WeakSet<Document>();

  return function installLocalDownloads(
    win: Window & typeof globalThis,
    options: LocalDownloadOptions,
  ) {
    const doc = win.document;
    if (documents.has(doc)) return;
    documents.add(doc);
    const pending = new WeakMap<HTMLAnchorElement, () => void>();
    function prepare(anchor: HTMLAnchorElement, event: Event) {
      if (
        event.defaultPrevented ||
        anchor.ownerDocument !== doc ||
        !hasAttribute.call(anchor, "download")
      )
        return;
      let native: string;
      try {
        const logical = anchor.href;
        if (logical.startsWith("blob:")) {
          if (new URL(logical).origin !== new URL(options.pageURL()).origin)
            return;
          native = options.nativeBlobURL(logical);
          if (
            new URL(native).protocol !== "blob:" ||
            new URL(native).origin !== host.location.origin
          )
            return;
        } else if (logical.startsWith("data:")) native = logical;
        else return;
      } catch {
        return;
      }
      const previous = getAttribute.call(anchor, "href");
      if (previous === native) return;
      // A second handler can replace the URL during the same click. Finish the
      // earlier substitution without restoring over that website-authored change.
      pending.get(anchor)?.();
      setAttribute.call(anchor, "href", native);
      let timer = 0;
      const restore = () => {
        host.clearTimeout(timer);
        if (pending.get(anchor) !== restore) return;
        pending.delete(anchor);
        if (getAttribute.call(anchor, "href") !== native) return;
        previous === null
          ? removeAttribute.call(anchor, "href")
          : setAttribute.call(anchor, "href", previous);
      };
      pending.set(anchor, restore);
      timer = host.setTimeout(restore, 0);
    }
    function lastListener(target: EventTarget, anchor: HTMLAnchorElement) {
      const listener = (event: Event) => {
        // Normal bubbling clicks wait for the final window listener, preserving
        // the logical href throughout target/ancestor website handlers. A stopped
        // or detached click needs its final target listener instead.
        if (
          target === win ||
          !event.bubbles ||
          event.cancelBubble ||
          !anchor.isConnected
        )
          prepare(anchor, event);
      };
      addEventListener.call(target, "click", listener, { once: true });
      return () => removeEventListener.call(target, "click", listener);
    }
    function activate<T>(
      anchor: HTMLAnchorElement,
      bubbles: boolean,
      run: () => T,
    ): T {
      if (anchor?.ownerDocument !== doc) return run();
      // Detached FileSaver anchors dispatch non-bubbling clicks. For connected
      // bubbling clicks, run after ancestor/window handlers instead of before them.
      const stopTarget = lastListener(anchor, anchor);
      const stopWindow =
        anchor.isConnected && bubbles ? lastListener(win, anchor) : () => {};
      try {
        return run();
      } finally {
        stopTarget();
        stopWindow();
        // Native synthetic activation selects the download before returning.
        // Restore synchronously so website code still sees its logical href.
        pending.get(anchor)?.();
      }
    }
    const prototype = win.HTMLAnchorElement.prototype;
    const dispatch = prototype.dispatchEvent;
    const click = prototype.click;
    Object.defineProperty(prototype, "dispatchEvent", {
      configurable: true,
      writable: true,
      value: function (this: HTMLAnchorElement, event: Event) {
        return event?.type === "click"
          ? activate(this, event.bubbles, () => dispatch.call(this, event))
          : dispatch.call(this, event);
      },
    });
    Object.defineProperty(prototype, "click", {
      configurable: true,
      writable: true,
      value: function (this: HTMLAnchorElement) {
        return activate(this, true, () => click.call(this));
      },
    });
    addEventListener.call(
      win,
      "click",
      (event: Event) => {
        const target = event.target as Element | null;
        const anchor =
          target?.nodeType === 1
            ? (closest.call(target, "a[download]") as HTMLAnchorElement | null)
            : null;
        if (!anchor || event.defaultPrevented) return;
        // Install during capture so this bubble listener follows the website's
        // existing handlers. Its restoration waits until after native default action.
        const stopTarget = lastListener(anchor, anchor);
        const stopWindow = lastListener(win, anchor);
        host.setTimeout(() => {
          stopTarget();
          stopWindow();
        }, 0);
      },
      true,
    );
  };
}
