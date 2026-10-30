/** One authoritative assignment coordinator per trusted runtime scope.
 * Every startup still validates/probes through the real coordinator. Tabs only
 * subscribe to its result; closing one tab must not close another tab's relay,
 * BroadcastChannel, renewal timer or owner. No state crosses Window/scope keys. */
import { createFrontendAssignmentCoordinator } from './frontend-assignment.ts';

type Options = Parameters<typeof createFrontendAssignmentCoordinator>[0];
type Coordinator = ReturnType<typeof createFrontendAssignmentCoordinator>;
type Assignment = Parameters<NonNullable<Options['onAssignment']>>[0];
type Subscriber = { live: boolean; started: boolean; seen: boolean; stateSeen: boolean; options: Options };
type Pool = { master: Coordinator; subscribers: Set<Subscriber>; live: boolean; latest?: Assignment; startup?: Promise<NonNullable<Coordinator['current']>> };
const windows = new WeakMap<object, WeakMap<object, Map<string, Pool>>>();
const stopped = () => Object.assign(Error('Frontend coordinator lease stopped'), { code: 'FRONTEND_COORDINATOR_STOPPED', retryable: false });

export function acquireSharedAssignmentCoordinator(
  owner: object, scope: object, options: Options,
  create: typeof createFrontendAssignmentCoordinator = createFrontendAssignmentCoordinator,
): Coordinator {
  let scopes = windows.get(owner);
  if (!scopes) { scopes = new WeakMap(); windows.set(owner, scopes); }
  let assets = scopes.get(scope);
  if (!assets) { assets = new Map(); scopes.set(scope, assets); }
  const key = String(options.workerURL);
  let pool = assets.get(key);
  const deliver = (subscriber: Subscriber, event: Assignment) => {
    if (!subscriber.live || !subscriber.started) return;
    const first = !subscriber.seen;
    subscriber.seen = true;
    try { subscriber.options.onAssignment?.(first ? { ...event, previous: null, reason: 'startup', identityChanged: true } : event); } catch { /* A subscriber cannot break its siblings. */ }
  };
  if (!pool) {
    const next = { live: true, subscribers: new Set<Subscriber>() } as Pool;
    next.master = create({
      ...options,
      onAssignment(event) {
        if (!next.live) return;
        next.latest = event;
        for (const subscriber of next.subscribers) deliver(subscriber, event);
      },
      onState(state) {
        if (!next.live) return;
        for (const subscriber of next.subscribers) if (subscriber.live && subscriber.started) {
          subscriber.stateSeen = true;
          try { subscriber.options.onState?.(state); } catch { /* Independent observers. */ }
        }
      },
    });
    assets.set(key, next); pool = next;
  }
  const current = pool;
  const subscriber: Subscriber = { live: true, started: false, seen: false, stateSeen: false, options };
  current.subscribers.add(subscriber);
  const check = () => { if (!subscriber.live || !current.live) throw stopped(); };
  const invoke = async <T>(action: () => Promise<T>) => { check(); const result = await action(); check(); return result; };
  return {
    async start() {
      check(); subscriber.started = true;
      if (!current.startup) {
        const flight = Promise.resolve().then(() => current.master.start());
        current.startup = flight;
        const clear = () => { if (current.startup === flight) current.startup = undefined; };
        void flight.then(clear, clear);
      }
      const assignment = await invoke(() => current.startup!);
      if (!subscriber.stateSeen) {
        subscriber.stateSeen = true;
        try { subscriber.options.onState?.(current.master.state); } catch {}
      }
      if (!subscriber.seen) deliver(subscriber, { assignment, previous: null, reason: 'startup', identityChanged: true });
      return assignment;
    },
    check: input => invoke(() => current.master.check(input)),
    selectNode: (id, csrf) => invoke(() => current.master.selectNode(id, csrf)),
    reconnect: () => invoke(() => current.master.reconnect()),
    transport: {
      request: (...args) => invoke(() => current.master.transport.request(...args)),
      connectWebSocket(...args) { check(); return current.master.transport.connectWebSocket(...args); },
      get assignment() { check(); return current.master.transport.assignment; },
    },
    get current() { return subscriber.live ? current.master.current : null; },
    get state() { return subscriber.live ? current.master.state : { status: 'invalid' as const, code: 'FRONTEND_COORDINATOR_STOPPED' }; },
    stop() {
      if (!subscriber.live) return;
      subscriber.live = false; current.subscribers.delete(subscriber);
      if (current.subscribers.size) return;
      current.live = false;
      if (assets!.get(key) === current) assets!.delete(key);
      current.master.stop();
    },
  };
}
