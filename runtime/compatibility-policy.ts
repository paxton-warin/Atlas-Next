// Public client preference: exact origins, never wildcard destinations.
export const SITE_PREFERENCE_KEY = "atlas.site-adjustments.v1";
export const REVIEWED_HOSTS = new Set([
  "poki.com",
  "www.poki.com",
  "crazygames.com",
  "www.crazygames.com",
  "coolmathgames.com",
  "www.coolmathgames.com",
  "y8.com",
  "www.y8.com",
]);
export type SiteModes = Record<string, true>;
export function validRuntimeStatus(value: any): boolean {
  if (
    !value ||
    value.rule !== "opaque-renderer-v14" ||
    !["applied", "error"].includes(value.state) ||
    typeof value.id !== "string" ||
    value.id.length > 100 ||
    !Number.isInteger(value.resources) ||
    value.resources < 0 ||
    value.resources > 3
  )
    return false;
  try {
    const url = new URL(value.origin);
    return /^https?:$/.test(url.protocol) && url.origin === value.origin;
  } catch {
    return false;
  }
}
export function ruleFor(value: string, fixture = false): string | undefined {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
    if (REVIEWED_HOSTS.has(url.hostname)) return "game-metadata-v1";
    if (
      fixture &&
      url.hostname === "127.0.0.1" &&
      url.port === "4199" &&
      url.pathname === "/compatibility-fixture"
    )
      return "fixture-metadata-v1";
  } catch {
    /* Invalid URLs have no rule. */
  }
}
export function sanitizeSiteModes(value: unknown): SiteModes {
  const result: SiteModes = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  for (const [origin, enabled] of Object.entries(value).slice(0, 256)) {
    try {
      const url = new URL(origin);
      if (
        enabled === true &&
        url.origin === origin &&
        /^https?:$/.test(url.protocol) &&
        !url.username &&
        !url.password
      )
        result[origin] = true;
    } catch {
      /* Skip invalid persisted values. */
    }
  }
  return result;
}
export type CompatibilityStatus = {
  id: string;
  origin: string;
  rule: string;
  applied: number;
  risk: boolean;
  throttled: boolean;
};
export function validStatus(value: any): value is CompatibilityStatus {
  return (
    !!value &&
    typeof value.id === "string" &&
    value.id.length <= 100 &&
    typeof value.origin === "string" &&
    value.origin.length <= 512 &&
    ["game-metadata-v1", "fixture-metadata-v1", "runtime-only-v1"].includes(
      value.rule,
    ) &&
    Number.isInteger(value.applied) &&
    value.applied >= 0 &&
    value.applied <= 128 &&
    typeof value.risk === "boolean" &&
    typeof value.throttled === "boolean"
  );
}
