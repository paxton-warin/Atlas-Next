/** Native namespace identities only. No replication journal, lease or codec. */
export const PROFILE_IDB_KEEP = "__atlas_idb_keepalive_v2__";
export function checkedProfile(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new TypeError("Invalid profile identity");
  return value;
}
export function profileDatabaseName(base: string, id?: string | null) {
  return checkedProfile(id) ? base + ":profile:" + id : base;
}
export function profileIDBPrefix(origin: string, id?: string | null) {
  return (
    "atlas.browsing.idb.v2:" +
    (checkedProfile(id) ? "profile:" + id + ":" : "") +
    encodeURIComponent(new URL(origin).origin) +
    ":"
  );
}
