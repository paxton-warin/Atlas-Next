/** Website-side popup seam. Browser popup blocking remains synchronous: only a
 * pre-reserved opaque document is passed to the captured native window.open. */
export function createOpaquePopupClient(options: {
  window: Window & typeof globalThis;
  documentId: string;
  frontend: string;
  documentURL: string;
  open: typeof window.open;
  active: () => boolean;
  send: (message: object, transfer?: Transferable[]) => void;
  registerWindow(target: Window, origin: string | null, popupId?: string): void;
  navigate(url: string): void;
}) {
  const pool = new Map<string, string>(),
    opened = new Map<string, { window: Window; origin: string }>();
  const current = new Map<Window, string>();
  let live = true;
  const open = (url?: string | URL, target = "_blank", features = "") => {
    if (!live || !options.active()) return null;
    const destination = new URL(String(url ?? ""), options.documentURL);
    if (
      !/^https?:$/.test(destination.protocol) ||
      destination.username ||
      destination.password
    )
      throw new DOMException(
        "Popup URL is not supported.",
        "NotSupportedError",
      );
    if (target === "_self") {
      options.navigate(destination.href);
      return options.window;
    }
    if (
      ["_parent", "_top"].includes(target) ||
      String(target).length > 128 ||
      String(features).length > 512 ||
      /(?:^|,)\s*(?:noopener|noreferrer)(?:\s*=|\s*,|\s*$)/i.test(features)
    )
      throw new DOMException(
        "This popup target is not qualified.",
        "NotSupportedError",
      );
    const reserved = pool.entries().next().value;
    if (!reserved) return null;
    const [documentId, physical] = reserved;
    pool.delete(documentId);
    const popup = options.open(physical, target, features);
    if (!popup) {
      options.send({
        protocol: 2,
        documentId: options.documentId,
        type: "popup-cancel",
        popupId: documentId,
      });
      return null;
    }
    opened.set(documentId, { window: popup, origin: destination.origin });
    current.set(popup, documentId);
    options.registerWindow(popup, destination.origin, documentId);
    options.send({
      protocol: 2,
      documentId: options.documentId,
      type: "popup-open",
      popupId: documentId,
      url: destination.href,
    });
    return popup;
  };
  return {
    open,
    sourceWindow: (id: string) => opened.get(id)?.window,
    receive(message: any) {
      if (!live) return false;
      if (message.type === "popup-pool") {
        if (!Array.isArray(message.entries) || message.entries.length > 4)
          return true;
        pool.clear();
        for (const entry of message.entries) {
          try {
            const u = new URL(entry.url);
            if (
              !/^doc_[a-f0-9]{32}$/.test(entry.documentId) ||
              u.origin !== options.frontend ||
              u.pathname !== "/browse/popup/" + entry.documentId ||
              u.search ||
              u.hash ||
              u.username ||
              u.password
            )
              continue;
            pool.set(entry.documentId, u.href);
          } catch {}
        }
        return true;
      }
      if (message.type === "popup-state") {
        const record = opened.get(message.popupId);
        if (!record) return true;
        if (current.get(record.window) !== message.popupId) {
          opened.delete(message.popupId);
          return true;
        }
        if (message.phase === "ready" && typeof message.origin === "string")
          options.registerWindow(
            record.window,
            message.origin,
            message.popupId,
          );
        if (message.phase === "closed" || message.phase === "error") {
          opened.delete(message.popupId);
          current.delete(record.window);
          options.registerWindow(record.window, null);
        }
        return true;
      }
      return false;
    },
    dispose() {
      live = false;
      pool.clear();
      for (const r of opened.values()) options.registerWindow(r.window, null);
      opened.clear();
    },
  };
}
