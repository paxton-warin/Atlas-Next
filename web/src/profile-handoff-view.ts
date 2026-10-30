import { hubSiteGroup } from "../../runtime/hub-contracts.ts";
import type { ProfileStatus } from "./profile-client";

/** Ordinary local/pending/synced updates belong to the saves indicator, which
 * has its own subscription. The shell needs them only during an ownership
 * handoff; don't reconcile every tab and menu on each website storage write. */
export function sameShellHandoff(previous: ProfileStatus, next: ProfileStatus): boolean {
  return previous === next || (!previous.handoff && !next.handoff && !previous.canContinue && !next.canContinue);
}

export type ProfileHandoffView = {
  kind: "offered" | "waiting" | "releasing" | "paused";
  title: string;
  message: string;
  busy: boolean;
  canContinue: boolean;
  canRetry: boolean;
  canUseBackup: boolean;
  backupPending: boolean;
};

/** Ownership is website-group scoped. An unrelated page keeps its normal UI. */
export function profileHandoffForWebsite(
  status: ProfileStatus,
  website: string | undefined,
): ProfileHandoffView | null {
  if (!website) return null;
  try {
    const group = hubSiteGroup(new URL(website).origin);
    const handoff = status.handoff ?? (
      status.canContinue && status.origin
        ? { phase: "offered" as const, siteGroup: hubSiteGroup(status.origin) }
        : undefined
    );
    if (!handoff || handoff.siteGroup !== group) return null;
    switch (handoff.phase) {
      case "offered": return {
        kind: "offered",
        title: "Continue this website here?",
        message: status.handoff?.phase === "offered" &&
          ["conflict", "error", "offline"].includes(status.state) &&
          status.message !== "This website is open in another browser."
            ? status.message
            : "This website is open in another browser. Its latest saves will finish before it opens here.",
        busy: false,
        canContinue: true,
        canRetry: false,
        canUseBackup: false,
        backupPending: false,
      };
      case "waiting": {
        const backupPending = handoff.backupPending === true;
        const failed = !backupPending && !!handoff.error;
        return {
          kind: "waiting",
          title: backupPending
            ? "Opening saved version…"
            : failed ? "Saved version could not open" : "Finishing your saves…",
          message: backupPending
            ? "Opening this website with uploaded data, if available."
            : failed ? handoff.error!
            : "Keep your other browser open. This website will open here when its saves are ready.",
          busy: !failed,
          canContinue: false,
          canRetry: false,
          canUseBackup: handoff.canUseBackup === true && !backupPending,
          backupPending,
        };
      }
      case "releasing": {
        // Unrelated preference/ad uploads have their own global save status.
        // Only an actual failure of this group may interrupt its handoff UI.
        const failed = !!handoff.error;
        return {
          kind: "releasing",
          title: failed ? "Your saves need attention" : "Finishing your saves…",
          message: failed
            ? handoff.error!
            : "This website is moving to your other browser. Keep this browser open while its latest saves finish.",
          busy: !failed,
          canContinue: false,
          canRetry: failed,
          canUseBackup: false,
          backupPending: false,
        };
      }
      case "paused": return {
        kind: "paused",
        title: "Open in your other browser",
        message: "This website continued there. Continue here to bring it back with your latest saves.",
        busy: false,
        canContinue: true,
        canRetry: false,
        canUseBackup: false,
        backupPending: false,
      };
    }
  } catch {
    // Invalid, local-game and internal addresses do not select a website owner.
  }
  return null;
}

/** A background/embedded website cannot present a takeover for the active page.
 * Keep the actual global save state; only the unrelated ownership label is hidden. */
export function profileStatusForWebsite(
  status: ProfileStatus,
  website: string | undefined,
): ProfileStatus {
  return status.handoff && !profileHandoffForWebsite(status, website)
    ? { ...status, handoff: undefined }
    : status;
}

/** A tab badge describes ownership without rewriting its operational status. */
export function profileHandoffTabLabel(view: ProfileHandoffView): string {
  if (view.backupPending) return "Opening";
  if (view.canRetry) return "Retry";
  if (view.busy) return "Saving";
  if (view.kind === "waiting") return view.canUseBackup ? "Retry" : "Waiting";
  return view.kind === "paused" ? "Paused" : "Continue";
}
