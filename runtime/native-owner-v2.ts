const LOCAL_NATIVE_PROTOCOL = "atlas-local-native-v2";
import {
  type LocalActorAuthority,
  type LocalBindingAuthority,
  checkedLocalActorAuthority,
} from "./local-authority.ts";
import type { SandboxIDBLimits } from "./sandbox-idb.ts";
/** Owns only native execution. Backup actor termination cannot reach this worker. */
export async function createNativeOwnerV2(
  authorityInput: LocalActorAuthority,
  options: {
    createWorker?: () => Worker;
    host?: Window & typeof globalThis;
    timeoutMs?: number;
  } = {},
) {
  const host = options.host ?? window,
    authority = checkedLocalActorAuthority(authorityInput);
  const worker =
    options.createWorker?.() ??
    new Worker(new URL("./local-native-worker.ts", import.meta.url), {
      type: "module",
      name: "atlas-local-native-v2",
    });
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: number }
  >();
  let live = true,
    id = 0;
  function call(
    operation: string,
    values: object = {},
    transfer: Transferable[] = [],
  ) {
    if (!live || pending.size >= 64)
      return Promise.reject(
        new DOMException("Local native actor unavailable", "InvalidStateError"),
      );
    return new Promise<any>((resolve, reject) => {
      const serial = ++id;
      const timer = host.setTimeout(() => {
        pending.delete(serial);
        reject(
          new DOMException(
            "Local native actor timed out; data is retained",
            "TimeoutError",
          ),
        );
      }, options.timeoutMs ?? 10000);
      pending.set(serial, { resolve, reject, timer });
      try {
        worker.postMessage(
          { protocol: LOCAL_NATIVE_PROTOCOL, id: serial, operation, ...values },
          transfer,
        );
      } catch (error) {
        host.clearTimeout(timer);
        pending.delete(serial);
        reject(error);
      }
    });
  }
  const revoke = (event: Event) => {
    if (
      (event as CustomEvent).detail?.generation ===
      authority.localAuthGeneration
    )
      dispose();
  };
  host.addEventListener("atlas:profile-local-revoke", revoke);
  function dispose() {
    if (!live) return;
    live = false;
    host.removeEventListener("atlas:profile-local-revoke", revoke);
    worker.terminate();
    for (const entry of pending.values()) {
      host.clearTimeout(entry.timer);
      entry.reject(
        new DOMException("Local native actor stopped", "InvalidStateError"),
      );
    }
    pending.clear();
  }
  worker.onmessage = ({ data }) => {
    if (!live || data?.protocol !== LOCAL_NATIVE_PROTOCOL) return;
    if (data.type === "dirty") {
      host.dispatchEvent(
        new host.CustomEvent("atlas:profile-native-change", {
          detail: { ...data, profileId: authority.profileId },
        }),
      );
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    host.clearTimeout(entry.timer);
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.value);
    else
      entry.reject(
        Object.assign(new Error(data.error?.message || "Local actor failed"), {
          name: data.error?.name || "Error",
          code: data.error?.code,
        }),
      );
  };
  worker.onerror = dispose;
  worker.onmessageerror = dispose;
  try {
    await call("initialize", { authority });
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    get live() {
      return live;
    },
    dispose,
    async bind(input: {
      documentId: string;
      website: string;
      limits?: Partial<SandboxIDBLimits>;
    }) {
      const channel = new host.MessageChannel();
      const capability: LocalBindingAuthority = {
        ...authority,
        documentId: input.documentId,
        logicalOrigin: new URL(input.website).origin,
      };
      try {
        await call("bind-idb", { ...input, authority: capability }, [
          channel.port1,
        ]);
      } catch (error) {
        channel.port2.close();
        throw error;
      }
      let bound = true;
      return {
        port: channel.port2,
        dispose() {
          if (!bound) return;
          bound = false;
          channel.port2.close();
          void call("unbind", { documentId: input.documentId }).catch(() => {});
        },
      };
    },
    async revoke(expectedAuthGeneration: string) {
      await call("revoke", { expectedAuthGeneration });
    },
  };
}
