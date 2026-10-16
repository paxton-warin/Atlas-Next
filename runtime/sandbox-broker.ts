import {
  logicalStorageOrigin,
  type SandboxVault,
  type StorageChange,
} from "./sandbox-vault.ts";

export const SANDBOX_PROTOCOL = 2;
const MAX_PENDING = 128;
const MAX_QUEUED_BYTES = 10 * 1024 * 1024;
export type BrokerBinding = {
  documentId: string;
  website: string;
  frontendOrigin: string;
  port: MessagePort;
  vault: Pick<SandboxVault, "snapshot" | "write">;
};

/** The parent chooses the site identity. No request may supply an origin,
 * storage namespace, database name, relay ticket, or another document's ID.
 * This prototype deliberately exposes only acknowledged storage operations;
 * a general website network/IDB runtime is not yet registered here.
 */
export function bindSandboxDocument(binding: BrokerBinding) {
  const origin = logicalStorageOrigin(binding.website);
  if (new URL(origin).hostname === new URL(binding.frontendOrigin).hostname)
    throw new TypeError("Frontend resources are not website capabilities.");
  const { port, documentId, vault } = binding;
  let live = true,
    next = 1;
  let pending = 0,
    queuedBytes = 0;
  let tail = Promise.resolve();
  const reply = (value: object) => {
    if (live)
      port.postMessage({ protocol: SANDBOX_PROTOCOL, documentId, ...value });
  };
  const receive = (event: MessageEvent) => {
    const message = event.data;
    if (
      !live ||
      !message ||
      message.protocol !== SANDBOX_PROTOCOL ||
      message.documentId !== documentId ||
      message.sequence !== next ||
      !["snapshot", "mutate", "flush"].includes(message.type) ||
      Object.keys(message).some(
        (key) =>
          !["protocol", "documentId", "sequence", "type", "change"].includes(
            key,
          ),
      )
    ) {
      reply({ type: "error", code: "invalid_capability_message" });
      return;
    }
    const sequence = next++;
    let bytes = 0;
    const change = message.change as StorageChange;
    if (message.type === "mutate") {
      if (
        !change ||
        typeof change !== "object" ||
        Object.keys(change).some(
          (key) => !["op", "key", "value"].includes(key),
        ) ||
        !["set", "remove", "clear"].includes(change.op) ||
        (change.op !== "clear" && typeof change.key !== "string") ||
        (change.op === "set" && typeof change.value !== "string") ||
        (change.op === "clear" &&
          Object.keys(change).some((key) => key !== "op")) ||
        (change.op === "remove" &&
          Object.keys(change).some((key) => !["op", "key"].includes(key)))
      ) {
        reply({ type: "error", sequence, code: "invalid_storage_operation" });
        return;
      }
      bytes =
        change.op === "clear"
          ? 0
          : 2 *
            (change.key.length +
              (change.op === "set" ? change.value.length : 0));
    } else if (message.change !== undefined) {
      reply({ type: "error", sequence, code: "invalid_storage_operation" });
      return;
    }
    if (pending >= MAX_PENDING || bytes + queuedBytes > MAX_QUEUED_BYTES) {
      reply({ type: "error", sequence, code: "storage_backpressure" });
      return;
    }
    pending++;
    queuedBytes += bytes;
    tail = tail.then(async () => {
      try {
        if (!live) return;
        let snapshot;
        if (message.type === "snapshot")
          snapshot = await vault.snapshot(origin);
        else if (message.type === "mutate") {
          snapshot = await vault.write(origin, change);
        }
        reply({ type: "ack", sequence, snapshot });
      } catch (error) {
        reply({
          type: "error",
          sequence,
          code: (error as Error).name || "storage_failed",
        });
      } finally {
        pending--;
        queuedBytes -= bytes;
      }
    });
  };
  port.addEventListener("message", receive);
  port.start();
  return {
    // Trusted-owner drain of ALREADY RECEIVED work only. A wire-level flush
    // request must be sent by the document and its ack awaited before navigation.
    // Neither operation gives synchronous localStorage durability on hard reload.
    async flush() {
      await tail;
    },
    get pending() {
      return pending;
    },
    dispose() {
      live = false;
      port.removeEventListener("message", receive);
      port.close();
    },
  };
}
