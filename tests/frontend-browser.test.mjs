import test from "node:test";
import assert from "node:assert/strict";
import {
  createFrontendBrowser,
  loadFrontendRuntimeAssets,
} from "../runtime/frontend-browser.ts";
const tick = () => new Promise((r) => setImmediate(r));
test("dedicated worker transport is rebound to the trusted parent entry, worker URL and selected relay; stale parents lose it", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/redirect");
  const parent = browser.document,
    workerId = "worker_" + "a".repeat(48);
  const fetch = parent.options.workerFetch({
    parentDocumentId: parent.documentId,
    documentId: workerId,
    documentURL: "https://site.test/workers/final.js",
  });
  const binding = f.fetchBindings.at(-1);
  assert.equal(binding.documentId, workerId);
  assert.equal(binding.documentURL, "https://site.test/workers/final.js");
  assert.equal(binding.topLevelURL, "https://site.test/final");
  assert.equal(binding.relay.assignment.origin, "https://nodeA.test");
  await fetch(
    {
      url: "https://site.test/api",
      method: "GET",
      headers: [],
      mode: "same-origin",
      credentials: "include",
    },
    {
      documentId: workerId,
      documentURL: binding.documentURL,
      origin: "https://site.test",
      signal: new AbortController().signal,
      preflight: false,
    },
  );
  assert.throws(
    () =>
      parent.options.workerFetch({
        parentDocumentId: parent.documentId,
        documentId: workerId,
        documentURL: "https://peer.test/worker.js",
      }),
    { code: "FRONTEND_WORKER_BINDING_MISMATCH" },
  );
  assert.throws(
    () =>
      parent.options.workerFetch({
        parentDocumentId: "missing-parent",
        documentId: workerId,
        documentURL: "https://site.test/worker.js",
      }),
    { code: "FRONTEND_WORKER_BINDING_MISMATCH" },
  );
  await browser.navigate("https://site.test/next");
  assert.throws(() => fetch({ url: "https://site.test/api" }, {}), {
    code: "FRONTEND_WORKER_BINDING_MISMATCH",
  });
});
const assets = {
  version: 2,
  bootstrap: "/browse/assets/document-0123456789abcdef.js",
  trustedRewriter: "/browse/assets/rewriter-0123456789abcdef.js",
  workers: {
    storage: "/browse/assets/storage-0123456789abcdef.js",
    cookies: "/browse/assets/cookies-0123456789abcdef.js",
    relay: "/browse/assets/relay-0123456789abcdef.js",
  },
};
function fixture(t) {
  const events = [],
    owners = [],
    docs = [],
    fetchBindings = [],
    rewrites = [],
    storage = new Map(),
    states = [];
  let config,
    active,
    sequence = 0,
    sourceGate,
    sourceError,
    contentFailure,
    cookieError,
    nativeError,
    nativeGate,
    missingTransform = false;
  const lease = (node = "nodeA") => ({
    protocol: 2,
    session: "raw_" + ++sequence,
    sessionHash: String(sequence).padStart(64, "0"),
    generation: 1,
    frontendOrigin: "https://front.test",
    relayOrigin: "https://" + node + ".test",
    browserSessionId: "browser_session_identity_0123456789",
    ticket: "ticket_" + sequence,
    node: { id: node, name: node },
  });
  const owner = {
    location: { origin: "https://front.test" },
    crypto: globalThis.crypto,
    AbortController,
    AbortSignal,
    indexedDB: {},
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    async fetch(path, input) {
      events.push(["control", path, input]);
      if (path === "/api/browse/controller/runtime")
        return Response.json(assets);
      if (path === "/api/browse/controller/resource-owner")
        return Response.json({ ownerTicket: "signed_purpose_ticket" });
      throw Error("unexpected native website fetch " + path);
    },
  };
  const container = { ownerDocument: { defaultView: owner } };
  const control = {
    current: null,
    transport: {
      request() {
        throw Error("fixture callback should own requests");
      },
      connectWebSocket() {},
      get assignment() {
        return {
          origin: active.relayOrigin,
          ticket: active.ticket,
          generation: active.generation,
          sessionHash: active.sessionHash,
        };
      },
    },
    async publish(value, changed = true) {
      active = value;
      this.current = value;
      config.onAssignment({
        assignment: value,
        previous: null,
        reason: changed ? "selection" : "renew",
        identityChanged: changed,
      });
      config.onState({ status: "ready" });
      return value;
    },
    start() {
      return this.publish(lease());
    },
    check() {
      return this.publish(
        { ...active, ticket: "renewed_" + ++sequence },
        false,
      );
    },
    selectNode(node, csrf) {
      assert.equal(csrf, "csrf_fixture");
      events.push(["commit", node]);
      return this.publish(lease(node));
    },
    reconnect() {
      return this.publish(lease(active.node.id));
    },
    stop() {
      events.push(["coordinator-stop"]);
    },
  };
  const components = {
    coordinator(options) {
      config = options;
      return control;
    },
    async rewriter(url) {
      events.push(["rewriter-import", url]);
      return {
        createFrontendResourceRewriter: (ctx) => {
          rewrites.push(ctx);
          return missingTransform
            ? undefined
            : async (resource) => {
                events.push(["transform", ctx.documentId, resource.url]);
                return resource.body;
              };
        },
      };
    },
    async storage(options) {
      await options.registrationHeaders();
      const value = {
        kind: "storage",
        options,
        disposed: false,
        async bind(input) {
          events.push(["storage-bind", input]);
          return { port: {}, endpoint: "/commit", dispose() {} };
        },
        dispose() {
          value.disposed = true;
          events.push(["storage-dispose"]);
        },
      };
      owners.push(value);
      events.push(["storage-create"]);
      return value;
    },
    async cookies(options) {
      await options.registrationHeaders();
      if (cookieError) throw Error("cookie fixture failure");
      const value = {
        kind: "cookies",
        options,
        disposed: false,
        async bind(input) {
          events.push(["cookies-bind", input]);
          return { port: {}, endpoint: "/cookie-result", dispose() {} };
        },
        getRequestHeader: async () => "",
        storeResponseCookies: async () => {},
        dispose() {
          value.disposed = true;
          events.push(["cookies-dispose"]);
        },
      };
      owners.push(value);
      events.push(["cookies-create"]);
      return value;
    },
    frames(options) {
      const value = {
        kind: "frames",
        disposed: false,
        async reserve(input) {
          events.push(["frame-reserve", input.website]);
          return {
            frameURL: "https://front.test/browse/frame/" + input.documentId,
            resourceOrigin: options.assignment().relayOrigin,
            dispose() {},
          };
        },
        dispose() {
          value.disposed = true;
          events.push(["frames-dispose"]);
        },
      };
      owners.push(value);
      return value;
    },
    async native(options) {
      events.push(["native-start"]);
      if (nativeGate) await nativeGate;
      if (nativeError) throw Error("native fixture failure");
      const id = options.identity();
      await options.grant(id, {
        refresh: false,
        signal: new AbortController().signal,
      });
      const value = {
        kind: "native",
        disposed: false,
        async bind(input) {
          const bindings = await options.documentBindings({
            documentId: input.documentId,
            documentURL: input.website,
            topLevelURL: input.topLevelURL,
            contentPolicies: input.contentPolicies,
            coep: input.coep,
          });
          await bindings.transform({
            body: new Uint8Array([1, 2]),
            mime: "text/javascript",
            kind: "script",
            url: input.website + "/script.js",
            signal: new AbortController().signal,
          });
          events.push(["native-bind", input.website]);
          return {
            port: {},
            ready: Promise.resolve(),
            resourceOrigin: id.resourceOrigin,
            dispose() {},
          };
        },
        dispose() {
          value.disposed = true;
          events.push(["native-dispose"]);
        },
        stats() {
          return { live: !value.disposed };
        },
      };
      owners.push(value);
      events.push(["native-create"]);
      return value;
    },
    fetch(options) {
      fetchBindings.push(options);
      return async (request, context) => {
        assert.equal(context.documentId, options.documentId);
        assert.equal(context.documentURL, options.documentURL);
        assert.equal(context.origin, new URL(options.documentURL).origin);
        events.push(["website-transport", request.url]);
        return {
          url: request.url,
          status: 200,
          statusText: "OK",
          headers: [],
          body: new ArrayBuffer(0),
        };
      };
    },
    socket(options) {
      return async (url, _protocols, context) => {
        assert.equal(context.documentURL, options.documentURL);
        events.push(["website-socket", url]);
        return { send() {}, close() {} };
      };
    },
    source(options) {
      let disposed = false;
      return {
        async prepare(input) {
          events.push(["source-start", input.website]);
          if (sourceGate) await sourceGate;
          if (disposed || input.signal.aborted) throw Error("source aborted");
          if (sourceError) throw Error("source fixture error");
          await options.fetch(
            {
              url: input.website,
              headers: [],
              method: "GET",
              credentials: "include",
              mode: "no-cors",
            },
            {
              documentId: input.documentId,
              documentURL: input.website,
              origin: new URL(input.website).origin,
              signal: input.signal,
            },
          );
          return {
            url: input.website.replace("/redirect", "/final"),
            html: "<!doctype html><p>synthetic</p>",
            contentPolicies: ["script-src 'self'"],
            coep: "unsafe-none",
          };
        },
        dispose() {
          disposed = true;
          events.push(["source-dispose"]);
        },
      };
    },
    document(options) {
      const docid = "doc_" + String(docs.length + 1).padStart(32, "0");
      const abort = new AbortController();
      const record = {
        documentId: docid,
        options,
        frame: {},
        live: true,
        command(value) {
          events.push(["page-command", docid, value]);
          return record.live;
        },
        dispose() {
          record.live = false;
          abort.abort();
          events.push(["document-dispose", docid]);
        },
      };
      docs.push(record);
      events.push(["document-create", docid]);
      record.ready = (async () => {
        try {
          const source = await options.sourceProvider.prepare({
            documentId: docid,
            website: options.website,
            signal: abort.signal,
          });
          if (!record.live) throw Error("document disposed");
          await options.frameProvider.reserve({
            documentId: docid,
            website: source.url,
            signal: abort.signal,
          });
          await options.nativeResourceProvider.bind({
            documentId: docid,
            website: source.url,
            topLevelURL: source.url,
            contentPolicies: [...source.contentPolicies],
            coep: source.coep,
          });
          await options.storageProvider.bind({
            documentId: docid,
            website: source.url,
            sessionId: options.sessionId,
          });
          await options.cookieProvider.bind({
            documentId: docid,
            website: source.url,
          });
          const context = {
            documentId: docid,
            documentURL: source.url,
            origin: new URL(source.url).origin,
            signal: abort.signal,
          };
          await options.fetch(
            { url: source.url + "/data", headers: [], method: "GET" },
            context,
          );
          await options.webSocketConnect(
            "wss://" + new URL(source.url).host + "/socket",
            [],
            context,
            {},
          );
          if (contentFailure) options.onContentState("error", contentFailure);
          else options.onContentState("ready");
        } catch (error) {
          options.onContentState("error");
          throw error;
        }
      })();
      void record.ready.catch(() => {});
      return record;
    },
  };
  const make = (extra = {}) =>
    createFrontendBrowser({
      container,
      window: owner,
      components,
      timeoutMs: 1000,
      onState: (s) => states.push(s),
      ...extra,
    });
  let browser;
  t.after(() => browser?.dispose());
  return {
    events,
    owners,
    docs,
    fetchBindings,
    rewrites,
    owner,
    storage,
    states,
    control,
    components,
    make: async (extra) => (browser = await make(extra)),
    setSourceGate: (p) => (sourceGate = p),
    setSourceError: (v) => (sourceError = v),
    setContentFailure: (v) => (contentFailure = v),
    setCookieError: (v) => (cookieError = v),
    setNativeError: (v) => (nativeError = v),
    setNativeGate: (v) => (nativeGate = v),
    setMissingTransform: (v) => (missingTransform = v),
  };
}
test("document boot failures preserve the trusted fixed diagnostic code instead of replacing it with a generic load failure", async (t) => {
  const f = fixture(t);
  f.setContentFailure({ stage: "graph", code: "RESOURCE_GRAPH_FAILED" });
  const browser = await f.make();
  await assert.rejects(browser.start("https://site.test/game"), {
    code: "RESOURCE_GRAPH_FAILED",
  });
  assert.equal(f.states.at(-1).code, "RESOURCE_GRAPH_FAILED");
  assert.equal(browser.document, undefined);
});
test("redirect final logical URL binds all capability providers before native resource/document access; website bytes use relay callback only", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/redirect");
  assert.equal(browser.document, f.docs[0]);
  assert.equal(f.fetchBindings[0].documentURL, "https://site.test/redirect");
  assert.equal(f.fetchBindings[1].documentURL, "https://site.test/final");
  assert.equal(
    f.events.find((e) => e[0] === "frame-reserve")[1],
    "https://site.test/final",
  );
  assert.equal(
    f.events.find((e) => e[0] === "storage-bind")[1].website,
    "https://site.test/final",
  );
  assert.equal(
    f.events.find((e) => e[0] === "storage-bind")[1].sessionId,
    browser.tabSessionId,
  );
  assert.equal(f.rewrites[0].documentURL, "https://site.test/final");
  assert.ok(f.events.some((e) => e[0] === "transform"));
  assert.ok(
    f.events
      .filter((e) => e[0] === "control")
      .every((e) => e[1].startsWith("/api/browse/controller/")),
  );
  assert.ok(f.events.some((e) => e[0] === "website-socket"));
});
test("ordinary credential renewal neither remounts document nor recreates durable/cookie/native owners", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/game");
  const doc = browser.document,
    owners = [...f.owners];
  await browser.check();
  assert.equal(browser.document, doc);
  assert.equal(f.docs.length, 1);
  assert.equal(f.owners.length, owners.length);
  assert.ok(owners.every((o) => !o.disposed));
  const header = await owners
    .find((o) => o.kind === "storage")
    .options.registrationHeaders();
  assert.equal(header["x-atlas-browse-session"], browser.assignment.session);
});
test("committed assignment change revokes old document/providers then rebuilds with same durable namespace inputs and tab identity", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/redirect");
  const old = browser.document,
    owners = [...f.owners],
    tab = browser.tabSessionId;
  await browser.selectNode("nodeB", "csrf_fixture");
  assert.notEqual(browser.document, old);
  assert.equal(old.live, false);
  assert.ok(owners.every((o) => o.disposed));
  assert.equal(browser.tabSessionId, tab);
  assert.equal(browser.assignment.node.id, "nodeB");
  assert.equal(f.docs.at(-1).options.website, "https://site.test/final");
  const header = await f.owners
    .filter((o) => o.kind === "storage")
    .at(-1)
    .options.registrationHeaders();
  assert.equal(header["x-atlas-browse-session"], browser.assignment.session);
  await assert.rejects(
    async () =>
      owners.find((o) => o.kind === "storage").options.registrationHeaders(),
    { code: "FRONTEND_BROWSER_ASSIGNMENT_CHANGED" },
  );
});
test("new document navigation revokes old capabilities without recreating assignment owners", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/a");
  const old = browser.document,
    count = f.owners.length;
  await browser.navigate("https://other.test/b");
  assert.equal(old.live, false);
  assert.notEqual(browser.document.documentId, old.documentId);
  assert.equal(f.owners.length, count);
  assert.equal(f.docs.at(-1).options.website, "https://other.test/b");
});
test("late old navigation source never mounts capability providers after a newer navigation", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/a");
  let release;
  f.setSourceGate(new Promise((r) => (release = r)));
  const first = browser.navigate("https://site.test/old");
  await tick();
  const stale = f.docs.at(-1);
  f.setSourceGate(undefined);
  const next = browser.navigate("https://site.test/new");
  release();
  await assert.rejects(first);
  await next;
  assert.equal(stale.live, false);
  assert.equal(
    f.events.filter(
      (e) => e[0] === "frame-reserve" && e[1] === "https://site.test/old",
    ).length,
    0,
  );
  assert.equal(browser.document.options.website, "https://site.test/new");
});
test("partial owner initialization failure cleans fulfilled owners and creates no document", async (t) => {
  const f = fixture(t);
  f.setCookieError(true);
  const browser = await f.make();
  await assert.rejects(
    browser.start("https://site.test/game"),
    /cookie fixture failure/,
  );
  assert.equal(f.docs.length, 0);
  assert.equal(f.owners.find((o) => o.kind === "storage").disposed, true);
});
test("missing trusted native transform fails document closed instead of identity-transforming executable bytes", async (t) => {
  const f = fixture(t);
  f.setMissingTransform(true);
  const browser = await f.make();
  await assert.rejects(browser.start("https://site.test/game"));
  assert.equal(browser.document, undefined);
  assert.ok(f.states.some((s) => s.status === "error"));
});
test("tab sessionStorage identity survives full orchestrator recreation; different frontend sessionStorage gets new ID", async (t) => {
  const f = fixture(t),
    first = await f.make();
  const id = first.tabSessionId;
  first.dispose();
  const second = await f.make();
  assert.equal(second.tabSessionId, id);
  const other = fixture(t),
    third = await other.make();
  assert.notEqual(third.tabSessionId, id);
});
test("manifest rejects cross-origin/unhashed/missing trusted rewriter asset before importing any runtime", async () => {
  for (const bad of [
    { ...assets, trustedRewriter: "https://evil.test/a.js" },
    { ...assets, bootstrap: "/browse/assets/document.js" },
    { ...assets, trustedRewriter: undefined },
  ])
    await assert.rejects(
      loadFrontendRuntimeAssets(
        {
          location: { origin: "https://front.test" },
          fetch: async () => Response.json(bad),
        },
        new AbortController().signal,
      ),
      { code: "FRONTEND_RUNTIME_MANIFEST_INVALID" },
    );
});
test("frontend and assigned-node destinations are denied before creating a website frame", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/a");
  const count = f.docs.length;
  for (const url of [
    "https://front.test/private",
    "https://nodeA.test/native-resource/v1/owners",
    "javascript:alert(1)",
  ])
    await assert.rejects(browser.navigate(url), {
      code: "FRONTEND_BROWSER_DESTINATION_DENIED",
    });
  assert.equal(f.docs.length, count);
});
test("disposal aborts pending navigation, revokes all provider owners and stops coordinator", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/a");
  let release;
  f.setSourceGate(new Promise((r) => (release = r)));
  const navigation = browser.navigate("https://site.test/b");
  await tick();
  browser.dispose();
  release();
  await assert.rejects(navigation);
  assert.equal(browser.live, false);
  assert.equal(browser.document, undefined);
  assert.ok(f.owners.every((o) => o.disposed));
  assert.ok(f.events.some((e) => e[0] === "coordinator-stop"));
});

test("same-identity renewal while owners initialize coalesces the in-progress bundle", async (t) => {
  const f = fixture(t);
  let release;
  f.setNativeGate(new Promise((r) => (release = r)));
  const browser = await f.make(),
    starting = browser.start("https://site.test/a");
  await tick();
  const checking = browser.check();
  await tick();
  assert.equal(f.events.filter((e) => e[0] === "native-start").length, 1);
  release();
  await Promise.all([starting, checking]);
  assert.equal(f.docs.length, 1);
});
test("newest navigation during assignment owner replacement mounts once, including a source redirect", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/a");
  let release;
  f.setNativeGate(new Promise((r) => (release = r)));
  const changing = browser.selectNode("nodeB", "csrf_fixture");
  await tick();
  const navigating = browser.navigate("https://other.test/redirect");
  f.setNativeGate(undefined);
  release();
  await Promise.all([changing, navigating]);
  assert.equal(f.docs.length, 2);
  assert.equal(browser.document.options.website, "https://other.test/redirect");
  assert.equal(
    f.events.filter(
      (e) => e[0] === "frame-reserve" && e[1] === "https://other.test/final",
    ).length,
    1,
  );
  await assert.rejects(browser.navigate("https://nodeA.test/previous-owner"), {
    code: "FRONTEND_BROWSER_DESTINATION_DENIED",
  });
});
test("trusted rewriter module loading has a bounded deadline and never falls back to an identity transform", async (t) => {
  const f = fixture(t);
  f.components.rewriter = () => new Promise(() => {});
  await assert.rejects(f.make({ timeoutMs: 10 }), {
    code: "FRONTEND_RUNTIME_LOAD_TIMEOUT",
  });
  assert.equal(f.owners.length, 0);
  assert.equal(f.docs.length, 0);
});

test("a terminal native owner is rebuilt on authoritative validation of the SAME assignment without allocating another session", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  await browser.start("https://site.test/a");
  const old = browser.document,
    assignment = browser.assignment.session,
    tab = browser.tabSessionId;
  f.owners.find((o) => o.kind === "native").dispose();
  await browser.check();
  assert.notEqual(browser.document, old);
  assert.equal(browser.assignment.session, assignment);
  assert.equal(browser.tabSessionId, tab);
  assert.equal(f.docs.length, 2);
});

test("trusted shell connect establishes owners and assignment without any website document; concurrent connect/start coalesce", async (t) => {
  const f = fixture(t),
    browser = await f.make();
  const assignment = await browser.connect();
  assert.equal(assignment, browser.assignment);
  assert.equal(f.docs.length, 0);
  assert.equal(browser.document, undefined);
  const owners = f.owners.length;
  await Promise.all([browser.connect(), browser.start("https://site.test/a")]);
  assert.equal(f.docs.length, 1);
  assert.equal(f.owners.length, owners);
});

test("Page controls bind commands/telemetry to the current document and replace child diagnostic content with the trusted log", async (t) => {
  const f = fixture(t),
    telemetry = [],
    browser = await f.make({ onTelemetry: (event) => telemetry.push(event) });
  await browser.start("https://site.test/a");
  const old = browser.document;
  assert.equal(
    browser.pageCommand({
      type: "compatibility-config",
      metadata: false,
      diagnostics: true,
    }),
    true,
  );
  old.options.onTelemetry({
    type: "compatibility-diagnostics",
    report: {
      version: 1,
      active: true,
      entries: [{ secret: "child selected content" }],
    },
  });
  assert.equal(
    JSON.stringify(telemetry).includes("child selected content"),
    false,
  );
  assert.ok(
    telemetry[0].report.entries.some(
      (entry) =>
        entry.event === "document" && entry.origin === "https://site.test",
    ),
  );
  await browser.navigate("https://other.test/b");
  const count = telemetry.length;
  old.options.onTelemetry({ type: "title", title: "stale document" });
  assert.equal(telemetry.length, count);
  browser.document.options.onTelemetry({
    type: "title",
    title: "Current document",
  });
  assert.equal(telemetry.at(-1).title, "Current document");
  assert.throws(
    () =>
      browser.pageCommand({
        type: "compatibility-config",
        metadata: true,
        diagnostics: true,
        url: "https://peer.test",
      }),
    { code: "FRONTEND_PAGE_COMMAND_INVALID" },
  );
  browser.dispose();
  assert.equal(browser.pageCommand({ type: "compatibility-export" }), false);
});
