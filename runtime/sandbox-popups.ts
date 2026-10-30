/** Trusted owner of pre-reserved opaque auxiliary documents. No credentials or
 * bootstrap nonce enter the website. WindowProxy identifies only the native
 * opened window; all granted operations/messages stay on its original port. */
type Binding = {
  ready: Promise<void>;
  dispose(): void;
  readonly live: boolean;
  readonly logicalOrigin: string;
  receiveWindowMessage(
    origin: string,
    payload: unknown,
    ports: MessagePort[],
    source: object,
  ): void;
};
type Reservation = {
  frameURL: string;
  resourceOrigin: string;
  serverBootstrapNonce?: boolean;
  expiresAt?: number;
  refresh?(): Promise<number>;
  dispose?(): void;
};
type Record = {
  id: string;
  nonce: string;
  sessionId: string;
  reservation: Reservation;
  url?: string;
  offer?: MessageEvent;
  binding?: Binding;
  started: boolean;
  ready: boolean;
  renewAt: number;
  renewing?: boolean;
  window?: Window;
  queue: Array<{
    origin: string;
    targetOrigin: string;
    payload: unknown;
    ports: MessagePort[];
  }>;
};
export async function createSandboxPopupBroker(options: {
  window: Window & typeof globalThis;
  documentOrigin?: "opaque" | "same-origin";
  parentWindow: Window;
  documentId: string;
  website: () => string;
  active(): boolean;
  reserve(input: {
    documentId: string;
    website: string;
    signal: AbortSignal;
    parentDocumentId?: string;
    bootstrapNonce?: string;
    kind?: "popup";
  }): Promise<Reservation>;
  bind(input: {
    documentId: string;
    nonce: string;
    offer: MessageEvent;
    website: string;
    sessionId: string;
    window: Window;
    reservation: Reservation;
    state: (ready: boolean) => void;
    opener: (
      origin: string,
      targetOrigin: string,
      payload: unknown,
      ports: MessagePort[],
    ) => void;
  }): Binding;
  post(message: object): void;
  deliverOpener(
    origin: string,
    payload: unknown,
    ports: MessagePort[],
    popupId: string,
  ): void;
}) {
  const owner = options.window,
    records = new Map<string, Record>(),
    abort = new AbortController();
  let live = true,
    adding = false,
    fillFailures = 0,
    fillAfter = 0;
  const post = (type: string, extra: object) => {
    if (live && options.active())
      options.post({
        protocol: 2,
        documentId: options.documentId,
        type,
        ...extra,
      });
  };
  function publish() {
    post("popup-pool", {
      entries: [...records.values()]
        .filter(
          (r) =>
            !r.url &&
            (!r.reservation.expiresAt ||
              r.reservation.expiresAt > Date.now() + 1000),
        )
        .map((r) => ({ documentId: r.id, url: r.reservation.frameURL })),
    });
  }
  function remove(id: string, close = true) {
    const r = records.get(id);
    if (!r) return;
    records.delete(id);
    r.binding?.dispose();
    r.reservation.dispose?.();
    for (const m of r.queue) for (const p of m.ports) p.close();
    if (close)
      try {
        r.window?.close();
      } catch {}
    post("popup-state", { popupId: id, phase: "closed" });
  }
  async function fill() {
    if (!live || adding || Date.now() < fillAfter) return;
    adding = true;
    try {
      while (
        live &&
        [...records.values()].filter((r) => !r.url).length < 2 &&
        records.size < 6
      ) {
        const id = "doc_" + owner.crypto.randomUUID().replaceAll("-", ""),
          nonce = owner.crypto.randomUUID() + owner.crypto.randomUUID();
        const reservation = await options.reserve({
          documentId: id,
          website: options.website(),
          signal: abort.signal,
          parentDocumentId: options.documentId,
          bootstrapNonce: nonce,
          kind: "popup",
        });
        if (!live) {
          reservation.dispose?.();
          break;
        }
        if (
          !reservation.serverBootstrapNonce ||
          reservation.frameURL !== owner.location.origin + "/browse/popup/" + id
        )
          throw Error("popup_reservation_invalid");
        records.set(id, {
          id,
          nonce,
          sessionId: "popup_" + owner.crypto.randomUUID().replaceAll("-", ""),
          reservation,
          started: false,
          ready: false,
          renewAt: Date.now() + 60000,
          queue: [],
        });
      }
      fillFailures = 0;
      fillAfter = 0;
    } catch {
      // Spare windows are optional. In particular, a rate-limited reserve must
      // not reject this broker's constructor and strand the REQUIRED document
      // capability grant in a blank bootstrap. Keep a valid empty/partial pool;
      // native window.open remains synchronously null until a spare is ready.
      // The constructor always returns its disposer, including after failure.
      if (live) {
        fillFailures = Math.min(fillFailures + 1, 6);
        fillAfter = Date.now() + Math.min(30000, 1000 * 2 ** (fillFailures - 1));
      }
    } finally {
      adding = false;
      publish();
    }
  }
  function start(r: Record) {
    if (!live || !options.active() || !r.url || !r.offer || r.started) return;
    r.started = true;
    r.window = r.offer.source as Window;
    for (const other of [...records.values()])
      if (other !== r && other.window === r.window) {
        r.sessionId = other.sessionId;
        remove(other.id, false);
      }
    r.binding = options.bind({
      documentId: r.id,
      nonce: r.nonce,
      offer: r.offer,
      website: r.url,
      sessionId: r.sessionId,
      window: r.window,
      reservation: r.reservation,
      state(ready) {
        if (!records.has(r.id)) return;
        if (!ready) {
          remove(r.id);
          return;
        }
        r.ready = true;
        post("popup-state", {
          popupId: r.id,
          phase: "ready",
          origin: r.binding!.logicalOrigin,
        });
        for (const m of r.queue.splice(0)) deliver(r, m);
      },
      opener(origin, targetOrigin, payload, ports) {
        if (!records.has(r.id) || !options.active()) return;
        const destination = new URL(options.website()).origin;
        if (targetOrigin !== "*" && targetOrigin !== destination) return;
        options.deliverOpener(origin, payload, ports, r.id);
      },
    });
    void r.binding.ready.catch(() => remove(r.id));
    void fill().catch(() => {});
  }
  function deliver(
    r: Record,
    m: {
      origin: string;
      targetOrigin: string;
      payload: unknown;
      ports: MessagePort[];
    },
  ) {
    if (!r.binding?.live || !r.ready) {
      if (r.queue.length < 8) r.queue.push(m);
      return;
    }
    if (m.targetOrigin === "*" || m.targetOrigin === r.binding.logicalOrigin)
      r.binding.receiveWindowMessage(m.origin, m.payload, m.ports, {
        popupOpener: true,
      });
  }
  const receive = (event: MessageEvent) => {
    const m = event.data;
    if (
      !live ||
      event.origin !== (options.documentOrigin === "same-origin" ? owner.location.origin : "null") ||
      !m ||
      m.protocol !== 2 ||
      m.type !== "sandbox-ready" ||
      event.ports.length !== 1
    )
      return;
    const r = records.get(m.documentId);
    if (!r || r.offer || m.nonce !== r.nonce) return;
    try {
      const child = event.source as Window;
      if (
        !child ||
        child.opener !== options.parentWindow ||
        child === options.parentWindow
      )
        return;
      r.offer = event;
      start(r);
    } catch {}
  };
  owner.addEventListener("message", receive);
  const timer = owner.setInterval(() => {
    if (!live) return;
    for (const r of [...records.values()]) {
      if (r.window?.closed) {
        remove(r.id, false);
        continue;
      }
      if (r.reservation.refresh && !r.renewing && Date.now() >= r.renewAt) {
        r.renewing = true;
        void r.reservation
          .refresh()
          .then((expires) => {
            r.reservation.expiresAt = expires;
            r.renewAt = Date.now() + 60000;
          })
          .catch(() => {
            r.renewAt = Date.now() + 5000;
          })
          .finally(() => {
            r.renewing = false;
            publish();
          });
      }
    }
    void fill().catch(() => {});
  }, 500);
  await fill();
  return {
    entries: () =>
      [...records.values()]
        .filter(
          (r) =>
            !r.url &&
            (!r.reservation.expiresAt ||
              r.reservation.expiresAt > Date.now() + 1000),
        )
        .map((r) => ({ documentId: r.id, url: r.reservation.frameURL })),
    receive(message: any, ports: readonly MessagePort[]) {
      if (!live || !options.active()) return false;
      if (message.type === "popup-open") {
        const r = records.get(message.popupId);
        if (
          !r ||
          r.url ||
          typeof message.url !== "string" ||
          message.url.length > 16384 ||
          ports.length
        )
          return true;
        try {
          const u = new URL(message.url);
          if (
            !/^https?:$/.test(u.protocol) ||
            u.username ||
            u.password ||
            u.hostname === owner.location.hostname
          )
            throw Error();
          r.url = u.href;
          start(r);
          publish();
        } catch {
          remove(r.id);
        }
        return true;
      }
      if (message.type === "popup-cancel") {
        if (!ports.length) remove(message.popupId);
        return true;
      }
      if (
        message.type === "window-message" &&
        typeof message.popupId === "string"
      ) {
        const r = records.get(message.popupId);
        if (r?.url && typeof message.targetOrigin === "string")
          deliver(r, {
            origin: new URL(options.website()).origin,
            targetOrigin: message.targetOrigin,
            payload: message.payload,
            ports: [...ports],
          });
        return true;
      }
      return false;
    },
    publish,
    dispose() {
      if (!live) return;
      live = false;
      abort.abort();
      owner.clearInterval(timer);
      owner.removeEventListener("message", receive);
      for (const id of [...records.keys()]) remove(id);
    },
  };
}
