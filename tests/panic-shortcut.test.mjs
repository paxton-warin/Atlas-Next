import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShortcut,
  captureShortcut,
  matchesShortcut,
  formatShortcut,
  shortcutWarnings,
} from "../runtime/panic-shortcut.ts";
test("panic shortcuts normalize legacy keys and modifier aliases", () => {
  for (const [input, expected] of [
    ["cmd + esc", "Meta+Escape"],
    ["ctrl + shift + J", "Ctrl+Shift+j"],
    ["Option+Command+Escape", "Meta+Alt+Escape"],
    ["F8", "F8"],
    ["I", "i"],
    [" ", "Space"],
    ["+", "Plus"],
  ])
    assert.equal(normalizeShortcut(input), expected);
  for (const value of [
    null,
    {},
    "Ctrl",
    "Ctrl+Ctrl+t",
    "t+Ctrl",
    "Ctrl+fake",
    "a".repeat(100),
  ])
    assert.equal(normalizeShortcut(value), "");
  assert.equal(formatShortcut("Meta+Escape"), "Cmd + Esc");
});
test("panic matching requires exactly the configured modifiers and ignores held/IME keys", () => {
  assert.ok(matchesShortcut({ key: "Escape", metaKey: true }, "Meta+Escape"));
  assert.equal(matchesShortcut({ key: "Escape" }, "Meta+Escape"), false);
  assert.equal(
    matchesShortcut(
      { key: "Escape", metaKey: true, shiftKey: true },
      "Meta+Escape",
    ),
    false,
  );
  assert.equal(matchesShortcut({ key: "j", ctrlKey: true }, "j"), false);
  assert.ok(
    matchesShortcut(
      { key: "J", ctrlKey: true, shiftKey: true },
      "Ctrl+Shift+j",
    ),
  );
  for (const event of [
    { key: "j", repeat: true },
    { key: "j", isComposing: true },
    { key: "Dead" },
    { key: "Control" },
    { key: "j", getModifierState: () => true },
  ])
    assert.equal(captureShortcut(event), "");
  assert.equal(
    captureShortcut({ key: "∆", code: "KeyJ", altKey: true }),
    "Alt+j",
  );
});
test("easy keys and known browser shortcuts get actionable, platform-specific reasons", () => {
  for (const key of ["i", "j", "Space", "Enter", "Escape", "Shift+j"])
    assert.match(shortcutWarnings(key).join(" "), /accidentally/);
  for (const key of ["Meta+t", "Meta+f", "Ctrl+t", "Ctrl+f"])
    assert.match(shortcutWarnings(key).join(" "), /before Atlas receives/);
  assert.match(shortcutWarnings("Meta+t")[0], /new browser tab.*macOS/);
  assert.match(shortcutWarnings("Ctrl+f")[0], /Find on page.*ChromeOS/);
  assert.match(shortcutWarnings("Meta+Alt+Escape")[0], /Force Quit/);
  assert.deepEqual(shortcutWarnings("Meta+Escape"), []);
  assert.deepEqual(shortcutWarnings("F8"), []);
});
