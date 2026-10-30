import { createStorageLocalReceiptWriter } from "./storage-local-receipt.ts";
import { createCookieLocalReceiptWriter } from "./cookie-local-receipt.ts";
let cleanup: () => void = () => {};
self.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type === "dispose") {
    cleanup();
    self.close();
    return;
  }
  if (event.data?.type !== "probe") return;
  const scope = self as any,
    documentId = event.data.documentId;
  const storage = createStorageLocalReceiptWriter(scope, documentId, {
      localOnly: true,
    }),
    cookies = createCookieLocalReceiptWriter(scope, documentId);
  cleanup = () => {
    storage?.dispose();
    cookies?.dispose();
  };
  if (!storage || !cookies) {
    cleanup();
    self.postMessage({ ok: false });
    return;
  }
  storage.write(0, { ok: true });
  self.postMessage({
    ok: true,
    storage: storage.grant,
    cookies: cookies.grant,
  });
});
