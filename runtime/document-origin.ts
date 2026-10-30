/** Captured trusted document composition, never inferred from website input. */
export type DocumentOrigin = "opaque" | "same-origin";

export function resolveDocumentOrigin(value: unknown = "opaque"): DocumentOrigin {
  if (value !== "opaque" && value !== "same-origin")
    throw new TypeError("Invalid trusted document origin mode");
  return value;
}

export function assertDocumentOrigin(
  owner: { origin: string; location?: { origin: string } },
  value?: DocumentOrigin,
): DocumentOrigin {
  const mode = resolveDocumentOrigin(value);
  if (mode === "opaque") {
    if (owner.origin !== "null")
      throw new TypeError("Opaque document origin required");
  } else {
    const physical = owner.location?.origin;
    if (
      typeof physical !== "string" ||
      physical === "null" ||
      owner.origin !== physical ||
      !/^https?:\/\//.test(physical) ||
      new URL(physical).origin !== physical
    )
      throw new TypeError("Same-origin document must match its physical origin");
  }
  return mode;
}

export function documentContentPolicies(
  mode: DocumentOrigin,
  policies: readonly string[],
): readonly string[] {
  return mode === "same-origin" ? [] : policies;
}
