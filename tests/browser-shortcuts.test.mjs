import test from "node:test";
import assert from "node:assert/strict";
import {
  isSearchShortcut,
  searchShortcutLabel,
} from "../runtime/browser-shortcuts.ts";
test("search shortcut uses platform labels and accepts Cmd/Ctrl without stealing modified or composed keys", () => {
  for (const platform of ["MacIntel", "iPad", "iPhone"])
    assert.equal(searchShortcutLabel({ platform }), "Cmd + K");
  for (const platform of ["Win32", "Linux x86_64", "CrOS", ""])
    assert.equal(searchShortcutLabel({ platform }), "Ctrl + K");
  const event = {
    key: "k",
    code: "KeyK",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
  };
  for (const modifier of ["metaKey", "ctrlKey"]) {
    assert.equal(isSearchShortcut({ ...event, [modifier]: true }), true);
    assert.equal(
      isSearchShortcut({ ...event, key: "K", [modifier]: true }),
      true,
    );
    for (const excluded of ["shiftKey", "altKey", "isComposing"])
      assert.equal(
        isSearchShortcut({ ...event, [modifier]: true, [excluded]: true }),
        false,
      );
  }
  assert.equal(isSearchShortcut(event), false);
});
