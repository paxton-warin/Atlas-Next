import test from "node:test";
import assert from "node:assert/strict";
import { createOpaqueXMLHttpRequest } from "../runtime/opaque-xhr.ts";
class ProgressEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.loaded = init.loaded || 0;
    this.total = init.total || 0;
    this.lengthComputable = !!init.lengthComputable;
  }
}
const realm = Object.assign(Object.create(globalThis), { ProgressEvent });
const raw = (
  body = "hello",
  headers = [
    ["content-type", "text/plain"],
    ["content-length", String(new TextEncoder().encode(body).length)],
  ],
) => ({
  url: "https://site.example/data",
  status: 200,
  statusText: "OK",
  headers,
  body: new TextEncoder().encode(body).buffer,
});
const done = (xhr) =>
  new Promise((resolve) =>
    xhr.addEventListener("loadend", resolve, { once: true }),
  );
function fixture(request = async () => raw(), extra = {}) {
  const calls = [];
  const api = createOpaqueXMLHttpRequest({
    window: realm,
    documentURL: () => "https://site.example/page",
    fetch: () => {
      throw Error("native fallback");
    },
    request: async (...args) => {
      calls.push(args);
      return request(...args);
    },
    ...extra,
  });
  return { api, calls, xhr: new api.XMLHttpRequest() };
}
test("async XHR publishes state, progress and final fields from broker bytes, never native network", async () => {
  const { xhr, calls } = fixture();
  const states = [],
    events = [];
  xhr.onreadystatechange = () => states.push(xhr.readyState);
  for (const type of ["loadstart", "progress", "load", "loadend"])
    xhr.addEventListener(type, (e) =>
      events.push([
        e.type,
        e.loaded,
        e.total,
        e.target === xhr,
        e.currentTarget === xhr,
      ]),
    );
  xhr.open("get", "/data#fragment");
  const end = done(xhr);
  xhr.send();
  await end;
  assert.deepEqual(states, [1, 2, 3, 4]);
  assert.deepEqual(
    events.map((x) => x[0]),
    ["loadstart", "progress", "load", "loadend"],
  );
  assert.equal(xhr.responseText, "hello");
  assert.equal(xhr.response, "hello");
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseURL, "https://site.example/data");
  assert.equal(xhr.getResponseHeader("CONTENT-TYPE"), "text/plain");
  assert.match(
    xhr.getAllResponseHeaders(),
    /^content-length: 5\r\ncontent-type: text\/plain\r\n$/,
  );
  assert.equal(calls[0][0].url, "https://site.example/data");
  assert.equal(calls[0][0].credentials, "same-origin");
  assert.equal(calls[0][0].forcePreflight, false);
  assert.ok(events.every((x) => x[3] && x[4]));
});
test("XHR request body, headers, cross-origin preflight and credentials retain the document broker contract", async () => {
  const { xhr, calls } = fixture();
  xhr.open("POST", "https://peer.example/write");
  xhr.withCredentials = true;
  xhr.setRequestHeader("Cookie", "frontend=leak");
  xhr.setRequestHeader("Host", "frontend");
  xhr.setRequestHeader("X-Test", "one");
  xhr.setRequestHeader("x-test", "two");
  xhr.setRequestHeader("X-HTTP-Method-Override", "TRACE");
  const end = done(xhr);
  xhr.send("payload");
  await end;
  const r = calls[0][0];
  assert.equal(r.forcePreflight, true);
  assert.equal(r.credentials, "include");
  assert.equal(r.mode, "cors");
  assert.equal(r.redirect, "follow");
  assert.equal(new TextDecoder().decode(r.body), "payload");
  assert.equal(new Headers(r.headers).get("x-test"), "one, two");
  assert.equal(new Headers(r.headers).get("cookie"), null);
  assert.equal(new Headers(r.headers).get("host"), null);
  assert.equal(new Headers(r.headers).get("x-http-method-override"), null);
  assert.equal(
    new Headers(r.headers).get("content-type"),
    "text/plain;charset=UTF-8",
  );
});
test("arraybuffer, blob, JSON and invalid JSON response objects have stable native-style identities", async () => {
  for (const [type, body] of [
    ["arraybuffer", "hello"],
    ["blob", "hello"],
    ["json", '{"ok":1}'],
    ["json", "broken"],
  ]) {
    const { xhr } = fixture(async () => raw(body));
    xhr.open("GET", "/data");
    xhr.responseType = type;
    assert.equal(xhr.response, null);
    assert.throws(() => xhr.responseText, { name: "InvalidStateError" });
    const end = done(xhr);
    xhr.send();
    await end;
    const a = xhr.response,
      b = xhr.response;
    assert.equal(a, b);
    if (type === "arraybuffer")
      assert.equal(new TextDecoder().decode(a), "hello");
    else if (type === "blob") assert.equal(await a.text(), "hello");
    else assert.deepEqual(a, body === "broken" ? null : { ok: 1 });
  }
});
test("abort and timeout cancel the broker signal and discard late success without duplicate terminal events", async () => {
  for (const kind of ["abort", "timeout"]) {
    let finish, signal;
    const { xhr } = fixture((_r, s) => {
      signal = s;
      return new Promise((r) => (finish = r));
    });
    const events = [];
    for (const type of ["abort", "timeout", "error", "load", "loadend"])
      xhr.addEventListener(type, () => events.push(type));
    xhr.open("GET", "/slow");
    if (kind === "timeout") xhr.timeout = 10;
    const end = done(xhr);
    xhr.send();
    await new Promise((r) => setTimeout(r, 1));
    if (kind === "abort") xhr.abort();
    await end;
    assert.equal(signal.aborted, true);
    assert.equal(xhr.status, 0);
    assert.equal(xhr.readyState, kind === "abort" ? 0 : 4);
    finish(raw());
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, [kind, "loadend"]);
  }
});
test("open supersedes an active request without old completion crossing the new generation", async () => {
  let finish;
  const { xhr, calls } = fixture((r) =>
    r.url.endsWith("/old")
      ? new Promise((resolve) => (finish = resolve))
      : raw("new"),
  );
  const events = [];
  xhr.onload = () => events.push(xhr.responseText);
  xhr.open("GET", "/old");
  xhr.send();
  await new Promise((r) => setTimeout(r, 1));
  xhr.open("GET", "/new");
  const end = done(xhr);
  xhr.send();
  await end;
  finish(raw("old"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["new"]);
  assert.equal(calls[0][1].aborted, true);
});
test("network/CORS failure returns status0 with error/loadend and no hidden response bytes or cookies", async () => {
  const { xhr } = fixture(async () => {
    throw Error("private origin failure");
  });
  const events = [];
  xhr.open("GET", "https://peer.example/private");
  for (const type of ["error", "load", "loadend"])
    xhr.addEventListener(type, () => events.push(type));
  const end = done(xhr);
  xhr.send();
  await end;
  assert.deepEqual(events, ["error", "loadend"]);
  assert.equal(xhr.responseText, "");
  assert.equal(xhr.responseURL, "");
  assert.equal(xhr.status, 0);
  assert.equal(xhr.getAllResponseHeaders(), "");
});
test("WebIDL-style state validation and forbidden methods/sync paths fail before transport", () => {
  const { xhr, calls } = fixture();
  assert.throws(() => xhr.send(), { name: "InvalidStateError" });
  assert.throws(() => xhr.open("TRACE", "/"), { name: "SecurityError" });
  assert.throws(() => xhr.open("bad verb", "/"), { name: "SyntaxError" });
  assert.throws(() => xhr.open("GET", "/", false), {
    name: "NotSupportedError",
  });
  assert.throws(() => xhr.open("GET", "https://a:b@site.example/"), {
    name: "NotSupportedError",
  });
  assert.throws(() => xhr.open("GET", "/", true, "account", "secret"), {
    name: "NotSupportedError",
  });
  xhr.open("GET", "/");
  assert.throws(() => xhr.setRequestHeader("bad key", "x"), {
    name: "SyntaxError",
  });
  assert.throws(() => xhr.setRequestHeader("x", "a\r\nb"), {
    name: "SyntaxError",
  });
  assert.throws(() => xhr.setRequestHeader("x", "\u0100"), TypeError);
  assert.equal(calls.length, 0);
  assert.equal(Object.prototype.toString.call(xhr), "[object XMLHttpRequest]");
  assert.equal(xhr.upload, xhr.upload);
});
test("body/response bounds and document disposal terminate explicitly instead of fabricating load", async () => {
  const { xhr, api } = fixture(async () => raw("x".repeat(20)), {
    maxBodyBytes: 10,
  });
  xhr.open("POST", "/");
  assert.throws(() => xhr.send(new Blob(["x".repeat(11)])), {
    name: "QuotaExceededError",
  });
  xhr.open("GET", "/");
  const events = [];
  xhr.onerror = () => events.push("error");
  const end = done(xhr);
  xhr.send();
  await end;
  assert.deepEqual(events, ["error"]);
  assert.equal(xhr.status, 0);
  api.dispose();
  xhr.open("GET", "/");
  assert.throws(() => xhr.send(), { name: "InvalidStateError" });
});
test("upload events represent completed body transfer only after a broker response and error when cancelled", async () => {
  let finish;
  const { xhr } = fixture(() => new Promise((r) => (finish = r)));
  const events = [];
  for (const t of ["loadstart", "progress", "load", "loadend", "abort"])
    xhr.upload.addEventListener(t, (e) => events.push([t, e.loaded]));
  xhr.open("POST", "/");
  const end = done(xhr);
  xhr.send("payload");
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(events, [["loadstart", 0]]);
  finish(raw());
  await end;
  assert.deepEqual(events, [
    ["loadstart", 0],
    ["progress", 7],
    ["load", 7],
    ["loadend", 7],
  ]);
});

test("XHR concurrency is bounded before serialization and preserves MIME override across open", async () => {
  let release;
  const { xhr, api } = fixture(() => new Promise((r) => (release = r)), {
    maxPending: 1,
  });
  xhr.overrideMimeType("text/plain;charset=windows-1252");
  xhr.open("GET", "/");
  const end = done(xhr);
  xhr.send();
  const second = new api.XMLHttpRequest();
  second.open("POST", "/");
  assert.throws(() => second.send(new Blob(["x"])), {
    name: "QuotaExceededError",
  });
  release({ ...raw(), body: new Uint8Array([0xe9]).buffer });
  await end;
  assert.equal(xhr.responseText, "é");
  assert.throws(() => second.open("GET", "/", undefined), {
    name: "NotSupportedError",
  });
  api.dispose();
});
