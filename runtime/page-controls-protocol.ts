/** Bounded presentation/diagnostic data only. This is not a networking, storage,
 * navigation, renderer-source or general script-execution capability. */
export type PageCommand =
  | { type: "compatibility-config"; metadata: boolean; diagnostics: boolean }
  | { type: "compatibility-export" };
export type PageTelemetry =
  | { type: "title"; title: string }
  | {
      type: "compatibility-status";
      origin: string;
      rule: string;
      applied: number;
      risk: boolean;
      throttled: boolean;
    }
  | {
      type: "compatibility-diagnostics";
      report: {
        version: 1;
        active: boolean;
        entries: Record<string, unknown>[];
      };
    };
const exact = (value: any, keys: string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export function cleanPageCommand(value: any): PageCommand | undefined {
  if (value?.type === "compatibility-export" && exact(value, ["type"]))
    return { type: value.type };
  if (
    value?.type === "compatibility-config" &&
    exact(value, ["type", "metadata", "diagnostics"]) &&
    typeof value.metadata === "boolean" &&
    typeof value.diagnostics === "boolean"
  )
    return {
      type: value.type,
      metadata: value.metadata,
      diagnostics: value.diagnostics,
    };
}
export function cleanPageTelemetry(
  value: any,
  logicalOrigin: string,
): PageTelemetry | undefined {
  if (
    value?.type === "title" &&
    exact(value, ["type", "title"]) &&
    typeof value.title === "string" &&
    value.title.length <= 160
  )
    return {
      type: value.type,
      title: value.title.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160),
    };
  if (
    value?.type === "compatibility-status" &&
    exact(value, ["type", "origin", "rule", "applied", "risk", "throttled"]) &&
    value.origin === logicalOrigin &&
    ["game-metadata-v1", "fixture-metadata-v1", "runtime-only-v1"].includes(
      value.rule,
    ) &&
    Number.isInteger(value.applied) &&
    value.applied >= 0 &&
    value.applied <= 128 &&
    typeof value.risk === "boolean" &&
    typeof value.throttled === "boolean"
  )
    return {
      type: value.type,
      origin: logicalOrigin,
      rule: value.rule,
      applied: value.applied,
      risk: value.risk,
      throttled: value.throttled,
    };
  // Child export is an acknowledgement only. The frontend replaces this with
  // its own trusted-network diagnostic log, never child-selected text/URLs.
  if (
    value?.type === "compatibility-diagnostics" &&
    exact(value, ["type", "report"]) &&
    exact(value.report, ["version", "active", "entries"]) &&
    value.report.version === 1 &&
    typeof value.report.active === "boolean" &&
    Array.isArray(value.report.entries) &&
    value.report.entries.length === 0
  )
    return {
      type: value.type,
      report: { version: 1, active: value.report.active, entries: [] },
    };
}
