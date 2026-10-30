import { test } from "node:test";
import assert from "node:assert/strict";
import { temporaryProfileFailure } from "../web/src/profile-errors.ts";
test("only availability failures allow retained local profile ownership", () => {
  for (const error of [
    new TypeError("Failed to fetch"),
    { name: "TimeoutError" },
    { status: 429 },
    { status: 503, code: "HUB_UNAVAILABLE" },
  ])
    assert.equal(temporaryProfileFailure(error), true);
  for (const error of [
    { status: 401 },
    { status: 403 },
    { status: 409, code: "HUB_WRITER_BUSY" },
    { code: "HUB_WRITER_LOST", status: 503 },
    { code: "PROFILE_CONTEXT_CHANGED" },
    { code: "HUB_QUOTA", status: 503 },
    new Error("Revision conflict"),
  ])
    assert.equal(temporaryProfileFailure(error), false);
});

test("bounded local worker admission backs off instead of permanently pausing storage sync", () => {
  assert.equal(temporaryProfileFailure({ name: "QuotaExceededError", code: "PROFILE_LOCAL_BACKPRESSURE" }), true);
  assert.equal(temporaryProfileFailure({ name: "QuotaExceededError", code: "HUB_PROFILE_QUOTA" }), false);
});
