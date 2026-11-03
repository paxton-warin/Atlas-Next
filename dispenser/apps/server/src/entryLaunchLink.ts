import { AppError } from "./errors.js";

export type EntryLaunchLink = {
  url: string;
  hubEnabled: boolean;
  browserEnabled: boolean;
};

export const DEFAULT_ENTRY_LAUNCH_LINK: Readonly<EntryLaunchLink> =
  Object.freeze({
    url: "https://docs.google.com/document/d/1YcSpjvV7n1VJRXPRu-2k8CW2r-CDv9QEGToRxkTfwxY/edit?tab=t.0",
    hubEnabled: false,
    browserEnabled: false,
  });

/** This URL is navigated by the browser, never fetched by the Hub server. */
export function validateEntryLaunchLink(raw: unknown): EntryLaunchLink {
  const invalid = () =>
    new AppError(
      "VALIDATION_ERROR",
      "Enter an HTTP or HTTPS launch URL (up to 2048 characters) and select the Hub and browser options.",
    );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const input = raw as Record<string, unknown>;
  const fields = ["url", "hubEnabled", "browserEnabled"];
  if (
    Object.keys(input).length !== fields.length ||
    Object.keys(input).some((key) => !fields.includes(key)) ||
    typeof input.url !== "string" ||
    typeof input.hubEnabled !== "boolean" ||
    typeof input.browserEnabled !== "boolean"
  )
    throw invalid();
  const text = input.url.trim();
  if (!text || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text))
    throw invalid();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid();
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.href.length > 2048
  )
    throw invalid();
  return {
    url: url.href,
    hubEnabled: input.hubEnabled,
    browserEnabled: input.browserEnabled,
  };
}

/** Missing or malformed stored settings fail closed, including both switches. */
export function entryLaunchLinkOrDefault(raw: unknown): EntryLaunchLink {
  try {
    return validateEntryLaunchLink(raw);
  } catch {
    return { ...DEFAULT_ENTRY_LAUNCH_LINK };
  }
}
