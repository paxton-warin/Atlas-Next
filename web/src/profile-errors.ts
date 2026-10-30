/** Only availability failures allow an already-owned local replica to continue.
 * Authorization, ownership and revision conflicts never grant offline authority. */
export function temporaryProfileFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; status?: number; name?: string };
  // Worker memory/queue admission is temporary availability, not exhausted
  // persistent website storage. Retain the journal and retry with backoff.
  if (e.code === "PROFILE_LOCAL_BACKPRESSURE") return true;
  if (
    e.code &&
    /CONTEXT|WRITER|REVOK|AUTH|CONFLICT|RECOVERY|QUOTA/.test(e.code)
  )
    return false;
  if (typeof e.status === "number")
    return [408, 425, 429].includes(e.status) || e.status >= 500;
  return ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(
    e.name || "",
  );
}
