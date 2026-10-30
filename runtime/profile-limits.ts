/** Trusted manifest policy only. Neither opaque document messages nor storage
 * records select these limits. A profile switch resets all previous policy. */
import { checkedProfile } from "./profile-journal.ts";
export type ProfileLimits = { localBytes: number; idbBytes: number };
export const DEFAULT_PROFILE_LIMITS: Readonly<ProfileLimits> = Object.freeze({
  localBytes: 5 * 1024 * 1024,
  idbBytes: 64 * 1024 * 1024,
});
let active: { profileId: string; limits: Readonly<ProfileLimits> } | undefined;
export function setProfileLimits(
  profileId: string | null,
  limits?: ProfileLimits,
) {
  if (profileId === null) {
    active = undefined;
    return;
  }
  checkedProfile(profileId);
  const policy = limits ?? DEFAULT_PROFILE_LIMITS;
  if (
    !Number.isSafeInteger(policy.localBytes) ||
    policy.localBytes < 64 * 1024 ||
    policy.localBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(policy.idbBytes) ||
    policy.idbBytes < 1024 * 1024 ||
    policy.idbBytes > 1024 * 1024 * 1024
  )
    throw new TypeError("Invalid trusted website storage policy");
  active = {
    profileId,
    limits: Object.freeze({
      localBytes: policy.localBytes,
      idbBytes: policy.idbBytes,
    }),
  };
}
export function getProfileLimits(
  profileId: string | null | undefined,
): Readonly<ProfileLimits> {
  return profileId && active?.profileId === profileId
    ? active.limits
    : DEFAULT_PROFILE_LIMITS;
}
