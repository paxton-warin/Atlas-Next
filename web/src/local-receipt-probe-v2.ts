import { createStorageLocalReceiptReader } from "../../runtime/storage-local-receipt.ts";
import {
  createCookieLocalReceiptReader,
  COOKIE_LOCAL_RECEIPT_PROBE,
} from "../../runtime/cookie-local-receipt.ts";
/** Complete worker-write/window-read test BEFORE any legacy copy or local bind. */
export function probeLocalReceiptsV2(
  options: { worker?: () => Worker; host?: Window & typeof globalThis } = {},
) {
  const host = options.host ?? window,
    worker =
      options.worker?.() ??
      new Worker(
        new URL("../../runtime/receipt-probe-worker-v2.ts", import.meta.url),
        { type: "module", name: "atlas-local-receipt-probe" },
      );
  const documentId = "probe_" + host.crypto.randomUUID().replaceAll("-", "");
  return new Promise<void>((resolve, reject) => {
    const timer = host.setTimeout(
      () =>
        finish(
          new DOMException(
            "Local storage capability probe timed out; existing data is retained",
            "NotSupportedError",
          ),
        ),
      5000,
    );
    function finish(error?: Error) {
      host.clearTimeout(timer);
      worker.postMessage({ type: "dispose" });
      host.setTimeout(() => worker.terminate(), 100);
      error ? reject(error) : resolve();
    }
    worker.onerror = () =>
      finish(
        new DOMException(
          "Local storage receipt worker failed",
          "NotSupportedError",
        ),
      );
    worker.onmessage = ({ data }) => {
      const storage = createStorageLocalReceiptReader({
        host,
        documentId,
        grant: data?.storage,
      });
      const cookies = createCookieLocalReceiptReader({
        host,
        documentId,
        grant: data?.cookies,
      });
      const ok =
        data?.ok &&
        storage?.read(0)?.ok === true &&
        cookies?.read(0) === COOKIE_LOCAL_RECEIPT_PROBE;
      storage?.dispose();
      cookies?.dispose();
      finish(
        ok
          ? undefined
          : new DOMException(
              "This browser does not support durable local receipts; original data is retained",
              "NotSupportedError",
            ),
      );
    };
    worker.postMessage({ type: "probe", documentId });
  });
}
