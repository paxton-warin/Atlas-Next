/** Browser-local authority. This capability deliberately has no cloud lease,
 * quota, online status, publication token or wall-clock expiry. */
export type LocalActorAuthority = Readonly<{
  version: 2;
  profileId: string;
  replicaId: string;
  localAuthGeneration: string;
  browserSessionId: string;
}>;
export type LocalBindingAuthority = LocalActorAuthority &
  Readonly<{
    documentId: string;
    logicalOrigin: string;
  }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{16,128}$/;
const denied = () =>
  new DOMException(
    "Local storage authorization is no longer current",
    "SecurityError",
  );
export function checkedLocalActorAuthority(
  value: unknown,
): LocalActorAuthority {
  const v = value as Partial<LocalActorAuthority> | null;
  if (
    !v ||
    v.version !== 2 ||
    !uuid.test(v.profileId || "") ||
    !uuid.test(v.replicaId || "") ||
    v.replicaId === v.profileId ||
    !opaque.test(v.localAuthGeneration || "") ||
    !opaque.test(v.browserSessionId || "")
  )
    throw denied();
  return Object.freeze({
    version: 2,
    profileId: v.profileId!,
    replicaId: v.replicaId!,
    localAuthGeneration: v.localAuthGeneration!,
    browserSessionId: v.browserSessionId!,
  });
}
export function sameLocalActorAuthority(
  a: LocalActorAuthority | null | undefined,
  b: LocalActorAuthority | null | undefined,
) {
  return (
    !!a &&
    !!b &&
    a.version === 2 &&
    b.version === 2 &&
    a.profileId === b.profileId &&
    a.replicaId === b.replicaId &&
    a.localAuthGeneration === b.localAuthGeneration &&
    a.browserSessionId === b.browserSessionId
  );
}
export function checkedLocalBindingAuthority(
  value: unknown,
  current: LocalActorAuthority,
  documentId: string,
  website: string,
): LocalBindingAuthority {
  const actor = checkedLocalActorAuthority(value),
    v = value as LocalBindingAuthority;
  const url = new URL(website);
  if (
    !sameLocalActorAuthority(actor, current) ||
    !opaque.test(documentId) ||
    v.documentId !== documentId ||
    v.logicalOrigin !== url.origin ||
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password
  )
    throw denied();
  return Object.freeze({ ...actor, documentId, logicalOrigin: url.origin });
}
export function assertLocalBindingAuthority(
  binding: LocalBindingAuthority,
  current: LocalActorAuthority | null | undefined,
) {
  if (!sameLocalActorAuthority(binding, current)) throw denied();
}
/** Compare-and-set cleanup: delayed logout for an old generation cannot revoke
 * an account/replica installed by a newer login. */
export function revokeLocalAuthority(
  current: LocalActorAuthority | null,
  expectedGeneration: string,
): LocalActorAuthority | null {
  return current?.localAuthGeneration === expectedGeneration ? null : current;
}
