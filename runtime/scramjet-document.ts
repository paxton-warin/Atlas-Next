import { createCookieViewClock } from "./cookie-view-cache.ts";
import { createFrameVisibility } from "./frame-visibility.ts";
/** Normal Scramjet controller document. Profiles reuse their existing durable
 * stores; website loading uses the pinned controller/service worker, not the
 * isolated document plan, resource graph or opaque network/worker facades. */
import type { createOpaqueWebsiteDocument } from './sandbox-controller.ts';
import { getActiveProfile, getActiveProfileContext, prepareProfileDocument } from './profile-context.ts';
import { createSandboxStorageFacades, rebindSandboxStorageFacades } from './sandbox-local-storage.ts';
import { createSandboxDocumentCookie } from './sandbox-document-cookie.ts';
import { bindSandboxIndexedDB, createSandboxIndexedDB, installSandboxIndexedDB } from './sandbox-idb.ts';
import { getProfileLimits } from './profile-limits.ts';
import { SCRAMJET_PROFILE_REGISTRY, type ScramjetProfileBridge } from './scramjet-profile.ts';
import type { createSandboxCookieOwner } from './sandbox-cookie-owner.ts';
import type { PageCommand } from './page-controls-protocol.ts';

type Owner = Window & typeof globalThis;
type Base = Parameters<typeof createOpaqueWebsiteDocument>[0];
export type ScramjetRuntimeEvent = {
  type: "popup-created" | "popup-focus" | "popup-closed" | "loading" | "loaded" | "error" | "slow" | "navigation" | "title" | "favicon" | "focus-search" | "panic";
  /** Undefined identifies the owning root page, never another allocation. */
  id?: string;
  openerId?: string;
  url?: string;
  title?: string;
  favicon?: string;
  message?: string;
  code?: string;
  key?: string;
};
type Options = Omit<Base, "cookieProvider"> & {
  cookieProvider: Awaited<ReturnType<typeof createSandboxCookieOwner>>;
  browserSessionId: string;
  localNative?: Awaited<ReturnType<typeof import("./native-owner-v2.ts").createNativeOwnerV2>>;
  runtimeTicket(): Promise<{ runtimeTicket: string; runtimePath: string }>;
  /** Internal DOM adapter seam for focused protocol unit fixtures. */
  createVisibility?: typeof createFrameVisibility;
  onLocation(url: string): void;
  onRuntimeEvent?(event: ScramjetRuntimeEvent): void;
};

export function createScramjetWebsiteDocument(options: Options) {
  const owner = options.container.ownerDocument.defaultView as Owner;
  const profileId = options.profileId ?? getActiveProfile();
  const profileContextId = options.profileContextId ?? getActiveProfileContext();
  if (!profileId || !profileContextId) throw Error('SCRAMJET_PROFILE_NOT_INITIALIZED');
  const documentId = 'doc_' + owner.crypto.randomUUID().replaceAll('-', '');
  const frame = owner.document.createElement('iframe');
  frame.title = 'Atlas browsing runtime';
  frame.allow = 'autoplay; encrypted-media; fullscreen; clipboard-write; camera; microphone; geolocation';
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  let live = true, started = false, loaded = false, website = options.website;
  const managedPages = new Set<string>([documentId]);
  const checkpoints = new Map<string, { resolve(): void; reject(error: Error): void; timer: number }>();
  const resources = new Set<{ dispose(): void }>();
  const visibility = (options.createVisibility ?? createFrameVisibility)(owner, options.container, frame);
  resources.add(visibility);
  let ping: number | undefined;
  let resolve!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void ready.catch(() => {});
  const post = (type: string, values: object = {}) => {
    if (live) frame.contentWindow?.postMessage({ atlas: 1, type, id: documentId, ...values }, owner.location.origin);
  };
  const fail = (error: unknown) => {
    if (!live) return;
    const e = error instanceof Error ? error : new Error(String(error));
    reject(e);
    options.onContentState?.('error', { code: (e as any).code || 'SCRAMJET_PROFILE_BOOT_FAILED', stage: 'storage' } as any);
  };
  function keep<T extends { dispose(): void }>(value: T): T {
    if (!live) { value.dispose(); throw Error('SCRAMJET_DOCUMENT_DISPOSED'); }
    resources.add(value); return value;
  }
  const bridge: ScramjetProfileBridge = {
    profileId,
    profileContextId,
    browserSessionId: options.browserSessionId,
    frameId: documentId,
    topLevelURL: () => website,
    async prepareOrigin(url: string, guardOptions?: { interactive?: boolean }) {
      if (!live) throw Error('SCRAMJET_DOCUMENT_DISPOSED');
      await prepareProfileDocument(url, guardOptions);
      if (!live) throw Error('SCRAMJET_DOCUMENT_DISPOSED');
    },
    getRequestHeader: (context) => options.cookieProvider!.getRequestHeader(context),
    storeResponseCookies: (lines, context) => options.cookieProvider!.storeResponseCookies(lines, context),
    async bindWorkerIndexedDB(input) {
      await bridge.prepareOrigin(input.website, { interactive: false });
      if (options.localNative) return keep(await options.localNative.bind({documentId:input.documentId,website:input.website,
        limits:{quotaBytes:getProfileLimits(profileId).idbBytes}}));
      const channel = new owner.MessageChannel();
      const binding = keep(bindSandboxIndexedDB({
        port: channel.port1, documentId: input.documentId, website: input.website,
        frontendOrigin: owner.location.origin, factory: options.factory,
        profileId, profileContextId, limits: { quotaBytes: getProfileLimits(profileId).idbBytes },
      }));
      return { port: channel.port2, dispose() { binding.dispose(); channel.port2.close(); resources.delete(binding); } };
    },
    async prepareDocument(input) {
      await bridge.prepareOrigin(input.website, { interactive: input.interactive !== false });
      const id = input.documentId;
      const localOnly = !!options.localNative;
      const bindings = await Promise.allSettled([
        options.storageProvider!.bind({ documentId: id, website: input.website, sessionId: options.sessionId }),
        options.cookieProvider!.bind({ documentId: id, website: input.website, topLevelURL: input.topLevelURL }),
      ]);
      const pending: { dispose(): void }[] = bindings.filter((item): item is PromiseFulfilledResult<any> => item.status === 'fulfilled').map(item => item.value);
      const failure = bindings.find((item): item is PromiseRejectedResult => item.status === 'rejected');
      if (failure) { for (const item of pending) item.dispose(); throw failure.reason; }
      const local = (bindings[0] as PromiseFulfilledResult<any>).value;
      const jar = (bindings[1] as PromiseFulfilledResult<any>).value;
      try {
        const storage = await createSandboxStorageFacades({ documentId: id, endpoint: local.endpoint, port: local.port, window: owner, localReceipts: true, localOnly });
        pending.push(storage);
        const cookies = await createSandboxDocumentCookie({ documentId: id, endpoint: jar.endpoint, port: jar.port, window: owner, batchReads: true, localOnly: jar.localOnly === true, viewClock: createCookieViewClock(owner, profileId) });
        pending.push(cookies);
        let idbPort: MessagePort;
        if (localOnly && options.localNative) {
          const backend = await options.localNative.bind({documentId:id,website:input.website,limits:{quotaBytes:getProfileLimits(profileId).idbBytes}});
          pending.push(backend); idbPort = backend.port;
        } else {
          const channel = new owner.MessageChannel();
          const backend = bindSandboxIndexedDB({ port: channel.port1, documentId: id,
            website: input.website, frontendOrigin: owner.location.origin, factory: options.factory,
            profileId, profileContextId, limits: { quotaBytes: getProfileLimits(profileId).idbBytes } });
          pending.push(backend); idbPort = channel.port2;
        }
        const indexedDB = createSandboxIndexedDB(idbPort, id);
        pending.push(indexedDB);
        let disposed = false;
        const prepared = {
          documentId: id, website: input.website, profileId,
          install(win: Owner, client: any) {
            if (!live || disposed) throw Error('SCRAMJET_PROFILE_BINDING_DISPOSED');
            rebindSandboxStorageFacades(storage, win);
            installSandboxIndexedDB(win, indexedDB);
            cookies.install(win, () => /^https?:/.test(client.url.href) ? client.url.href : input.website);
            pending.push(visibility.install(win));
            if (localOnly) {
              // DOM input in a website iframe does not bubble into Atlas. Send
              // activity timing only, never text, across this trusted boundary.
              let queued: number | undefined;
              const activity = () => {
                if (queued !== undefined) return;
                owner.dispatchEvent(new owner.CustomEvent('atlas:profile-foreground'));
                queued = owner.setTimeout(() => {queued=undefined;},100);
              };
              for (const type of ['keydown','input','pointerdown','wheel','touchstart'])
                win.addEventListener(type,activity,{capture:true,passive:true});
              pending.push({dispose(){owner.clearTimeout(queued);for(const type of ['keydown','input','pointerdown','wheel','touchstart'])win.removeEventListener(type,activity,true);}});
            }
          },
          dispose() {
            if (disposed) return;
            disposed = true; resources.delete(prepared);
            for (const value of pending.reverse()) value.dispose();
          },
        };
        return keep(prepared);
      } catch (error) {
        for (const value of pending.reverse()) value.dispose();
        throw error;
      }
    },
  };
  const key = SCRAMJET_PROFILE_REGISTRY;
  const registry = ((owner as any)[key] ??= { hosts: new WeakMap<Window, ScramjetProfileBridge>(), get(host: Window) { return this.hosts.get(host); } });
  const receive = (event: MessageEvent) => {
    if (!live || event.source !== frame.contentWindow || event.origin !== owner.location.origin || event.data?.atlas !== 1) return;
    const data = event.data;
    if (data.type === 'profile-checkpoint-result') {
      if (data.id !== documentId || typeof data.requestId !== 'string') return;
      const request = checkpoints.get(data.requestId);
      if (!request) return;
      checkpoints.delete(data.requestId); owner.clearTimeout(request.timer);
      if (data.ok === true) request.resolve();
      else request.reject(Object.assign(new Error(typeof data.code === 'string' ? data.code : 'PROFILE_CHECKPOINT_FAILED'), { code: data.code }));
      return;
    }
    if (data.type === 'session-refresh-needed') { void renewCredentials().catch(fail); return; }
    if (data.type === 'ready' && !started) {
      started = true; owner.clearInterval(ping); ping = undefined; post('navigate', { url: website, engine: 'runtime' }); return;
    }
    if (data.type === 'boot-error' || data.type === 'session-expired') {
      fail(Object.assign(new Error(data.message || data.type), { code: data.code })); return;
    }
    if (data.type === 'popup-created' && typeof data.id === 'string' && data.id.length <= 100 &&
        managedPages.has(data.openerId) && typeof data.url === 'string' && /^(?:https?:\/\/|about:blank$)/.test(data.url)) {
      managedPages.add(data.id);
    } else if (!managedPages.has(data.id)) return;
    const root = data.id === documentId;
    if (root && data.type === 'loaded' && !loaded) {
      loaded = true; resolve(); options.onContentState?.('ready'); return;
    }
    if (root && data.type === 'navigation' && typeof data.url === 'string') {
      website = data.url; options.onLocation(website); return;
    }
    if (data.type === 'compatibility-diagnostics') {
      options.onTelemetry?.({ type: data.type, report: data.report }); return;
    }
    if (root && data.type === 'error' && !loaded) {
      fail(Object.assign(new Error(data.message || data.type), { code: data.code })); return;
    }
    if (['popup-created', 'popup-focus', 'popup-closed', 'loading', 'loaded', 'error', 'slow', 'navigation', 'title', 'favicon', 'focus-search', 'panic'].includes(data.type)) {
      options.onRuntimeEvent?.({ ...data, id: root ? undefined : data.id,
        openerId: data.openerId === documentId ? undefined : data.openerId });
      if (data.type === 'popup-closed') managedPages.delete(data.id);
    }
  };
  owner.addEventListener('message', receive);
  options.container.appendChild(frame);
  registry.hosts.set(frame.contentWindow!, bridge);
  ping = owner.setInterval(() => { if (!started) post('ping'); }, 150);
  const boot = async () => {
    const grant = await options.runtimeTicket();
    if (!live) return;
    const url = new URL(grant.runtimePath, owner.location.origin);
    url.hash = new URLSearchParams({ ticket: grant.runtimeTicket }).toString();
    frame.src = url.href;
  };
  void boot().catch(fail);
  async function renewCredentials() {
    const grant = await options.runtimeTicket();
    if (!live) return;
    const response = await owner.fetch('/runtime-config', { cache: 'no-store', headers: { authorization: 'Bearer ' + grant.runtimeTicket } });
    if (!response.ok) throw Error('SCRAMJET_RUNTIME_RENEW_FAILED');
    const config = await response.json();
    post('session-update', { ticket: grant.runtimeTicket, relayTicket: config.relayTicket, relayOrigin: config.relayOrigin,
      ticketExpiresAt: config.ticketExpiresAt, sessionHash: config.session, generation: config.generation });
  }
  return {
    frame, documentId, ready, renewCredentials,
    get logicalOrigin() { return new URL(website).origin; },
    get live() { return live; },
    checkpoint(): Promise<void> {
      if (!live || !loaded) return Promise.reject(Error('PROFILE_CHECKPOINT_NOT_READY'));
      const requestId = owner.crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = owner.setTimeout(() => {
          checkpoints.delete(requestId);
          reject(Error('PROFILE_CHECKPOINT_TIMED_OUT'));
        }, 5000);
        checkpoints.set(requestId, { resolve, reject, timer });
        post('profile-checkpoint', { requestId, origin: new URL(website).origin });
      });
    },
    runtimeControl(type: string, targetId?: string, values: Record<string, unknown> = {}) {
      const target = targetId ?? documentId;
      if (!live || !started || !managedPages.has(target)) return false;
      if (!['navigate', 'activate', 'close', 'back', 'forward', 'reload', 'panic-key', 'compatibility-config', 'compatibility-export'].includes(type)) return false;
      post(type, { ...values, id: target });
      return true;
    },
    browserControl(type: 'back' | 'forward' | 'reload') {
      if (!live || !started) return false;
      post(type);
      return true;
    },
    command(input: PageCommand) {
      if (!live || !loaded) return false;
      post(input.type, input.type === 'compatibility-config' ? { sites: { [new URL(website).origin]: input.metadata }, diagnostics: input.diagnostics } : {});
      return true;
    },
    receiveWindowMessage(origin: string, payload: unknown, ports: MessagePort[] = []) { frame.contentWindow?.postMessage(payload, origin, ports); },
    dispose() {
      if (!live) return;
      live = false; owner.clearInterval(ping); owner.removeEventListener('message', receive);
      registry.hosts.delete(frame.contentWindow!);
      for (const request of checkpoints.values()) { owner.clearTimeout(request.timer); request.reject(Error('SCRAMJET_DOCUMENT_DISPOSED')); }
      checkpoints.clear();
      reject(Error('SCRAMJET_DOCUMENT_DISPOSED'));
      for (const value of [...resources]) value.dispose(); resources.clear(); frame.remove();
    },
  };
}
