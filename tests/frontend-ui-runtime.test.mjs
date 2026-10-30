import test from "node:test";
import assert from "node:assert/strict";
import {
  setActiveProfile,
  setActiveProfileContext,
  setProfileDocumentGuard,
} from "../runtime/profile-context.ts";
import {
  frontendRuntimeEnabled,
  createFrontendWorkspace,
  claimFrontendWindow,
  clearFrontendWebsiteData,
} from "../web/src/frontend-runtime.ts";
const tick = () => new Promise((r) => setImmediate(r));
const storage = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};
function ownerFixture() {
  const held = new Set();
  const locks = {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  const owner = {
    BroadcastChannel: class {
      constructor(name) {
        this.name = name;
      }
      close() {}
    },
    crypto: globalThis.crypto,
    location: { origin: "https://front.test" },
    navigator: { locks },
    sessionStorage: storage(),
    localStorage: storage(),
    document: undefined,
  };
  const document = {
    defaultView: owner,
    createElement() {
      return {
        ownerDocument: document,
        style: {},
        dataset: {},
        hidden: false,
        remove() {
          this.removed = true;
        },
      };
    },
  };
  owner.document = document;
  const container = {
    ownerDocument: document,
    children: [],
    appendChild(element) {
      this.children.push(element);
    },
  };
  return { owner, container, held };
}
test("transport cache and channel belong to branch sign-in context, not just stable profile", async (t) => {
  const id = "11111111-1111-4111-8111-111111111111";
  setActiveProfile(id);
  setActiveProfileContext("first-signin");
  setProfileDocumentGuard(async () => {});
  t.after(() => {
    setActiveProfile(null);
    setActiveProfileContext(undefined);
    setProfileDocumentGuard(undefined);
  });
  const first = fixture(t);
  await first.workspace.navigate("one", "https://site.test/");
  await tick();
  await tick();
  const before = first.browsers[0].options.coordinatorOptions;
  before.storage.setItem("atlas.frontendAssignment.v2", "old-session");
  assert.match(before.channelName, /:first-signin$/);
  assert.equal(before.channel, undefined, "the master constructs its own fresh channel on demand");
  setActiveProfileContext("second-signin");
  const second = fixture(t);
  second.owner.localStorage = first.owner.localStorage;
  await second.workspace.navigate("two", "https://site.test/");
  await tick();
  await tick();
  const after = second.browsers[0].options.coordinatorOptions;
  assert.equal(after.storage.getItem("atlas.frontendAssignment.v2"), null);
  assert.notEqual(after.channelName, before.channelName);
  assert.equal(
    before.storage.getItem("atlas.frontendAssignment.v2"),
    "old-session",
  );
});
function fixture(t, extra = {}) {
  const f = ownerFixture(),
    browsers = [],
    events = [],
    assignments = [],
    states = [];
  const workspace = createFrontendWorkspace({
    container: f.container,
    onEvent: (event) => events.push(event),
    onAssignment: (a) => assignments.push(a),
    onConnection: (s) => states.push(s),
    createBrowser: async (options) => {
      const browser = {
        options,
        calls: [],
        disposed: false,
        document: { frame: { sandbox: "allow-scripts" } },
        pageCommand(value) {
          browser.calls.push(["page-command", value]);
          return !browser.disposed;
        },
        async connect() {
          browser.calls.push(["connect"]);
          options.onAssignment?.({
            assignment: {
              node: { id: "pinA", name: "Node A" },
              session: "a".repeat(43),
            },
          });
        },
        async start(url) {
          browser.calls.push(["start", url]);
          options.onLocation?.(url);
          options.onState?.({ status: "ready" });
        },
        async navigate(url) {
          browser.calls.push(["navigate", url]);
          options.onLocation?.(url);
          options.onState?.({ status: "ready" });
        },
        async reconnect() {
          browser.calls.push(["reconnect"]);
        },
        async check() {
          browser.calls.push(["check"]);
        },
        async selectNode(id, csrf) {
          browser.calls.push(["select", id, csrf]);
          return { node: { id } };
        },
        dispose() {
          browser.disposed = true;
        },
      };
      browsers.push(browser);
      return browser;
    },
    ...extra,
  });
  t.after(() => workspace.dispose());
  return { ...f, workspace, browsers, events, assignments, states };
}
test("activation requires exact version and explicit true; settings and URL-shaped flags do not enable it", () => {
  for (const value of [
    null,
    {},
    { opaqueRuntimeEnabled: true },
    { runtimeProtocols: { opaque: { version: 1, activated: true } } },
    { runtimeProtocols: { opaque: { version: 2, activated: "true" } } },
    { runtimeProtocols: { opaque: { version: 2, activated: false } } },
  ])
    assert.equal(frontendRuntimeEnabled(value), false);
  assert.equal(
    frontendRuntimeEnabled({
      runtimeProtocols: { opaque: { version: 2, activated: true } },
    }),
    true,
  );
});
test("window identity survives a released reload, but a duplicate sessionStorage snapshot receives a new live owner", async () => {
  const f = ownerFixture(),
    original = await claimFrontendWindow(f.owner);
  const clone = { ...f.owner, sessionStorage: storage() };
  clone.sessionStorage.setItem("atlas.frontendWindow.v2", original.id);
  const duplicate = await claimFrontendWindow(clone);
  assert.notEqual(duplicate.id, original.id);
  assert.equal(
    clone.sessionStorage.getItem("atlas.frontendWindow.v2"),
    duplicate.id,
  );
  original.dispose();
  await tick();
  const reloaded = await claimFrontendWindow(f.owner);
  assert.equal(reloaded.id, original.id);
  duplicate.dispose();
  reloaded.dispose();
  await tick();
  assert.equal(f.held.size, 0);
});
test("Home connects without website navigation; trusted tab identities differ and activation retains existing bindings", async (t) => {
  const f = fixture(t);
  await f.workspace.connect();
  assert.deepEqual(f.browsers[0].calls, [["connect"]]);
  assert.equal(f.assignments[0].node.id, "pinA");
  await f.workspace.navigate("actual-app-tab-A", "https://site.test/a");
  await f.workspace.navigate("actual-app-tab-B", "https://site.test/b");
  assert.equal(f.browsers.length, 3);
  assert.match(f.browsers[1].options.tabSessionId, /^tab_[a-f0-9]{64}$/);
  assert.notEqual(
    f.browsers[1].options.tabSessionId,
    f.browsers[2].options.tabSessionId,
  );
  f.workspace.activate("actual-app-tab-A");
  assert.equal(f.container.children[1].hidden, false);
  assert.equal(f.container.children[2].hidden, true);
  assert.equal(f.workspace.frame, f.browsers[1].document.frame);
  assert.equal(f.browsers[1].disposed, false);
});
test("trusted navigation/back/forward/reload and original-URL redirects keep history independent for each tab", async (t) => {
  const f = fixture(t);
  await f.workspace.navigate("tab-A", "https://site.test/one");
  await f.workspace.command("navigate", {
    id: "tab-A",
    url: "https://site.test/two",
  });
  await f.workspace.command("back", { id: "tab-A" });
  await f.workspace.command("forward", { id: "tab-A" });
  await f.workspace.command("reload", { id: "tab-A" });
  const calls = f.browsers[0].calls.map((call) => call[1]);
  assert.deepEqual(calls, [
    "https://site.test/one",
    "https://site.test/two",
    "https://site.test/one",
    "https://site.test/two",
    "https://site.test/two",
  ]);
  f.browsers[0].options.onLocation("https://site.test/inside-page");
  await f.workspace.command("back", { id: "tab-A" });
  assert.equal(f.browsers[0].calls.at(-1)[1], "https://site.test/two");
  assert.ok(
    f.events.some(
      (e) => e.type === "navigation" && e.url.endsWith("inside-page"),
    ),
  );
});
test("explicit replacement is delegated to the active coordinator before peer validation; no legacy API is invoked", async (t) => {
  const f = fixture(t);
  await f.workspace.connect();
  await f.workspace.navigate("tab-A", "https://site.test/");
  await f.workspace.navigate("tab-B", "https://other.test/");
  const result = await f.workspace.selectNode("pinB", "trusted-csrf");
  assert.equal(result.node.id, "pinB");
  assert.deepEqual(f.browsers[2].calls.at(-1), [
    "select",
    "pinB",
    "trusted-csrf",
  ]);
  assert.deepEqual(f.browsers[1].calls.at(-1), ["check"]);
  await f.workspace.reconnect();
  assert.deepEqual(f.browsers[2].calls.at(-1), ["reconnect"]);
  assert.deepEqual(f.browsers[0].calls.at(-1), ["check"]);
});
test("popout explicit owner uses a hashed scoped cache and no global channel, even with another active global pin", async (t) => {
  const token = "b".repeat(43),
    f = fixture(t, { initialSession: token });
  f.owner.localStorage.setItem(
    "atlas.frontendAssignment.v2",
    "another-main-window-pin",
  );
  await f.workspace.connect();
  const config = f.browsers[0].options.coordinatorOptions;
  assert.deepEqual(config.initialSession, { session: token });
  assert.equal(config.channel, false);
  assert.equal(config.storage.getItem("atlas.frontendAssignment.v2"), null);
  config.storage.setItem("atlas.frontendAssignment.v2", "this-popout-pin");
  assert.equal(
    f.owner.localStorage.getItem("atlas.frontendAssignment.v2"),
    "another-main-window-pin",
  );
  const key = [...f.owner.localStorage.values.keys()].find((k) =>
    k.includes(".popout."),
  );
  assert.match(key, /^atlas\.frontendAssignment\.v2\.popout\.[a-f0-9]{64}$/);
  assert.equal(key.includes(token), false);
});
test("forbidden frontend/credentialed/non-web URLs create no browser or storage owner", async (t) => {
  const f = fixture(t);
  for (const url of [
    "https://front.test/api/admin",
    "https://user:pass@site.test/",
    "javascript:alert(1)",
  ])
    await assert.rejects(f.workspace.navigate("tab-A", url), {
      code: "FRONTEND_BROWSER_DESTINATION_DENIED",
    });
  assert.equal(f.browsers.length, 0);
});
test("close/dispose suppress late document callbacks and release window identity; unsupported commands are not sent to an opaque window", async (t) => {
  const f = fixture(t);
  await f.workspace.navigate("tab-A", "https://site.test/");
  await assert.rejects(
    f.workspace.command("compatibility-config", { id: "tab-A" }),
    { code: "FRONTEND_CONTROL_NOT_IMPLEMENTED" },
  );
  const count = f.events.length;
  f.workspace.close("tab-A");
  f.browsers[0].options.onLocation("https://site.test/late");
  assert.equal(f.events.length, count);
  assert.equal(f.browsers[0].disposed, true);
  f.workspace.dispose();
  await tick();
  assert.equal(f.held.size, 0);
});
test("explicit website clear deletes only fresh v2 browser namespaces, never Atlas/admin/legacy databases", async () => {
  const deleted = [],
    owner = {
      indexedDB: {
        databases: async () => [
          { name: "admin" },
          { name: "atlas.settings" },
          { name: "legacy-scramjet" },
          { name: "atlas.browsing.idb.v2:site/db" },
        ],
        deleteDatabase(name) {
          const request = {};
          deleted.push(name);
          queueMicrotask(() => request.onsuccess());
          return request;
        },
      },
    };
  await clearFrontendWebsiteData(owner);
  assert.deepEqual(deleted.sort(), [
    "atlas.browsing.cookies.v2",
    "atlas.browsing.idb.v2:site/db",
    "atlas.browsing.v2",
  ]);
});

test("Page options filter all-site preferences into current logical origin booleans and keep telemetry on trusted subscriptions", async (t) => {
  const f = fixture(t);
  await f.workspace.navigate("tab-A", "https://site.test/");
  const endpoint = f.workspace.pageControls("tab-A"),
    events = [];
  const unsubscribe = endpoint.subscribe((event) => events.push(event));
  endpoint.send("compatibility-config", {
    sites: { "https://site.test": true, "https://peer.test": true },
    diagnostics: true,
  });
  await tick();
  assert.deepEqual(f.browsers[0].calls.at(-1), [
    "page-command",
    { type: "compatibility-config", metadata: true, diagnostics: true },
  ]);
  f.browsers[0].options.onTelemetry({
    type: "compatibility-status",
    origin: "https://site.test",
    rule: "runtime-only-v1",
    applied: 0,
    risk: false,
    throttled: false,
  });
  assert.equal(events.at(-1).id, "tab-A");
  await f.workspace.navigate("tab-A", "https://other.test/");
  await tick();
  assert.deepEqual(f.browsers[0].calls.at(-1), [
    "page-command",
    { type: "compatibility-config", metadata: false, diagnostics: true },
  ]);
  endpoint.send("compatibility-export");
  await tick();
  assert.deepEqual(f.browsers[0].calls.at(-1), [
    "page-command",
    { type: "compatibility-export" },
  ]);
  const before = events.length;
  unsubscribe();
  f.browsers[0].options.onTelemetry({ type: "title", title: "Updated" });
  assert.equal(events.length, before);
});

test("profile-backed same-origin requires its own exact activated version2 capability", () => {
  assert.equal(frontendRuntimeEnabled({runtimeProtocols:{profile:{version:2,activated:true,documentOrigin:"same-origin"},opaque:{version:2,activated:false}}}), true);
  for (const profile of [{version:1,activated:true,documentOrigin:"same-origin"},{version:2,activated:false,documentOrigin:"same-origin"},{version:2,activated:true,documentOrigin:"opaque"},{version:2,activated:"true",documentOrigin:"same-origin"},{version:2,activated:true}])
    assert.equal(frontendRuntimeEnabled({runtimeProtocols:{profile}}), false);
});

test("normal controller toolbar traverses its mounted frame history without a new navigation or allocation", async (t) => {
  const f = fixture(t);
  await f.workspace.navigate("normal", "https://site.test/start");
  const browser = f.browsers[0];
  browser.historyCommand = (type) => { browser.calls.push(["native-history", type]); return true; };
  const before = browser.calls.filter(([type]) => ["start", "navigate", "connect"].includes(type));
  await f.workspace.command("back");
  await f.workspace.command("forward");
  await f.workspace.command("reload");
  assert.deepEqual(browser.calls.filter(([type]) => type === "native-history"), [["native-history", "back"], ["native-history", "forward"], ["native-history", "reload"]]);
  assert.deepEqual(browser.calls.filter(([type]) => ["start", "navigate", "connect"].includes(type)), before);
  assert.equal(browser.disposed, false);
});

test("normal controller popup aliases preserve one owner, events, native controls and live children when the opener closes", async (t) => {
  const f = fixture(t);
  await f.workspace.navigate("opener", "https://site.test/start");
  const browser = f.browsers[0];
  browser.runtimeCommand = (type, id, extra = {}) => { browser.calls.push(["runtime",type,id,extra]); return true; };
  await f.workspace.command("panic-key", { key: "escape" });
  browser.options.onRuntimeEvent({type:"popup-created",id:"popup",url:"about:blank"});
  await tick();
  assert.equal(f.events.at(-1).type,"popup-created");
  assert.equal(f.events.at(-1).openerId,"opener");
  browser.options.onRuntimeEvent({type:"navigation",id:"popup",url:"https://oauth.test/authorize"});
  browser.options.onRuntimeEvent({type:"title",id:"popup",title:"Sign in"});
  browser.options.onRuntimeEvent({type:"favicon",id:"popup",favicon:"data:image/png;base64,AA=="});
  browser.options.onRuntimeEvent({type:"focus-search",id:"popup"});
  browser.options.onRuntimeEvent({type:"panic",id:"popup",key:"escape"});
  assert.deepEqual(f.events.slice(-5).map(event=>event.type),["navigation","title","favicon","focus-search","panic"]);
  await f.workspace.command("back",{id:"popup"});
  await f.workspace.command("reload",{id:"popup"});
  await f.workspace.navigate("popup","https://oauth.test/return");
  assert.equal(f.browsers.length,1);
  assert.equal(browser.calls.filter(call=>call[0]==="start").length,1);
  assert.equal(browser.calls.filter(call=>call[0]==="navigate").length,0);
  assert.ok(browser.calls.some(call=>call[0]==="runtime"&&call[1]==="back"&&call[2]==="popup"));
  assert.ok(browser.calls.some(call=>call[0]==="runtime"&&call[1]==="navigate"&&call[2]==="popup"&&call[3].url==="https://oauth.test/return"));
  f.workspace.close("opener"); await tick();
  assert.equal(browser.disposed,false);
  f.workspace.activate("popup"); await tick();
  assert.equal(f.container.children[0].hidden,false);
  assert.equal(f.workspace.frame,browser.document.frame);
  f.workspace.close("popup"); await tick();
  assert.equal(browser.disposed,true);
});
