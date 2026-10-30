import test from "node:test";
import assert from "node:assert/strict";
import {
  restoreWindowTabs,
  orderTabs,
  moveTab,
  adjacentTab,
  windowTabsKey,
} from "../web/src/tab-state.ts";
const tab = (id, extra = {}) => ({
  id,
  url: `https://${id}.example/`,
  title: id,
  engine: "runtime",
  status: "ready",
  workspace: "browser",
  ...extra,
});
test("display reorder leaves mounted tab array, identities, and website state untouched", () => {
  const tabs = [tab("a"), tab("b"), tab("c")];
  const identity = tabs[1];
  const order = moveTab(tabs, [], "c", "a");
  assert.deepEqual(
    orderTabs(tabs, order).map((t) => t.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    tabs.map((t) => t.id),
    ["a", "b", "c"],
  );
  assert.equal(orderTabs(tabs, order)[2], identity);
});
test("pin boundaries and workspace boundaries are explicit, not drag side effects", () => {
  const tabs = [
    tab("p", { pinned: true }),
    tab("a"),
    tab("b", { workspace: "ai" }),
  ];
  const order = ["p", "a", "b"];
  assert.equal(moveTab(tabs, order, "a", "p"), order);
  assert.equal(moveTab(tabs, order, "a", "b"), order);
  assert.equal(adjacentTab(tabs, order, "a", -1), undefined);
});
test("window restoration validates URLs, deduplicates IDs, keeps pins/order and active", () => {
  const value = restoreWindowTabs({
    tabs: [
      tab("a", { pinned: true }),
      tab("a"),
      tab("b"),
      tab("x", { url: "javascript:alert(1)" }),
      tab("y", { url: "https://name:secret@example.com" }),
    ],
    order: ["b", "a", "ghost", "b"],
    active: "b",
  });
  assert.deepEqual(
    value.tabs.map((t) => t.id),
    ["a", "b"],
  );
  assert.equal(value.tabs[0].pinned, true);
  assert.deepEqual(value.order, ["b", "a"]);
  assert.equal(value.active, "b");
});
test("legacy restoration never truncates a new window over a different window", () => {
  const first = { name: "" },
    second = { name: "" };
  const a = windowTabsKey(first),
    b = windowTabsKey(second);
  assert.notEqual(a, b);
  assert.equal(windowTabsKey(first), a);
});
test("recognized local games restore, traversal and arbitrary frontend URLs do not", () => {
  const value = restoreWindowTabs([
    tab("game", { local: true, url: "/games/2048/index.html" }),
    tab("bad", { local: true, url: "/games/../api/config" }),
    tab("internal", { local: true, url: "/api/config" }),
  ]);
  assert.deepEqual(
    value.tabs.map((t) => t.id),
    ["game"],
  );
});
test("drag insertion can reach the end without implicitly crossing pin boundaries", () => {
  const tabs = [tab("a"), tab("b"), tab("c")];
  assert.deepEqual(moveTab(tabs, [], "a", "c", true), ["b", "c", "a"]);
  assert.deepEqual(
    tabs.map((t) => t.id),
    ["a", "b", "c"],
  );
});

// The last-window fallback is presentation data only. All readers enumerate
// logical names within the caller's already selected account namespace.
import * as tabState from "../web/src/tab-state.ts";
const restoreLatest = (...args) => tabState.restoreLatestWindowTabs(...args);
const windowKey = n => "atlas.windows.v1." + String(n).padStart(8, "0") + "-0000-4000-8000-000000000001";
const savedWindow = (id, updatedAt, extra = {}) => ({ version: 1, tabs: [tab(id)], order: [id], active: id, ...(updatedAt === undefined ? {} : { updatedAt }), ...extra });
function savedFixture(values, keys = Object.keys(values)) {
  const reads = [], listed = [];
  return { read: key => { reads.push(key); return values[key] ?? null; }, list: () => { listed.push(true); return keys; }, reads, listed };
}

test("an existing window restores its own snapshot before a newer peer window", () => {
  const f = savedFixture({ [windowKey(1)]: savedWindow("a", 10), [windowKey(2)]: savedWindow("b", 20) });
  const restored = restoreLatest(windowKey(1), f.read, f.list);
  assert.deepEqual(restored.tabs.map(t => t.id), ["a"]);
  assert.deepEqual(f.reads, [windowKey(1)]);
  assert.equal(f.listed.length, 0);
});

test("closing and reopening with a new window identity restores the latest saved window", () => {
  const f = savedFixture({ [windowKey(1)]: savedWindow("a", 10), [windowKey(2)]: savedWindow("b", 20) });
  const restored = restoreLatest(windowKey(3), f.read, f.list);
  assert.deepEqual(restored.tabs.map(t => t.id), ["b"]);
  assert.equal(restored.updatedAt, 20);
  assert.equal(restored.active, "b");
});

test("a deliberately empty own window never resurrects another window's tabs", () => {
  const empty = savedWindow("unused", 1, { tabs: [], order: [], active: "" });
  const f = savedFixture({ [windowKey(1)]: empty, [windowKey(2)]: savedWindow("b", 999), "atlas.tabs": [tab("legacy")] });
  assert.deepEqual(restoreLatest(windowKey(1), f.read, f.list).tabs, []);
  assert.deepEqual(f.reads, [windowKey(1)]);
});

test("a latest empty snapshot is a close-all action, not permission to revive older tabs", () => {
  const f = savedFixture({ [windowKey(1)]: savedWindow("a", 10), [windowKey(2)]: savedWindow("unused", 20, { tabs: [], order: [], active: "" }), "atlas.tabs": [tab("legacy")] });
  assert.deepEqual(restoreLatest(windowKey(3), f.read, f.list).tabs, []);
});

test("timestamp ties choose the same lexical window key regardless of enumeration order", () => {
  const values = { [windowKey(1)]: savedWindow("a", 20), [windowKey(2)]: savedWindow("b", 20) };
  for (const keys of [Object.keys(values), Object.keys(values).reverse(), [windowKey(2), windowKey(1), windowKey(2)]]) {
    const f = savedFixture(values, keys);
    assert.equal(restoreLatest(windowKey(3), f.read, f.list).active, "a");
  }
});

test("untimestamped old window snapshots have a deterministic fallback before atlas.tabs", () => {
  const values = { [windowKey(2)]: savedWindow("b"), [windowKey(1)]: savedWindow("a"), "atlas.tabs": [tab("legacy")] };
  const f = savedFixture(values);
  assert.equal(restoreLatest(windowKey(3), f.read, f.list).active, "a");
});

test("valid timestamped windows outrank untimestamped legacy windows", () => {
  const f = savedFixture({ [windowKey(1)]: savedWindow("old"), [windowKey(2)]: savedWindow("new", 1) });
  assert.equal(restoreLatest(windowKey(3), f.read, f.list).active, "new");
});

test("legacy atlas.tabs still restores when no valid window snapshot exists", () => {
  const f = savedFixture({ "atlas.tabs": [tab("legacy", { pinned: true })] });
  const restored = restoreLatest(windowKey(3), f.read, f.list);
  assert.deepEqual(restored.tabs.map(t => t.id), ["legacy"]);
  assert.equal(restored.tabs[0].pinned, true);
});

test("disabled restore performs no storage reads or enumeration", () => {
  const deny = () => assert.fail("restore-off must not read account state");
  assert.deepEqual(restoreLatest(windowKey(1), deny, deny, false), restoreWindowTabs([]));
});

test("only exact logical UUID window names are read, never other accounts or credentials", () => {
  const valid = windowKey(1), invalid = ["atlas.windows.v1.bad", "atlas.windows.v1.------------------------------------", valid + ".extra", "atlas.profile.user:other:" + valid, "atlas.settings", "session", "__proto__"];
  const f = savedFixture({ [valid]: savedWindow("safe", 1) }, [...invalid, valid]);
  assert.equal(restoreLatest(windowKey(3), f.read, f.list).active, "safe");
  assert.deepEqual(f.reads.sort(), [windowKey(3), valid].sort());
});

test("invalid current window keys are never used as arbitrary storage selectors", () => {
  const f = savedFixture({ [windowKey(1)]: savedWindow("safe", 1) });
  assert.equal(restoreLatest("atlas.settings", f.read, f.list).active, "safe");
  assert.deepEqual(f.reads, [windowKey(1)]);
});

test("malformed or unknown snapshots do not override a valid saved window", () => {
  const bad = [null, [], "bad", {}, { version: 2, tabs: [] }, { version: 1, tabs: "bad" }, savedWindow("bad", NaN), savedWindow("bad", Infinity), savedWindow("bad", -1), savedWindow("bad", 1.5), savedWindow("bad", "999"), savedWindow("bad", Number.MAX_SAFE_INTEGER + 1), savedWindow("bad", 999, { order: "bad" }), savedWindow("bad", 999, { active: {} }), savedWindow("bad", 999, { tabs: [tab("x", { url: "javascript:alert(1)" })] })];
  for (const value of bad) {
    const f = savedFixture({ [windowKey(1)]: value, [windowKey(2)]: savedWindow("safe", 1) });
    assert.equal(restoreLatest(windowKey(1), f.read, f.list).active, "safe");
  }
});

test("bad storage reads and enumeration failures cannot crash startup", () => {
  const f = savedFixture({ "atlas.tabs": [tab("legacy")] });
  assert.equal(restoreLatest(windowKey(1), f.read, () => { throw Error("Unavailable"); }).tabs[0].id, "legacy");
  assert.deepEqual(restoreLatest(windowKey(1), () => { throw Error("Unavailable"); }, () => [windowKey(1)]).tabs, []);
});

test("restoration keeps IDs, order, pins, games and workspaces without mutating any saved input", () => {
  const tabs = [tab("a", { pinned: true }), tab("game", { local: true, url: "/games/2048/index.html" }), tab("ai", { workspace: "ai" })];
  const value = { version: 1, tabs, order: ["game", "a", "ai"], active: "game", updatedAt: 42 };
  const before = JSON.stringify(value), f = savedFixture({ [windowKey(1)]: value });
  const restored = restoreLatest(windowKey(2), f.read, f.list);
  assert.deepEqual(restored.order, value.order);
  assert.deepEqual(restored.tabs.map(t => t.id), ["a", "game", "ai"]);
  assert.equal(restored.tabs[0].pinned, true);
  assert.equal(restored.tabs[1].local, true);
  assert.equal(restored.tabs[2].workspace, "ai");
  assert.equal(restored.active, "game");
  assert.equal(JSON.stringify(value), before);
  assert.notEqual(restored.tabs, value.tabs);
});

test("two account-owned window records remain independent while new cross-host contexts restore the acknowledged newest snapshot", () => {
  const profileA = { [windowKey(1)]: savedWindow("link-a", 10), [windowKey(2)]: savedWindow("link-b", 20) };
  const hydratedHostB = structuredClone(profileA);
  assert.equal(restoreLatest(windowKey(1), key => profileA[key], () => Object.keys(profileA)).active, "link-a");
  assert.equal(restoreLatest(windowKey(2), key => profileA[key], () => Object.keys(profileA)).active, "link-b");
  assert.equal(restoreLatest(windowKey(3), key => hydratedHostB[key], () => Object.keys(hydratedHostB)).active, "link-b");
  const unrelatedAccount = { [windowKey(4)]: savedWindow("other-account", 1000) };
  assert.equal(restoreLatest(windowKey(5), key => unrelatedAccount[key], () => Object.keys(unrelatedAccount)).active, "other-account");
  assert.equal(profileA[windowKey(1)].active, "link-a");
  assert.equal(profileA[windowKey(2)].active, "link-b");
});

test("title and operational status changes retain layout recency while preserving the full new payload", () => {
  const previous = savedWindow("a", 100), snapshot = { ...previous, tabs: [{ ...previous.tabs[0], title: "Latest page title", status: "loading", message: "Loading" }] };
  const before = JSON.stringify({ previous, snapshot });
  const result = tabState.timestampWindowTabs(snapshot, previous, 200);
  assert.equal(result.updatedAt, 100);
  assert.equal(result.tabs[0].title, "Latest page title");
  assert.equal(result.tabs[0].status, "loading");
  assert.equal(JSON.stringify({ previous, snapshot }), before);
});

test("IDs, addresses, pinning, workspaces, order and active-tab changes advance layout recency", () => {
  const previous = { version: 1, tabs: [tab("a"), tab("b")], order: ["a", "b"], active: "a", updatedAt: 100 };
  const variations = [
    { ...previous, tabs: [tab("new"), tab("b")], order: ["new", "b"], active: "new" },
    { ...previous, tabs: [tab("a", { url: "https://changed.example/" }), tab("b")] },
    { ...previous, tabs: [tab("a", { pinned: true }), tab("b")] },
    { ...previous, tabs: [tab("a", { workspace: "ai" }), tab("b")] },
    { ...previous, order: ["b", "a"] },
    { ...previous, active: "b" },
  ];
  for (const snapshot of variations) assert.equal(tabState.timestampWindowTabs(snapshot, previous, 200).updatedAt, 200);
});

test("new window keys never inherit a peer timestamp and close-all receives a fresh timestamp", () => {
  const fromPeer = savedWindow("a", 999);
  assert.equal(tabState.timestampWindowTabs(fromPeer, null, 200).updatedAt, 200);
  const empty = { version: 1, tabs: [], order: [], active: "" };
  assert.equal(tabState.timestampWindowTabs(empty, fromPeer, 1000).updatedAt, 1000);
  assert.equal(tabState.timestampWindowTabs(empty, null, 300).updatedAt, 300);
});

test("invalid clock values are rejected rather than creating unorderable recency metadata", () => {
  for (const now of [NaN, Infinity, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => tabState.timestampWindowTabs(savedWindow("a"), null, now), RangeError);
});

test("clock rollback cannot make a deliberate layout change older than its own prior snapshot", () => {
  const previous = savedWindow("a", 200), changed = savedWindow("b");
  assert.equal(tabState.timestampWindowTabs(changed, previous, 100).updatedAt, 201);
  assert.equal(tabState.timestampWindowTabs(previous, previous, 100).updatedAt, 200);
});
