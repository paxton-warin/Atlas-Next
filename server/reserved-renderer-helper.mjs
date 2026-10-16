/** Reservation-only helper for the explicitly gated opaque runtime.
 * A helper always has a response-header opaque sandbox. It has no website
 * networking/storage/API capability and receives no relay credentials.
 * frame-ancestors 'self'/XFO SAMEORIGIN cannot allow its opaque intermediate
 * ancestor; instead a one-shot secret + exact WindowProxy + original Document
 * private-port rendezvous authorizes content. Unknown/direct visits stay inert.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
const ROOT = "/browse/renderer/v1/",
  API = "/api/browse/controller/renderer";
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,96}$/.test(value);
const secret = () => randomBytes(32).toString("hex");
function bootstrap(c) {
  const w = window,
    doc = document,
    own = Object.getOwnPropertyDescriptor(w, "document")?.get;
  const apply = Reflect.apply,
    add = EventTarget.prototype.addEventListener,
    post = MessagePort.prototype.postMessage,
    start = MessagePort.prototype.start,
    close = MessagePort.prototype.close;
  const data = Object.getOwnPropertyDescriptor(
      MessageEvent.prototype,
      "data",
    ).get,
    ports = Object.getOwnPropertyDescriptor(
      MessageEvent.prototype,
      "ports",
    ).get;
  const parse = DOMParser.prototype.parseFromString,
    set = Element.prototype.setAttribute,
    open = Document.prototype.open,
    write = Document.prototype.write,
    finish = Document.prototype.close;
  const stringify = JSON.stringify,
    parseJSON = JSON.parse;
  const current = () => apply(own, w, []) === doc;
  if (!own || w === w.parent || w.top === w) return;
  const parent = w.parent,
    rendezvous = new MessageChannel(),
    deadline = w.setTimeout.bind(w),
    cancel = w.clearTimeout.bind(w);
  let granted = false,
    initialized = false,
    finalPort,
    documentNonce,
    written = false;
  const send = (port, value, transfer = []) =>
    apply(post, port, [value, transfer]);
  const listen = (port, listener) => {
    apply(add, port, [
      "message",
      (event) => listener(apply(data, event, []), apply(ports, event, [])),
    ]);
    apply(start, port, []);
  };
  const timer = deadline(() => {
    apply(close, rendezvous.port1, []);
    if (finalPort) apply(close, finalPort, []);
  }, c.timeoutMs);
  listen(rendezvous.port1, (message, transfers) => {
    if (
      granted ||
      !current() ||
      message?.protocol !== "atlas-renderer-v1" ||
      message.type !== "grant" ||
      message.parentDocumentId !== c.parentDocumentId ||
      message.childId !== c.childId ||
      !/^([a-f0-9]{64})$/.test(message.documentNonce) ||
      transfers.length !== 1
    )
      return;
    granted = true;
    documentNonce = message.documentNonce;
    finalPort = transfers[0];
    apply(close, rendezvous.port1, []);
    listen(finalPort, (m, extra) => {
      if (
        extra.length ||
        !current() ||
        m?.protocol !== "atlas-renderer-v1" ||
        m.childId !== c.childId ||
        m.documentNonce !== documentNonce
      )
        return;
      if (m.type === "attest") {
        send(finalPort, {
          protocol: "atlas-renderer-v1",
          type: "attestation",
          childId: c.childId,
          documentNonce,
          challenge: m.challenge,
          active: written && current(),
        });
        return;
      }
      if (
        initialized ||
        m.type !== "content" ||
        typeof m.html !== "string" ||
        m.html.length > 1400000
      )
        return;
      initialized = true;
      try {
        // Parsing and all private port/event primitives were captured before any
        // reviewed renderer code. Its original CSP metas remain an intersection.
        const tree = apply(parse, new DOMParser(), [m.html, "text/html"]);
        for (const script of tree.querySelectorAll("script")) {
          if (script.hasAttribute("src"))
            throw Error("unprepared_renderer_script");
          // Physical response CSP already authorizes only exact prepared hashes;
          // the private bootstrap nonce is never attached to renderer scripts.
        }
        const html = "<!doctype html>" + tree.documentElement.outerHTML;
        doc.currentScript?.remove();
        apply(open, doc, []);
        apply(write, doc, [html]);
        apply(finish, doc, []);
        written = true;
        send(finalPort, {
          protocol: "atlas-renderer-v1",
          type: "written",
          childId: c.childId,
          documentNonce,
        });
      } catch {
        send(finalPort, {
          protocol: "atlas-renderer-v1",
          type: "failed",
          childId: c.childId,
          documentNonce,
        });
        apply(close, finalPort, []);
      }
    });
    send(finalPort, {
      protocol: "atlas-renderer-v1",
      type: "grant-ack",
      childId: c.childId,
      documentNonce,
      active: current(),
    });
  });
  // Nothing travels through the untrusted intermediate parent; the helper's
  // closure-created rendezvous carries no website/network/storage authority.
  w.top.postMessage(
    {
      protocol: "atlas-renderer-v1",
      type: "renderer-ready",
      parentDocumentId: c.parentDocumentId,
      childId: c.childId,
      secret: c.secret,
    },
    c.frontendOrigin,
    [rendezvous.port2],
  );
}
export function installReservedRendererHelper(app, options) {
  const { originFor, authorizeReservation, fixture = false } = options;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (
    typeof originFor !== "function" ||
    typeof authorizeReservation !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 250 ||
    timeoutMs > 30000
  )
    throw Error("renderer_helper_options");
  const entries = new Map();
  const base = (req) => {
    const u = new URL(originFor(req));
    if (
      u.origin !== originFor(req) ||
      u.username ||
      u.password ||
      (u.protocol !== "https:" &&
        !(fixture && u.protocol === "http:" && u.hostname === "127.0.0.1"))
    )
      throw Error("renderer_helper_origin");
    return u.origin;
  };
  const headers = (reply) =>
    reply
      .header("Cache-Control", "no-store")
      .header("Vary", "Host, Origin")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
  app.post(API, async (req, reply) => {
    const origin = base(req),
      body = req.body;
    let ownerBinding;
    if (
      req.headers.origin !== origin ||
      !body ||
      Object.keys(body).length !== 2 ||
      !id(body.parentDocumentId) ||
      !Array.isArray(body.scriptHashes) ||
      body.scriptHashes.length < 1 ||
      body.scriptHashes.length > 8 ||
      body.scriptHashes.some(
        (v) =>
          typeof v !== "string" || !/^'sha256-[A-Za-z0-9+/]{43}='$/.test(v),
      ) ||
      !(ownerBinding = await authorizeReservation(req, body.parentDocumentId))
    )
      return headers(reply)
        .code(403)
        .send({ error: "RENDERER_RESERVATION_DENIED" });
    const now = Date.now();
    for (const [key, value] of entries)
      if (value.expires <= now) entries.delete(key);
    if (
      entries.size >= 64 ||
      [...entries.values()].filter(
        (v) => v.parentDocumentId === body.parentDocumentId,
      ).length >= 8
    )
      return headers(reply)
        .code(429)
        .send({ error: "RENDERER_RESERVATION_LIMIT" });
    const childId = "rndr_" + randomBytes(16).toString("hex"),
      key = body.parentDocumentId + "/" + childId;
    const entry = {
      parentDocumentId: body.parentDocumentId,
      ownerBinding,
      childId,
      secret: secret(),
      scriptNonce: secret(),
      scriptHashes: [...new Set(body.scriptHashes)],
      navigationAuth: secret(),
      frontendOrigin: origin,
      timeoutMs,
      expires: now + timeoutMs,
    };
    entries.set(key, entry);
    const cookieName = "__Secure-atlas-renderer-" + childId;
    headers(reply).header(
      "Set-Cookie",
      cookieName +
        "=" +
        entry.navigationAuth +
        "; Path=" +
        ROOT +
        key +
        "; Max-Age=" +
        Math.ceil(timeoutMs / 1000) +
        "; Secure; HttpOnly; SameSite=None",
    );
    return reply.send({
      helperURL: origin + ROOT + key,
      childId,
      secret: entry.secret,
    });
  });
  app.get(ROOT + ":parentDocumentId/:childId", async (req, reply) => {
    const origin = base(req),
      key = req.params.parentDocumentId + "/" + req.params.childId,
      entry = entries.get(key);
    if (
      !entry ||
      entry.frontendOrigin !== origin ||
      entry.expires <= Date.now() ||
      (options.validateReservation && options.validateReservation(entry.ownerBinding) !== true)
    ) {
      entries.delete(key);
      return headers(reply)
        .header(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; frame-ancestors 'none'",
        )
        .code(404)
        .type("text/html")
        .send("<!doctype html>");
    }
    const cookieName = "__Secure-atlas-renderer-" + entry.childId;
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (
      !cookie ||
      !/^[a-f0-9]{64}$/.test(cookie) ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(entry.navigationAuth))
    )
      return headers(reply)
        .header(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; frame-ancestors 'none'",
        )
        .code(403)
        .type("text/html")
        .send("<!doctype html>");
    reply.removeHeader("X-Frame-Options");
    reply.header(
      "Set-Cookie",
      cookieName +
        "=; Path=" +
        ROOT +
        key +
        "; Max-Age=0; Secure; HttpOnly; SameSite=None",
    );
    entries.delete(key); // A reload or adversarial second native navigation is not a rebind.
    const script =
      "(" +
      bootstrap.toString() +
      ")(" +
      JSON.stringify({ ...entry, navigationAuth: undefined, ownerBinding: undefined }).replaceAll(
        "<",
        "\\u003c",
      ) +
      ");";
    const csp =
      "sandbox allow-scripts; default-src 'none'; script-src 'nonce-" +
      entry.scriptNonce +
      "' " +
      entry.scriptHashes.join(" ") +
      " 'unsafe-eval'; script-src-elem 'nonce-" +
      entry.scriptNonce +
      "' " +
      entry.scriptHashes.join(" ") +
      "; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; worker-src blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
    return headers(reply)
      .header("Content-Security-Policy", csp)
      .type("text/html; charset=utf-8")
      .send(
        '<!doctype html><meta charset="utf-8"><title>Isolated renderer</title><script nonce="' +
          entry.scriptNonce +
          '">' +
          script.replaceAll("</script", "<\\/script") +
          "</script>",
      );
  });
  return Object.freeze({
    dispose() {
      entries.clear();
    },
  });
}
