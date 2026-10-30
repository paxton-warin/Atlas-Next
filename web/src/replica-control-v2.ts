import type { ReplicaCatalogEntry } from "../../runtime/replica-catalog-v2.ts";
export function createReplicaControlV2(
  options: {
    createWorker?: () => Worker;
    timeoutMs?: number;
    nativeOnly?: boolean;
  } = {},
) {
  const protocol = "atlas-replica-control-v2";
  const worker =
    options.createWorker?.() ??
    (options.nativeOnly
      ? new Worker(
          new URL(
            "../../runtime/replica-native-control-worker-v2.ts",
            import.meta.url,
          ),
          { type: "module", name: "atlas-native-replica-catalog-v2" },
        )
      : new Worker(
          new URL(
            "../../runtime/replica-control-worker-v2.ts",
            import.meta.url,
          ),
          { type: "module", name: "atlas-replica-catalog-v2" },
        ));
  const pending = new Map<
    number,
    {
      resolve(v: any): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let id = 0,
    live = true;
  const dispose = () => {
    if (!live) return;
    live = false;
    worker.terminate();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("LOCAL_CONTROL_STOPPED"));
    }
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    if (data?.protocol !== protocol) return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    clearTimeout(p.timer);
    if (data.ok) p.resolve(data.value);
    else
      p.reject(
        Object.assign(
          new Error(data.error?.message || "Local catalog failed"),
          { name: data.error?.name },
        ),
      );
  };
  worker.onerror = dispose;
  worker.onmessageerror = dispose;
  const call = (operation: string, args: unknown) => {
    if (!live || pending.size >= 64)
      return Promise.reject(new Error("LOCAL_CONTROL_UNAVAILABLE"));
    return new Promise<any>((resolve, reject) => {
      const serial = ++id,
        timer = setTimeout(() => {
          pending.delete(serial);
          reject(new Error("LOCAL_CONTROL_TIMEOUT"));
        }, options.timeoutMs ?? 30000);
      pending.set(serial, { resolve, reject, timer });
      worker.postMessage({ protocol, id: serial, operation, args });
    });
  };
  return {
    dispose,
    initialize: (
      profileId: string,
      selection?: string,
      nativeOnly = options.nativeOnly === true,
    ) =>
      call("initialize", { profileId, selection, nativeOnly }) as Promise<{
        account: ReplicaCatalogEntry;
        legacy: boolean;
      }>,
    prepareSite: (origin: string) =>
      call("prepare-site", { origin }) as Promise<{
        mode: "local-v2" | "legacy";
        cookieLocal?: boolean;
        origin: string;
        reason?: string;
      }>,
    publishRestore: (
      replicaId: string,
      incarnation: string,
      checkpointId: string,
      deferredPreferences: string[] = [],
      legacyOrigins: string[] = [],
      activate = false,
    ) =>
      call("publish-restore", {
        replicaId,
        incarnation,
        checkpointId,
        deferredPreferences,
        legacyOrigins,
        activate,
      }) as Promise<ReplicaCatalogEntry>,
    cloudEmpty: (legacyOrigins: string[] = []) =>
      call("cloud-empty", { legacyOrigins }) as Promise<ReplicaCatalogEntry>,
    cloudUnavailable: () =>
      call("cloud-unavailable", {}) as Promise<ReplicaCatalogEntry>,
  };
}
