import type { BackupV2Status } from "./backup-v2-service.ts";

const quietReasons = new Set([
  "BACKUP_FOREGROUND_BUSY",
  "BACKUP_SOURCE_BUSY",
  "BACKUP_CAPTURE_BUSY",
  "BACKUP_READ_DEADLINE",
  "BACKUP_SEAL_DEADLINE",
  "BACKUP_SEAL_INTERRUPTED",
  "BACKUP_CAPTURE_CHANGED",
  "BACKUP_DISCOVERY_DEADLINE",
  "BACKUP_DISCOVERY_INTERRUPTED",
]);
const queuedReasons = new Set([
  "BACKUP_VISIT_YIELDED",
  "BACKUP_CATALOG_PENDING",
  "BACKUP_SPOOL_PRESSURE",
  "BACKUP_SPOOL_EVICTED",
  "BACKUP_VALIDATING",
  "BACKUP_BUSY",
]);
const queued = (error: { code?: string; message?: string } | undefined) =>
  !!error &&
  (queuedReasons.has(error.code ?? "") ||
    (error.code === "BACKUP_CYCLE_BUDGET" &&
      !/namespace needs|exceeds the automatic|prepared upload exceeds/i.test(
        error.message ?? "",
      )));

export function backupPopupError(
  error: unknown,
  fallback = "Backup unavailable. Try again.",
) {
  const e = error as {
    code?: string;
    message?: string;
    status?: number;
    name?: string;
  };
  if (
    e?.name === "QuotaExceededError" &&
    e.status !== 413 &&
    !/QUOTA|ADMISSION|BACKPRESSURE/.test(e.code ?? "")
  )
    return "Browser storage is full. Contact support.";
  if (e?.code === "BACKUP_CATALOG_FULL")
    return "Some websites have reached the backup limit. Contact support.";
  if (e?.code === "BACKUP_NAMESPACE_BUDGET")
    return "Some saves exceed the automatic backup limit.";
  if (e?.code === "BACKUP_UPGRADE_REQUIRED")
    return "Atlas has updated. Reload to load this backup.";
  if (queuedReasons.has(e?.code ?? ""))
    return e?.code === "BACKUP_BUSY"
      ? "Backups are busy. This one will retry."
      : "More saves are waiting for the next backup cycle.";
  if (e?.code === "BACKUP_LOCAL_ACTOR_BUSY")
    return "Another backup is running. This one will retry.";
  if (quietReasons.has(e?.code ?? ""))
    return "Waiting for a quiet moment to back up.";
  if (e?.code === "BACKUP_SOURCE_MISSING")
    return "Waiting for this website’s saves.";
  if (e?.code === "BACKUP_COORDINATION_UNAVAILABLE")
    return "Waiting to start the backup.";
  if (e?.code === "BACKUP_RECORD_UNSIZED")
    return "Some saves aren’t ready for automatic backup.";
  if (
    ["BACKUP_RECORD_UNSUPPORTED", "BACKUP_RECORD_ACCESSOR"].includes(
      e?.code ?? "",
    )
  )
    return "Some saves aren’t supported by automatic backup.";
  if (e?.code === "BACKUP_RECORD_SHAPE")
    return "Some saves are too complex to back up automatically.";
  if (
    [
      "BACKUP_RECORD_TOO_LARGE",
      "BACKUP_KEY_TOO_LARGE",
      "BACKUP_RECORD_OVERSIZED",
    ].includes(e?.code ?? "")
  )
    return "Some saves are too large to back up. Contact support.";
  if (e?.code === "BACKUP_CYCLE_BUDGET") {
    if (
      /namespace needs|exceeds the automatic|prepared upload exceeds/i.test(
        e?.message ?? "",
      )
    )
      return "Some saves exceed the automatic backup limit.";
    return "More saves are waiting for the next backup cycle.";
  }
  const text = [
    e?.code,
    e?.message,
    typeof error === "string" ? error : "",
  ].join(" ");
  if (
    e?.status === 401 ||
    e?.status === 403 ||
    /AUTH|SESSION_EXPIRED|sign[ -]?in/i.test(text)
  )
    return "Sign in again to back up your saves.";
  if (/oversiz|too large|record.{0,12}limit/i.test(text))
    return "Some saves are too large to back up. Contact support.";
  if (/quota|allowance|storage.{0,12}full/i.test(text))
    return "Backup storage is full. Contact support.";
  if (/conflict|parent.{0,12}changed/i.test(text))
    return "Backup paused. Try again or contact support.";
  return fallback;
}

export function backupPopupView(backup: BackupV2Status) {
  const confirmed =
    backup.state === "idle" &&
    !!backup.lastCompleted &&
    !backup.deferred.length &&
    !backup.lastIssue;
  const onlyQueued =
    backup.deferred.length > 0 &&
    backup.deferred.every(queued) &&
    (!backup.lastIssue || queued(backup.lastIssue));
  const summary =
    onlyQueued || (!backup.deferred.length && queued(backup.lastIssue))
      ? "Backup pending"
      : backup.deferred.length
        ? "Backup incomplete"
        : confirmed
          ? "Backed up"
          : backup.state === "idle"
            ? "No backup yet"
            : backup.state === "pending"
              ? "Backup pending"
              : ["preparing", "uploading", "publishing"].includes(backup.state)
                ? "Backing up…"
                : backup.state === "offline"
                  ? "Backup unavailable"
                  : backup.state === "deferred"
                    ? "Backup incomplete"
                    : "Backup needs attention";
  const first = backup.deferred[0];
  const current = backup.lastIssue;
  const globalFailure =
    current &&
    (["offline", "conflict", "error"].includes(current.kind) ||
      current.status === 413 ||
      /QUOTA|ADMISSION|BACKPRESSURE/.test(current.code ?? ""));
  const issue = globalFailure
    ? backupPopupError(current)
    : first
      ? backupPopupError(first, "Some saves need attention. Contact support.")
      : ["offline", "conflict", "error", "deferred"].includes(backup.state)
        ? backupPopupError(
            backup.lastIssue ?? backup.message,
            backup.state === "deferred"
              ? "Backup deferred. Try again."
              : "Backup unavailable. Try again.",
          )
        : "";
  return {
    label: confirmed ? "Saved locally · backed up" : "Saved locally",
    summary,
    issue,
  };
}
