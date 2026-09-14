import test from "node:test";
import assert from "node:assert/strict";
import { youtubeAdSeekTarget } from "../runtime/youtube-player.ts";

test("player completion requires an explicit SSAP AD diagnostic and a finite short ad duration", () => {
  for (const debug_info of [
    "SSAP, AD",
    "SSAP, AD, state=playing",
    "SSAP, AD state=playing",
  ]) {
    assert.equal(
      youtubeAdSeekTarget({ debug_info }, { current: 3, duration: 20 }),
      20,
    );
  }
  for (const stats of [
    null,
    {},
    { debug_info: false },
    { debug_info: "SSAP, VIDEO" },
    { debug_info: "SSAP, ADAPTIVE" },
    { debug_info: "VIDEO, SSAP, AD" },
  ]) {
    assert.equal(
      youtubeAdSeekTarget(stats, { current: 3, duration: 20 }),
      undefined,
    );
  }
  for (const progress of [
    null,
    {},
    { current: 3, duration: Infinity },
    { current: NaN, duration: 20 },
    { current: -1, duration: 20 },
    { current: 0, duration: 0 },
    { current: 2, duration: 601 },
    { current: 20, duration: 20 },
    { current: 30, duration: 20 },
    { current: 19.9, duration: 20 },
    { current: "3", duration: 20 },
    { current: 3, duration: "20" },
  ]) {
    assert.equal(
      youtubeAdSeekTarget({ debug_info: "SSAP, AD" }, progress),
      undefined,
    );
  }
});
