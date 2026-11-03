import { afterEach, expect, it, vi } from "vitest";
import { subscribeSupportLive } from "./hubSupportLive";
class FakeEvents extends EventTarget {
  static all: FakeEvents[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    super();
    FakeEvents.all.push(this);
  }
  close() {
    this.closed = true;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  FakeEvents.all = [];
});
it("uses only the cookie-authorized fixed SSE path, invalidates on ready/change/reconnect errors, cleans up", () => {
  vi.stubGlobal("EventSource", FakeEvents);
  const changed = vi.fn(),
    stop = subscribeSupportLive(changed),
    stream = FakeEvents.all[0];
  expect(stream.url).toBe("/api/hub/events");
  expect(stream.options).toEqual({ withCredentials: true });
  for (const name of ["ready", "support", "error", "ready"])
    stream.dispatchEvent(new Event(name));
  expect(changed).toHaveBeenCalledTimes(4);
  expect(stream.closed).toBe(false);
  stream.dispatchEvent(new Event("authorization"));
  expect(stream.closed).toBe(true);
  expect(changed).toHaveBeenCalledTimes(5);
  stop();
  expect(stream.closed).toBe(true);
});
it("keeps the polling owner usable when EventSource is absent", () => {
  vi.stubGlobal("EventSource", undefined);
  const changed = vi.fn();
  expect(subscribeSupportLive(changed)).toBeTypeOf("function");
  expect(changed).not.toHaveBeenCalled();
});
it("opens a newly authorized stream on return online and removes its recovery listener", () => {
  const events = new EventTarget();
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  vi.stubGlobal("EventSource", FakeEvents);
  const stop = subscribeSupportLive(vi.fn()),
    old = FakeEvents.all[0];
  events.dispatchEvent(new Event("online"));
  expect(old.closed).toBe(true);
  expect(FakeEvents.all).toHaveLength(2);
  old.dispatchEvent(new Event("authorization"));
  expect(FakeEvents.all[1].closed).toBe(false);
  stop();
  events.dispatchEvent(new Event("online"));
  expect(FakeEvents.all).toHaveLength(2);
  expect(FakeEvents.all[1].closed).toBe(true);
});
