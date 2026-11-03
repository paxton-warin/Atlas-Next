import { describe, it, expect } from "vitest";
import { createBackupAdmission } from "./hubBackupsV2Admission.js";
const tick = () => new Promise<void>((r) => setImmediate(r));
describe("bounded backup admission without pool growth", () => {
  it("boundsactive2/queued8, rejects excess and drainsFIFO without leaks", async () => {
    const gate = createBackupAdmission(),
      controller = new AbortController();
    const releases: Array<() => void> = [],
      order: number[] = [];
    const jobs = Array.from({ length: 10 }, (_, i) =>
      gate.run("upload", controller.signal, async () => {
        order.push(i);
        await new Promise<void>((r) => releases.push(r));
      }),
    );
    await tick();
    expect(gate.snapshot().active).toBe(2);
    expect(gate.snapshot().queued).toBe(8);
    await expect(
      gate.run("upload", controller.signal, async () => {}),
    ).rejects.toMatchObject({ code: "BACKUP_BUSY", status: 429 });
    for (let at = 0; at < 10; at++) {
      releases[at]();
      await tick();
    }
    await Promise.all(jobs);
    expect(order).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(gate.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      accepted: 10,
      completed: 10,
      rejected: 1,
    });
  });
  it("timesout and cancels queued work without executing it or leaking slots", async () => {
    const gate = createBackupAdmission({ active: 1, queued: 2, waitMs: 20 }),
      controller = new AbortController();
    let release!: () => void,
      entered = 0;
    const running = gate.run("publish", controller.signal, async () => {
      await new Promise<void>((r) => (release = r));
    });
    await tick();
    const a = new AbortController(),
      cancelled = gate.run("publish", a.signal, async () => {
        entered++;
      });
    const cancelAssertion = expect(cancelled).rejects.toMatchObject({
      status: 429,
    });
    a.abort();
    await cancelAssertion;
    await expect(
      gate.run("publish", controller.signal, async () => {
        entered++;
      }),
    ).rejects.toMatchObject({ status: 429 });
    release();
    await running;
    expect(entered).toBe(0);
    expect(gate.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      cancelled: 1,
      rejected: 1,
    });
  });
});
