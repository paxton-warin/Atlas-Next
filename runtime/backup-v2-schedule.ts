/** Scheduling noise is derived only from an existing random replica identity,
 * origin and durable cycle. It is not an ownership/receipt or hardware identity. */
export function deterministicBackupDelay(
  replicaId: string,
  origin: string,
  cycle: number,
  retryBaseMs?: number,
) {
  let hash = 2166136261;
  for (const ch of replicaId + "\0" + origin + "\0" + Math.floor(cycle))
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const sample = hash / 0xffffffff;
  if (retryBaseMs === undefined) return 55000 + Math.floor(sample * 10001);
  const base = Math.min(900000, Math.max(60000, retryBaseMs));
  return Math.min(
    900000,
    Math.round(base + sample * Math.min(base * 0.25, 900000 - base)),
  );
}
