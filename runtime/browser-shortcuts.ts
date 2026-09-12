type Platform = {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
};
export function searchShortcutLabel(platform: Platform = navigator): string {
  return /Mac|iPhone|iPad|iPod/i.test(
    platform.userAgentData?.platform ||
      platform.platform ||
      platform.userAgent ||
      "",
  )
    ? "Cmd + K"
    : "Ctrl + K";
}
export function isSearchShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "code"
    | "ctrlKey"
    | "metaKey"
    | "altKey"
    | "shiftKey"
    | "isComposing"
  >,
): boolean {
  return (
    !event.isComposing &&
    !event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey) &&
    (event.key.toLowerCase() === "k" || event.code === "KeyK")
  );
}
