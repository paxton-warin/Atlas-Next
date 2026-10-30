/** Native per-tab UI draft state is account/replica scoped by its caller. It is
 * not a cloud acknowledgement or the canonical conversation archive. */
export type AiComposerState = { version: 1; selected: string; draft: string };
const empty = (): AiComposerState => ({ version: 1, selected: "", draft: "" });
export function readAiComposerState(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
): AiComposerState {
  try {
    const value = JSON.parse(
      (storage ?? sessionStorage).getItem(key) || "null",
    );
    return value?.version === 1 &&
      typeof value.selected === "string" &&
      value.selected.length <= 1024 &&
      typeof value.draft === "string" &&
      value.draft.length <= 12000
      ? value
      : empty();
  } catch {
    return empty();
  }
}
export function saveAiComposerState(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  key: string,
  value: AiComposerState,
): boolean {
  if (
    value.version !== 1 ||
    typeof value.selected !== "string" ||
    value.selected.length > 1024 ||
    typeof value.draft !== "string" ||
    value.draft.length > 12000
  )
    return false;
  try {
    const encoded = JSON.stringify(value),
      native = storage ?? sessionStorage;
    if (native.getItem(key) !== encoded) native.setItem(key, encoded);
    return true;
  } catch {
    return false;
  }
}
