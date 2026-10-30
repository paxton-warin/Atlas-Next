import test from "node:test";
import assert from "node:assert/strict";
import {
  setProfileLimits,
  getProfileLimits,
  DEFAULT_PROFILE_LIMITS,
} from "../runtime/profile-limits.ts";
const first = "00000000-0000-0000-0000-000000000001",
  second = "00000000-0000-0000-0000-000000000002";
test("trusted profile policy is bounded, immutable and never inherited by another account", () => {
  setProfileLimits(null);
  assert.deepEqual(getProfileLimits(first), {
    localBytes: 5 * 1024 * 1024,
    idbBytes: 64 * 1024 * 1024,
  });
  const input = { localBytes: 64 * 1024, idbBytes: 1024 * 1024 };
  setProfileLimits(first, input);
  input.localBytes = 1;
  assert.equal(getProfileLimits(first).localBytes, 64 * 1024);
  assert.ok(Object.isFrozen(getProfileLimits(first)));
  assert.equal(getProfileLimits(second), DEFAULT_PROFILE_LIMITS);
  setProfileLimits(second, {
    localBytes: 32 * 1024 * 1024,
    idbBytes: 1024 * 1024 * 1024,
  });
  assert.equal(getProfileLimits(first), DEFAULT_PROFILE_LIMITS);
  setProfileLimits(null);
  assert.equal(getProfileLimits(second), DEFAULT_PROFILE_LIMITS);
});
test("invalid policy cannot replace a valid account limit", () => {
  setProfileLimits(first, { localBytes: 65536, idbBytes: 1048576 });
  for (const patch of [
    { localBytes: 1 },
    { idbBytes: 0 },
    { localBytes: 33554433 },
    { idbBytes: 1073741825 },
    { localBytes: NaN },
  ])
    assert.throws(
      () =>
        setProfileLimits(first, {
          localBytes: 65536,
          idbBytes: 1048576,
          ...patch,
        }),
      TypeError,
    );
  assert.deepEqual(getProfileLimits(first), {
    localBytes: 65536,
    idbBytes: 1048576,
  });
  assert.throws(
    () =>
      setProfileLimits("website-controlled-id", {
        localBytes: 65536,
        idbBytes: 1048576,
      }),
    TypeError,
  );
  setProfileLimits(null);
});
