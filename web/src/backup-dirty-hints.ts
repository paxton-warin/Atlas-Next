/** Tiny UI-side hint coalescer. It never retains website values or starts I/O.
 * The backup worker validates/normalizes origins and owns the durable queue. */
export type BackupDirtyHint = {
  kind?: "local" | "cookies" | "idb" | "atlas";
  origin?: string;
  logicalOrigin?: string;
};
export function createBackupDirtyHints(limit = 64) {
  const entries = new Map<string, BackupDirtyHint>();
  let all = false;
  return {
    add(value: unknown) {
      if (all) return;
      const v = value as BackupDirtyHint | undefined;
      if (!v || typeof v !== "object") {
        all = true;
        entries.clear();
        return;
      }
      const kind =
        v.kind ?? (typeof v.logicalOrigin === "string" ? "idb" : undefined);
      const origin = v.origin ?? v.logicalOrigin;
      if (kind === "atlas") {
        if (!entries.has("atlas") && entries.size >= limit) {
          all = true;
          entries.clear();
          return;
        }
        entries.set("atlas", { kind: "atlas" });
        return;
      }
      if (
        !["local", "cookies", "idb"].includes(String(kind)) ||
        typeof origin !== "string" ||
        origin.length > 2048
      ) {
        all = true;
        entries.clear();
        return;
      }
      const key = JSON.stringify([kind, origin]);
      if (!entries.has(key) && entries.size >= limit) {
        all = true;
        entries.clear();
        return;
      }
      entries.set(key, { kind: kind as BackupDirtyHint["kind"], origin });
    },
    take(): BackupDirtyHint[] | undefined {
      const result = all ? undefined : [...entries.values()];
      all = false;
      entries.clear();
      return result;
    },
    get pending() {
      return all || entries.size > 0;
    },
  };
}
