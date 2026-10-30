import type { ProfileStatus } from "./profile-client";

/** Internal state codes remain available to diagnostics, not as instructions
 * that an ordinary user is expected to understand or fix by deleting data. */
export function profileStatusMessage(message: string): string {
  if (/PROFILE_(?:REVISION_CONFLICT|RECOVERY_REQUIRED|RESTORE_REQUIRED|REPAIR_REQUIRED)/.test(message))
    return "Some website saves need attention. Your stored changes remain on this device. Repair sync backs them up before opening the latest Hub save.";
  if (message.includes("Portable graph exceeds allowance"))
    return "Atlas could not finish this website's backup because it exceeded a recovery limit. Your stored changes remain on this device. Do not clear Atlas's browser data.";
  return message;
}

export function profileSyncRepairAvailable(status: ProfileStatus): boolean {
  return ["conflict", "error"].includes(status.state) && !status.canContinue && !status.handoff &&
    /PROFILE_(?:REVISION_CONFLICT|RECOVERY_REQUIRED|RESTORE_REQUIRED|REPAIR_REQUIRED)/.test(status.message);
}

/** Copy follows actual durable-local/cloud state; a pending upload is not synced. */
export function profileStatusLabel(status: Pick<ProfileStatus, "state" | "message" | "handoff">): string {
  if (status.handoff?.phase === "releasing")
    return status.handoff.error ? "Sync issue" : "Finishing saves…";
  if (status.handoff?.phase === "waiting")
    return status.handoff.backupPending ? "Opening saved version…"
      : status.handoff.error ? "Save issue" : "Finishing saves…";
  if (status.handoff?.phase === "paused") return "Open elsewhere";
  if (status.handoff?.phase === "offered") return "Continue here";
  if (status.message.startsWith("Portable saves")) return "Partial backup";
  switch (status.state) {
    case "synced": return "Synced";
    case "restoring": return "Restoring…";
    case "pending": return "Sync pending";
    case "conflict": return "Needs attention";
    case "error": return "Sync issue";
    case "offline": return "Saved locally · offline";
    default: return "Saved locally";
  }
}
