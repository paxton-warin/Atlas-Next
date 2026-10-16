import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNativeSrcset,
  serializeNativeSrcset,
} from "../runtime/native-srcset.ts";
test("srcset preserves native candidate descriptors, sizes-independent URL ordering and data commas", () => {
  for (const [source, expected] of [
    [
      "a.png 1x, b.png 2x",
      [
        { url: "a.png", descriptor: "1x" },
        { url: "b.png", descriptor: "2x" },
      ],
    ],
    [
      "a.png 320w, b.png 640w",
      [
        { url: "a.png", descriptor: "320w" },
        { url: "b.png", descriptor: "640w" },
      ],
    ],
    [
      "data:image/png;base64,AAAA 1x, b.png 2x",
      [
        { url: "data:image/png;base64,AAAA", descriptor: "1x" },
        { url: "b.png", descriptor: "2x" },
      ],
    ],
    [
      "a.png, b.png 2x",
      [
        { url: "a.png", descriptor: "" },
        { url: "b.png", descriptor: "2x" },
      ],
    ],
  ]) {
    assert.deepEqual(parseNativeSrcset(source), expected);
    assert.deepEqual(
      parseNativeSrcset(serializeNativeSrcset(expected)),
      expected,
    );
  }
});
test("malformed, ambiguous, unsupported and over-budget srcsets do not become guessed fetches", () => {
  for (const value of [
    ",a.png",
    "a.png 1x, b.png 1.0x",
    "a.png 320w, b.png 2x",
    "a.png 0x",
    "a.png -1x",
    "a.png 1h",
    "a.png 1x 2x",
    "a.png calc(1)",
    "a.png 1x,, b.png 2x",
    "x".repeat(65537),
  ])
    assert.throws(() => parseNativeSrcset(value), {
      name: "NotSupportedError",
    });
  assert.throws(() =>
    parseNativeSrcset(
      Array.from({ length: 65 }, (_, i) => `i${i}.png ${i + 1}w`).join(", "),
    ),
  );
});
