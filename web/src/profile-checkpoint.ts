import { hubSiteGroup } from "../../runtime/hub-contracts.ts";
import type {
  ProfileCheckpointCandidate,
  ProfileCheckpointRequest,
} from "../../runtime/website-checkpoint.ts";

/** One native save per logical origin. A hidden stale tab must not overwrite the
 * foreground game's live state just because it registered its listener later. */
export function selectProfileCheckpoints(
  siteGroup: string,
  candidates: ProfileCheckpointCandidate[],
): ProfileCheckpointCandidate[] {
  const selected = new Map<string, ProfileCheckpointCandidate>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.checkpoint !== "function" ||
        typeof candidate.visible !== "boolean" || !Number.isFinite(candidate.lastActiveAt)) continue;
    let origin: string;
    try {
      const url = new URL(candidate.origin);
      if (!/^https?:$/.test(url.protocol) || url.origin !== candidate.origin ||
          url.username || url.password || hubSiteGroup(url.origin) !== siteGroup) continue;
      origin = url.origin;
    } catch { continue; }
    const prior = selected.get(origin);
    if (!prior || Number(candidate.visible) > Number(prior.visible) ||
        (candidate.visible === prior.visible && candidate.lastActiveAt > prior.lastActiveAt))
      selected.set(origin, candidate);
  }
  return [...selected.values()];
}

/** Registered controllers invoke only supported site-owned persistence methods.
 * This barrier runs before teardown/fencing; the durable journal/cloud ACK
 * barriers still run afterwards. A timeout is a failed save, never permission
 * to release ownership. Unknown sites keep committed-data-only semantics. */
export async function checkpointProfileGroup(siteGroup: string): Promise<void> {
  const detail: ProfileCheckpointRequest = { siteGroup, candidates: [] };
  window.dispatchEvent(new CustomEvent("atlas:profile-checkpoint", { detail }));
  const selected = selectProfileCheckpoints(siteGroup, detail.candidates);
  if (!selected.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(selected.map(candidate => Promise.resolve().then(() => candidate.checkpoint()))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(
          new Error("This website has not finished saving. Try the transfer again."),
          { code: "PROFILE_CHECKPOINT_TIMEOUT" },
        )), 5500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
