/** Profile IDB for the normal Scramjet worker loader. The normal engine still
 * constructs, rewrites and executes workers; this adds only the existing
 * profile transaction/journal connection, before original worker code runs. */
import { createSandboxIndexedDB, installSandboxIndexedDB } from "./sandbox-idb.ts";
import { compilerBindingClassic, compilerBindingImport, installWorkerFunctionBindings } from "./worker-compiler-bindings.ts";

const PROTOCOL = "atlas-scramjet-profile-worker-v1";
const CONFIG = "atlas.scramjet.profile.worker.config.v1";
const BOOT = "atlas.scramjet.profile.worker.boot.v1";
const IMPORT = "atlas.scramjet.profile.worker.import.v1";
type Owner = any;
type BoundIDB = { port: MessagePort; dispose(): void };
export type ScramjetProfileWorkerBridge = {
  profileId?: string | null;
  profileContextId?: string;
  bindWorkerIndexedDB(input: { documentId: string; website: string }): Promise<BoundIDB>;
};
type WorkerClient = {
  url: { href: string };
  context?: { prefix?: { href?: string; pathname?: string } };
  restoreurl?(url: string): string;
  unrewriteUrl?(url: string): string;
  natives?: { store?: Record<string, any> };
};

function natives(owner: Owner, client?: WorkerClient) {
  const store = client?.natives?.store ?? {};
  return {
    MessagePort: owner.MessagePort,
    DOMException: owner.DOMException ?? DOMException,
    add: store["EventTarget.prototype.addEventListener"] ?? EventTarget.prototype.addEventListener,
    remove: store["EventTarget.prototype.removeEventListener"] ?? EventTarget.prototype.removeEventListener,
    post: store["MessagePort.prototype.postMessage"] ?? MessagePort.prototype.postMessage,
    workerPost: store["Worker.prototype.postMessage"] ?? owner.Worker?.prototype.postMessage,
    selfPost: store["self.postMessage"] ?? owner.postMessage,
    start: store["MessagePort.prototype.start"] ?? MessagePort.prototype.start,
    close: store["MessagePort.prototype.close"] ?? MessagePort.prototype.close,
    data: Object.getOwnPropertyDescriptor(owner.MessageEvent.prototype, "data")!.get!,
  };
}
function logicalWorkerURL(value: unknown, client: WorkerClient) {
  let url = String(value);
  try { url = (client.restoreurl ?? client.unrewriteUrl)?.call(client, url) ?? url; } catch {}
  const resolved = new URL(url, client.url.href);
  // Native Blob/data workers inherit their creator's logical storage origin.
  return /^(?:blob|data):$/.test(resolved.protocol) ? client.url.href : resolved.href;
}
function scopeName(bridge: Pick<ScramjetProfileWorkerBridge, "profileId" | "profileContextId">) {
  return JSON.stringify([bridge.profileId ?? null, bridge.profileContextId ?? null]);
}

/** Works with the pin's normal script callback for both classic and module
 * workers. No async wrapper changes lexical bindings, import order or globals. */
export function installScramjetProfileWorkerInjection(
  frame: any,
  workerURL: string,
  bridge: Pick<ScramjetProfileWorkerBridge, "profileId" | "profileContextId"> = {},
) {
  const iface = frame.fetchHandler.context.interface;
  const original = iface.getWorkerInjectScripts;
  if (typeof original !== "function") throw new TypeError("Normal worker injection is missing");
  const wrapped = function (this: unknown, meta: any, module: boolean, script: (url: string) => string) {
    const emitted: string[] = [];
    const existing = original.call(this, meta, module, (url: string) => {
      const source = /\/runtimekit(?:-normal)?\.js$/.test(url) ? url.replace(/runtimekit(?:-normal)?\.js$/, "runtimekit-worker.js") : url;
      const result = script(source); emitted.push(result); return result;
    });
    // The shipped minified pin omits its final return although upstream has it.
    // Preserve its emitted scripts rather than producing an "undefined" prefix.
    const prefix = typeof existing === "string" ? existing : emitted.join("");
    const config = `self[Symbol.for(${JSON.stringify(CONFIG)})]=${JSON.stringify({
      profileId: bridge.profileId ?? null,
      profileContextId: bridge.profileContextId,
    })};`;
    if (module)
      return prefix + script("data:text/javascript;charset=utf-8," + encodeURIComponent(config)) + script(workerURL) + compilerBindingImport;
    // Stock client.hook() rewrites later global importScripts calls. Capture
    // the native entry first so this frontend-owned asset is not fetched as a
    // logical website URL. Original worker source remains an ordinary script.
    const key = `Symbol.for(${JSON.stringify(IMPORT)})`;
    return `self[${key}]=importScripts;\n` + prefix + config + `self[${key}].call(self,${JSON.stringify(workerURL)});delete self[${key}];\n` + compilerBindingClassic;
  };
  iface.getWorkerInjectScripts = wrapped;
  return { dispose() { if (iface.getWorkerInjectScripts === wrapped) iface.getWorkerInjectScripts = original; } };
}

/** Wrap already-hooked normal constructors, retaining their prototype/static
 * properties and source rewriting. Shared workers use their native connect
 * port, not the dedicated worker's global message channel. */
export function installScramjetProfileWorkerConstructors(
  owner: Owner,
  client: WorkerClient,
  bridge: ScramjetProfileWorkerBridge,
) {
  const native = natives(owner, client), restore: (() => void)[] = [], records = new Set<any>();
  let live = true;
  const post = (port: MessagePort, message: any, ports: MessagePort[] = []) =>
    Reflect.apply(native.post, port, [message, ports]);
  for (const kind of ["Worker", "SharedWorker"] as const) {
    const previous = owner[kind];
    if (typeof previous !== "function") continue;
    const wrapped = new Proxy(previous, {
      construct(target, originalArgs, newTarget) {
        const args = [...originalArgs], website = logicalWorkerURL(args[0], client);
        if (kind === "SharedWorker") {
          const supplied = args[1];
          // A shared realm must not retain another signed-in profile's IDB port.
          const prefix = "atlas-profile:" + scopeName(bridge) + ":";
          args[1] = typeof supplied === "string" ? prefix + supplied
            : { ...(supplied ?? {}), name: prefix + (supplied?.name ?? "") };
        }
        const worker: any = Reflect.construct(target, args, newTarget);
        const endpoint = kind === "SharedWorker" ? worker.port : worker;
        const record: any = { worker, endpoint, shared: kind === "SharedWorker", binding: null, services: [], live: true };
        records.add(record);
        const send = (message: any, ports: MessagePort[] = []) => {
          if (record.shared) post(endpoint, message, ports);
          else Reflect.apply(native.workerPost ?? worker.postMessage, worker, [message, ports]);
        };
        const bind = async (input: { documentId: string; website: string }) => {
          const binding = await bridge.bindWorkerIndexedDB(input);
          if ((!live || !record.live) && !record.shared) { binding.dispose(); throw new native.DOMException("Worker owner closed", "AbortError"); }
          return binding;
        };
        const service = (port: MessagePort) => {
          const bindings = new Set<BoundIDB>();
          const receive = async (event: MessageEvent) => {
            const message = Reflect.apply(native.data, event, []);
            if (message?.protocol !== PROTOCOL || message.type !== "bind-idb") return;
            try {
              const bound = await bind({ documentId: message.documentId, website: message.website });
              bindings.add(bound);
              post(port, { protocol: PROTOCOL, type: "idb-bound", requestId: message.requestId }, [bound.port]);
            } catch (error) {
              post(port, { protocol: PROTOCOL, type: "idb-error", requestId: message.requestId, name: (error as Error).name });
            }
          };
          Reflect.apply(native.add, port, ["message", receive]);
          Reflect.apply(native.start, port, []);
          record.services.push(() => {
            for (const bound of bindings) bound.dispose();
            Reflect.apply(native.remove, port, ["message", receive]);
            Reflect.apply(native.close, port, []);
          });
        };
        const receive = async (event: MessageEvent) => {
          const message = Reflect.apply(native.data, event, []);
          if (message?.protocol !== PROTOCOL) return;
          if (message.type !== "ready" && message.type !== "declined" && message.type !== "closed") return;
          event.stopImmediatePropagation();
          if (message.type === "declined" || message.type === "closed") {
            if (message.type === "closed" && !record.shared) { record.dispose(); return; }
            record.binding?.dispose(); record.binding = null;
            for (const dispose of record.services.splice(0)) dispose();
            return;
          }
          if (record.binding || !record.live) return;
          try {
            const bound = await bind({ documentId: message.documentId, website });
            record.binding = bound;
            const channel = new owner.MessageChannel(); service(channel.port1);
            send({ protocol: PROTOCOL, type: "bind", documentId: message.documentId }, [bound.port, channel.port2]);
          } catch (error) {
            send({ protocol: PROTOCOL, type: "bind-error", name: (error as Error).name });
          }
        };
        Reflect.apply(native.add, endpoint, ["message", receive, true]);
        if (record.shared) Reflect.apply(native.start, endpoint, []);
        record.dispose = () => {
          // Dedicated workers die with their document. Shared-worker bindings
          // remain owned by the profile bridge until profile/context disposal.
          if (record.shared) return;
          if (!record.live) return;
          record.live = false;
          records.delete(record);
          Reflect.apply(native.remove, endpoint, ["message", receive, true]);
          record.binding?.dispose(); record.binding = null;
          for (const dispose of record.services.splice(0)) dispose();
        };
        if (!record.shared && typeof worker.terminate === "function") {
          const terminate = worker.terminate;
          Object.defineProperty(worker, "terminate", { configurable: true, writable: true, value: function () {
            record.dispose(); return Reflect.apply(terminate, this, []);
          } });
        }
        return worker;
      },
    });
    Object.defineProperty(owner, kind, { configurable: true, writable: true, value: wrapped });
    restore.push(() => { if (owner[kind] === wrapped) owner[kind] = previous; });
  }
  return {
    // Trusted lifecycle counters, never a website capability or worker value.
    get activeDedicatedWorkers() {
      let count = 0;
      for (const record of records) if (!record.shared && record.live) count++;
      return count;
    },
    dispose() { live = false; for (const record of records) record.dispose(); records.clear(); for (const fn of restore) fn(); },
  };
}

/** Runs synchronously after stock client.hook(), before original worker code.
 * IDB requests are asynchronous already: their native MessageChannel queues
 * until the profile owner sends the original bound backend port. */
export function installScramjetProfileWorkerBootstrap(owner: Owner, client?: WorkerClient) {
  if (owner[Symbol.for(BOOT)]) return owner[Symbol.for(BOOT)];
  const native = natives(owner, client), channel = new owner.MessageChannel();
  const documentId = "worker_" + owner.crypto.randomUUID().replaceAll("-", "");
  const facade = createSandboxIndexedDB(channel.port1, documentId, native);
  installSandboxIndexedDB(owner, facade);
  let upstream: MessagePort | undefined, remote: MessagePort | undefined, next = 0;
  const queued: any[] = [], waiting: any[] = [], pending = new Map<number, any>();
  const config = owner[Symbol.for(CONFIG)] ?? {};
  const post = (port: MessagePort, message: any, ports: MessagePort[] = []) => Reflect.apply(native.post, port, [message, ports]);
  const listen = (target: EventTarget, listener: (event: MessageEvent) => void) => {
    Reflect.apply(native.add, target, ["message", listener, true]);
    if (target instanceof native.MessagePort) Reflect.apply(native.start, target, []);
  };
  listen(channel.port2, (event) => {
    const value = Reflect.apply(native.data, event, []);
    if (remote) post(remote, value); else queued.push(value);
  });
  const remoteBind = (input: { documentId: string; website: string }): Promise<BoundIDB> => new Promise((resolve, reject) => {
    const requestId = ++next;
    pending.set(requestId, { resolve, reject });
    const message = { protocol: PROTOCOL, type: "bind-idb", requestId, ...input };
    if (upstream) post(upstream, message); else waiting.push(message);
  });
  let constructors: ReturnType<typeof installScramjetProfileWorkerConstructors> | undefined;
  const workerClient = client ?? { url: { href: owner.location.href } };
  constructors = installScramjetProfileWorkerConstructors(owner, workerClient, { ...config, bindWorkerIndexedDB: remoteBind });
  const receive = (endpoint: any, dedicated: boolean) => {
    const send = (message: any) => dedicated ? Reflect.apply(native.selfPost, owner, [message]) : post(endpoint, message);
    listen(endpoint, (event) => {
      const message = Reflect.apply(native.data, event, []);
      if (message?.protocol !== PROTOCOL || !["bind", "bind-error"].includes(message.type)) return;
      event.stopImmediatePropagation();
      if (message.type === "bind-error") { facade.dispose(); return; }
      if (remote) {
        for (const port of event.ports) Reflect.apply(native.close, port, []);
        send({ protocol: PROTOCOL, type: "declined" }); return;
      }
      if (message.documentId !== documentId || event.ports.length !== 2) return;
      const remotePort = event.ports[0], upstreamPort = event.ports[1];
      remote = remotePort; upstream = upstreamPort;
      listen(remotePort, (reply) => post(channel.port2, Reflect.apply(native.data, reply, [])));
      listen(upstreamPort, (reply) => {
        const value = Reflect.apply(native.data, reply, []), record = pending.get(value?.requestId);
        if (!record || value.protocol !== PROTOCOL) return;
        pending.delete(value.requestId);
        if (value.type === "idb-bound" && reply.ports.length === 1) record.resolve({ port: reply.ports[0], dispose() { Reflect.apply(native.close, reply.ports[0], []); } });
        else record.reject(new native.DOMException("Profile worker binding failed", value.name || "InvalidStateError"));
      });
      for (const value of queued.splice(0)) post(remotePort, value);
      for (const value of waiting.splice(0)) post(upstreamPort, value);
    });
    send({ protocol: PROTOCOL, type: "ready", documentId });
  };
  if (typeof owner.postMessage === "function") receive(owner, true);
  else Reflect.apply(native.add, owner, ["connect", (event: MessageEvent) => { for (const port of event.ports) receive(port, false); }, true]);
  const result = { documentId, dispose() {
    facade.dispose(); constructors?.dispose();
    for (const record of pending.values()) record.reject(new native.DOMException("Worker closed", "AbortError"));
    pending.clear();
    for (const port of [channel.port1, channel.port2, remote, upstream]) if (port) Reflect.apply(native.close, port, []);
  } };
  owner[Symbol.for(BOOT)] = result;
  return result;
}

// The ?worker&url build is also valid as a module-worker dependency. A normal
// Window/Node import only exposes helpers and never changes its IndexedDB.
if (typeof self !== "undefined" && typeof document === "undefined" && typeof (globalThis as any).WorkerGlobalScope !== "undefined") {
  const owner = self as any;
  const core = owner.$runtimekit;
  if (core) installWorkerFunctionBindings(owner, core, owner[core.RUNTIMEKITCLIENT]);
  installScramjetProfileWorkerBootstrap(owner, core ? owner[core.RUNTIMEKITCLIENT] : undefined);
}
