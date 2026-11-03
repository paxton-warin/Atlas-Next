import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let helper;
try {
  helper = require("./replace-links.browser.cjs");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = (n, host, enabled = true) => ({
  id: id(n),
  url: `https://${host}.cloudfront.net/`,
  name: host,
  enabled,
  used: 2,
  open_reports: 1,
});
const old = [link(1, "dold"), link(2, "dkeep")];
const text =
  "Keep | https://dkeep.cloudfront.net\nNew | https://dnew.cloudfront.net/";
function api() {
  assert.ok(helper, "browser replacement helper is implemented");
  return helper;
}
function fixture(options = {}) {
  let rows = structuredClone(options.original ?? old);
  const calls = [],
    events = [],
    exports = [];
  let imports = 0,
    deleted = 0;
  const json = (value, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(value),
  });
  const fetch = async (route, init) => {
    calls.push([route, init]);
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.redirect, "error");
    if (route === "/api/session")
      return json({
        user: { role: options.role ?? "admin", status: "active" },
        csrfToken: "fixture-csrf",
      });
    if (route === "/api/admin/links" && init.method === "GET") {
      if (imports && options.changedOld)
        rows = rows.map((r) =>
          r.id === id(1)
            ? { ...r, url: "https://dchanged.cloudfront.net/" }
            : r,
        );
      return json({
        links: options.badSnapshot ? [{ ...old[0], id: "../bad" }] : rows,
      });
    }
    assert.equal(init.headers["x-csrf-token"], "fixture-csrf");
    if (route === "/api/admin/links/bulk") {
      imports++;
      if (options.importStatus)
        return json(
          { error: { message: "secret upstream details" } },
          options.importStatus,
        );
      if (!options.missingImported && !rows.some((r) => r.id === id(3)))
        rows.push(link(3, "dnew", !options.disabledImported));
      if (options.addConcurrent) rows.push(link(4, "dconcurrent"));
      return json(
        options.malformedImport
          ? {}
          : {
              inserted: [{ id: id(3), url: "https://dnew.cloudfront.net/" }],
              skipped: ["https://dkeep.cloudfront.net/"],
            },
      );
    }
    if (init.method === "DELETE") {
      if (options.deleteStatus && deleted >= (options.deleteStatusAfter ?? 0))
        return json({}, options.deleteStatus);
      const target = route.split("/").pop();
      rows = rows.filter((r) => r.id !== target);
      deleted++;
      return json({ ok: true, deleted: true, assignments: 2, reports: 1 });
    }
    throw new Error("Unexpected route");
  };
  return {
    calls,
    events,
    exports,
    getRows: () => rows,
    getDeleted: () => deleted,
    input: {
      text,
      fetch,
      download: async (value) => {
        if (options.downloadFails) throw new Error("download denied");
        exports.push(value);
      },
      confirm: async (summary) => {
        events.push(["confirm", summary]);
        return !options.cancel;
      },
      sleep: async (ms) => events.push(["sleep", ms]),
      report: (event) => events.push(["report", event]),
    },
  };
}
test("parses named or bare CloudFront frontend roots and canonicalizes", () => {
  assert.deepEqual(
    api()
      .parseImport(text)
      .map((v) => v.url),
    ["https://dkeep.cloudfront.net/", "https://dnew.cloudfront.net/"],
  );
  assert.equal(
    api().parseImport("https://dnew.cloudfront.net")[0].name,
    "dnew.cloudfront.net",
  );
});
test("rejects zero, duplicate, oversized and non-frontend-shaped inputs", () => {
  for (const value of [
    "",
    "\n ",
    "http://dnew.cloudfront.net",
    "https://example.com",
    "https://a:b@dnew.cloudfront.net",
    "https://dnew.cloudfront.net/node",
    "https://dnew.cloudfront.net/?ticket=x",
    "https://dnew.cloudfront.net/#token",
    "https://dnew.cloudfront.net\nhttps://dnew.cloudfront.net/",
  ])
    assert.throws(() => api().parseImport(value));
  assert.throws(() =>
    api().parseImport(
      Array.from(
        { length: 5001 },
        (_, i) => `https://d${i}.cloudfront.net`,
      ).join("\n"),
    ),
  );
});
test("planner deletes exact original IDs absent replacement, preserving overlaps", () => {
  const plan = api().planReplacement(old, api().parseImport(text));
  assert.deepEqual(
    plan.remove.map((x) => x.id),
    [id(1)],
  );
  assert.equal(plan.keep.length, 1);
});
test("imports, verifies supply, then deletes reviewed IDs only", async () => {
  const f = fixture({ addConcurrent: true });
  const result = await api().replaceLinks(f.input);
  assert.equal(result.outcome, "complete");
  assert.equal(result.deleted, 1);
  assert.equal(f.exports.length, 1);
  assert.equal(f.exports[0].links.length, 2);
  assert.ok(
    f.calls.findIndex((x) => x[0].endsWith("/bulk")) <
      f.calls.findIndex((x) => x[1].method === "DELETE"),
  );
  assert.deepEqual(
    f.getRows().map((r) => r.id),
    [id(2), id(3), id(4)],
  );
  assert.equal(
    f.events.find((e) => e[0] === "confirm")[1].confirmation,
    "REPLACE 1 WITH 2",
  );
});
test("admin authorization is required before mutation/export", async () => {
  const f = fixture({ role: "user" });
  await assert.rejects(api().replaceLinks(f.input), /active administrator/);
  assert.equal(f.exports.length, 0);
  assert.equal(f.calls.length, 1);
});
test("cancel after export performs no mutation", async () => {
  const f = fixture({ cancel: true });
  const result = await api().replaceLinks(f.input);
  assert.equal(result.outcome, "cancelled");
  assert.equal(f.exports.length, 1);
  assert.ok(f.calls.every((x) => x[1].method === "GET"));
});
test("failed snapshot download prevents import and deletion", async () => {
  const f = fixture({ downloadFails: true });
  await assert.rejects(api().replaceLinks(f.input), /snapshot/);
  assert.ok(f.calls.every((x) => x[1].method === "GET"));
});
test("bad snapshot IDs are rejected", async () => {
  const f = fixture({ badSnapshot: true });
  await assert.rejects(api().replaceLinks(f.input), /snapshot/);
  assert.equal(f.exports.length, 0);
});
for (const option of [
  "missingImported",
  "disabledImported",
  "malformedImport",
  "changedOld",
])
  test(`${option} aborts without deleting originals`, async () => {
    const f = fixture({ [option]: true });
    await assert.rejects(api().replaceLinks(f.input));
    assert.equal(f.getDeleted(), 0);
  });
test("import HTTP failure stops without deletion or sensitive error text", async () => {
  const f = fixture({ importStatus: 500 });
  await assert.rejects(
    api().replaceLinks(f.input),
    (e) => /HTTP 500/.test(e.message) && !/secret/.test(e.message),
  );
  assert.equal(f.getDeleted(), 0);
});
test("deletion 429 aborts without auto-retry", async () => {
  const f = fixture({ deleteStatus: 429 });
  await assert.rejects(
    api().replaceLinks(f.input),
    (e) => e.progress.deleted === 0 && /HTTP 429/.test(e.message),
  );
  assert.equal(f.calls.filter((x) => x[1].method === "DELETE").length, 1);
});
test("rerunning a completed replacement does not delete desired or new links", async () => {
  const f = fixture();
  await api().replaceLinks(f.input);
  const deletes = f.getDeleted();
  await api().replaceLinks(f.input);
  assert.equal(f.getDeleted(), deletes);
});

test("partial deletion failure reports completed counts and preserves untouched originals", async () => {
  const f = fixture({
    original: [link(1, "dold"), link(2, "dkeep"), link(5, "dother")],
    deleteStatus: 429,
    deleteStatusAfter: 1,
  });
  await assert.rejects(
    api().replaceLinks(f.input),
    (error) =>
      error.progress.deleted === 1 &&
      error.progress.assignmentsDeleted === 2 &&
      error.progress.imported === 1,
  );
  assert.deepEqual(
    f.getRows().map((row) => row.id),
    [id(2), id(5), id(3)],
  );
  assert.equal(f.calls.filter((call) => call[1].method === "DELETE").length, 2);
});
test("invalid input fails before any network request", async () => {
  const f = fixture();
  await assert.rejects(api().replaceLinks({ ...f.input, text: "" }));
  assert.equal(f.calls.length, 0);
});
test("large supported imports retain every URL and normalization preserves BOM input", () => {
  assert.equal(
    api().parseImport(
      Array.from(
        { length: 5000 },
        (_, i) => `https://d${i}.cloudfront.net`,
      ).join("\n"),
    ).length,
    5000,
  );
  assert.equal(
    api().parseImport("\uFEFFhttps://dnew.cloudfront.net")[0].url,
    "https://dnew.cloudfront.net/",
  );
});
