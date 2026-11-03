import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseCandidate, type Candidate } from "./allocation.js";
const candidate = (
  id: string,
  used: number,
  capacity: number | null,
  weight = 1,
  last: Date | null = null,
): Candidate => ({
  id,
  name: id,
  url: `https://${id}.example`,
  used,
  capacity,
  weight,
  created_at: new Date(0),
  last_assigned_at: last,
});
describe("allocation strategies", () => {
  afterEach(() => vi.restoreAllMocks());
  it("prefers the least utilized links when balancing", () =>
    expect(
      chooseCandidate(
        [candidate("busy", 9, 10), candidate("open", 1, 10)],
        "balanced_random",
      ).id,
    ).toBe("open"));
  it("uses configured weights", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    expect(
      chooseCandidate(
        [candidate("small", 0, null, 1), candidate("large", 0, null, 9)],
        "weighted_random",
      ).id,
    ).toBe("large");
  });
  it("rotates sequentially to the least recently assigned link", () =>
    expect(
      chooseCandidate(
        [
          candidate("recent", 0, null, 1, new Date(200)),
          candidate("old", 0, null, 1, new Date(100)),
        ],
        "sequential",
      ).id,
    ).toBe("old"));
});
