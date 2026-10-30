import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const bundle = async (contents) =>
  (
    await build({
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      stdin: { resolveDir: resolve("runtime"), contents },
    })
  ).outputFiles[0].text;
const api =
    await bundle(`export{prepareLegacyCookiesToV2,LOCAL_COOKIE_PROFILE_MARKER}from'./local-cookie-migration-v2.ts';export{copyLegacySiteToV2}from'./local-legacy-migration-v2.ts';
 export{profileDatabaseName}from'./local-storage-names.ts';export{createLocalCookieOwnerV2}from'./sandbox-local-owners-v2.ts';export{createSandboxDocumentCookie}from'./sandbox-document-cookie.ts';`),
  worker = await bundle(`import'./cookie-native-worker-v2.ts';`),
  app = Fastify({ logger: false });
app.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Whole-profile cookie migration</title>"),
);
app.get("/api.js", (_q, r) => r.type("application/javascript").send(api));
app.get("/cookies.js", (_q, r) =>
  r.type("application/javascript").send(worker),
);
let browser;
const report = {
  command: "node tests/local-cookie-migration-v2-browser.mjs",
  productionChanged: false,
};
try {
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  report.browser = browser.version();
  const page = await browser.newPage();
  await page.goto(base);
  report.checks = await page.evaluate(async () => {
    const api = await import("/api.js"),
      legacy = "11111111-1111-4111-8111-111111111111",
      replica = "22222222-2222-4222-8222-222222222222",
      req = (r) =>
        new Promise((res, rej) => {
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        }),
      done = (t) =>
        new Promise((res, rej) => {
          t.oncomplete = res;
          t.onabort = () => rej(t.error);
        });
    function cookie(domain, site, name, value, httpOnly = false) {
      const c = {
        partition: null,
        domain,
        hostOnly: true,
        path: "/",
        name,
        value,
        httpOnly,
        secure: true,
        sameSite: "none",
        sessionId: "profile-" + legacy,
        expires: null,
        created: 1,
        accessed: 1,
        site,
      };
      return { ...c, id: JSON.stringify([null, domain, true, "/", name]) };
    }
    const rows = [
      cookie("a.example.com", "example.com", "aPref", "a"),
      cookie("login.other.test", "other.test", "session", "B-before", true),
      cookie("login.other.test", "other.test", "shared", "before"),
    ];
    async function seed(id, { missing = false, oversized = false } = {}) {
      const r = indexedDB.open(
        api.profileDatabaseName("atlas.browsing.cookies.v2", id),
        1,
      );
      r.onupgradeneeded = () => {
        r.result.createObjectStore("cookies", { keyPath: "id" });
        r.result.createObjectStore("meta");
      };
      const db = await req(r),
        t = db.transaction(["cookies", "meta"], "readwrite"),
        end = done(t),
        m = t.objectStore("meta");
      let bytes = 0;
      for (const row of rows) {
        const value = { ...row, sessionId: "profile-" + id },
          size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
        bytes += size;
        t.objectStore("cookies").put(value);
        if (!missing || row.name !== "session")
          m.put({ bytes: size, revision: 10 }, [
            "local-cookie-size-v2",
            row.id,
          ]);
      }
      m.put(10, "revision");
      m.put(
        {
          format: 2,
          scope: "complete-stored-jar",
          revision: 10,
          bytes: oversized ? 262145 : bytes,
          count: rows.length,
        },
        "local-cookie-migration-size-v2",
      );
      await end;
      db.close();
    }
    await seed(legacy);
    const first = await api.prepareLegacyCookiesToV2(
      indexedDB,
      legacy,
      replica,
    );
    const authority = {
        version: 2,
        profileId: legacy,
        replicaId: replica,
        localAuthGeneration: "generation_0123456789abcdef",
        browserSessionId: "session_0123456789abcdef",
      },
      a = await api.createLocalCookieOwnerV2({
        workerURL: "/cookies.js",
        localAuthority: authority,
      }),
      cross = {
        requestURL: "https://login.other.test/resource",
        documentURL: "https://a.example.com/",
        topLevelURL: "https://a.example.com/",
        credentials: "include",
      };
    const fromA = await a.getRequestHeader(cross);
    await a.storeResponseCookies(
      [
        "session=B-after; Secure; HttpOnly; SameSite=None; Path=/",
        "shared=after; Secure; SameSite=None; Path=/",
      ],
      cross,
    );
    const b = await api.createLocalCookieOwnerV2({
        workerURL: "/cookies.js",
        localAuthority: authority,
      }),
      binding = await b.bind({
        documentId: "popup_cookie_document_012345",
        website: "https://login.other.test/",
      }),
      popup = await api.createSandboxDocumentCookie({
        documentId: "popup_cookie_document_012345",
        endpoint: binding.endpoint,
        port: binding.port,
        window,
        localOnly: true,
      });
    const popupView = popup.get(),
      ctxB = {
        requestURL: "https://login.other.test/",
        documentURL: "https://login.other.test/",
        topLevelURL: "https://login.other.test/",
        credentials: "include",
      },
      fromB = await b.getRequestHeader(ctxB);
    popup.set("shared=popup-update; Secure; SameSite=None; Path=/");
    await new Promise((res) => setTimeout(res, 15));
    const backToA = await a.getRequestHeader(cross);
    const again = await api.prepareLegacyCookiesToV2(
        indexedDB,
        legacy,
        replica,
      ),
      afterAgain = await b.getRequestHeader(ctxB);
    const opened = await req(
        indexedDB.open(
          api.profileDatabaseName("atlas.browsing.cookies.v2", legacy),
        ),
      ),
      t = opened.transaction("cookies"),
      end = done(t),
      original = await req(t.objectStore("cookies").get(rows[1].id));
    await end;
    opened.close();
    popup.dispose();
    binding.dispose();
    a.dispose();
    b.dispose();
    const unknown = "33333333-3333-4333-8333-333333333333",
      unknownReplica = "44444444-4444-4444-8444-444444444444";
    await seed(unknown, { missing: true });
    const get = IDBObjectStore.prototype.get;
    let valueReads = 0;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "cookies") valueReads++;
      return get.call(this, key);
    };
    const refused = await api.prepareLegacyCookiesToV2(
        indexedDB,
        unknown,
        unknownReplica,
      ),
      siteRefused = await api.copyLegacySiteToV2(
        indexedDB,
        unknown,
        unknownReplica,
        "https://unrelated.example/",
      );
    IDBObjectStore.prototype.get = get;
    const oversized = "55555555-5555-4555-8555-555555555555";
    await seed(oversized, { oversized: true });
    const large = await api.prepareLegacyCookiesToV2(
      indexedDB,
      oversized,
      "66666666-6666-4666-8666-666666666666",
    );
    return {
      first,
      fromA,
      popupView,
      fromB,
      backToA,
      again,
      afterAgain,
      original: original.value,
      refused: refused.state,
      refusedReason: refused.reason,
      unrelatedSite: siteRefused.state,
      valueReads,
      oversized: large.state,
    };
  });
  const c = report.checks;
  assert.equal(c.first.state, "ready");
  assert.equal(c.first.cookieCount, 3);
  assert.ok(c.fromA.includes("session=B-before"));
  assert.ok(c.popupView.includes("shared=after"));
  assert.ok(!c.popupView.includes("session="));
  assert.ok(c.fromB.includes("session=B-after"));
  assert.ok(c.backToA.includes("shared=popup-update"));
  assert.ok(c.afterAgain.includes("session=B-after"));
  assert.ok(c.afterAgain.includes("shared=popup-update"));
  assert.equal(c.original, "B-before");
  assert.equal(c.refused, "deferred");
  assert.equal(c.unrelatedSite, "deferred");
  assert.equal(c.valueReads, 0);
  assert.equal(c.oversized, "deferred");
  // A distinct Chrome window must observe the same native cookie authority,
  // not merely another facade/worker living in this page's realm.
  const initialWindowHeader = await page.evaluate(async () => {
    const api = await import("/api.js");
    window.__crossCookieOwner = await api.createLocalCookieOwnerV2({
      workerURL: "/cookies.js",
      localAuthority: {
        version: 2,
        profileId: "11111111-1111-4111-8111-111111111111",
        replicaId: "22222222-2222-4222-8222-222222222222",
        localAuthGeneration: "generation_0123456789abcdef",
        browserSessionId: "session_0123456789abcdef",
      },
    });
    window.__crossCookieContext = {
      requestURL: "https://login.other.test/resource",
      documentURL: "https://a.example.com/",
      topLevelURL: "https://a.example.com/",
      credentials: "include",
    };
    return window.__crossCookieOwner.getRequestHeader(
      window.__crossCookieContext,
    );
  });
  const popupEvent = page.waitForEvent("popup");
  await page.evaluate(() => window.open("/?popup=b", "_blank"));
  const actualPopup = await popupEvent;
  await actualPopup.waitForLoadState();
  const actualPopupView = await actualPopup.evaluate(async () => {
    const api = await import("/api.js");
    const owner = await api.createLocalCookieOwnerV2({
      workerURL: "/cookies.js",
      localAuthority: {
        version: 2,
        profileId: "11111111-1111-4111-8111-111111111111",
        replicaId: "22222222-2222-4222-8222-222222222222",
        localAuthGeneration: "generation_0123456789abcdef",
        browserSessionId: "session_0123456789abcdef",
      },
    });
    const binding = await owner.bind({
      documentId: "actual_popup_document_012345",
      website: "https://login.other.test/",
    });
    const facade = await api.createSandboxDocumentCookie({
      documentId: "actual_popup_document_012345",
      endpoint: binding.endpoint,
      port: binding.port,
      window,
      localOnly: true,
    });
    const view = facade.get();
    facade.set("shared=window-popup-update; Secure; SameSite=None; Path=/");
    facade.dispose();
    binding.dispose();
    owner.dispose();
    return view;
  });
  await page.waitForTimeout(25);
  const afterWindowPopup = await page.evaluate(async () => {
    const header = await window.__crossCookieOwner.getRequestHeader(
      window.__crossCookieContext,
    );
    window.__crossCookieOwner.dispose();
    return header;
  });
  await actualPopup.close();
  assert.ok(initialWindowHeader.includes("shared=popup-update"));
  assert.ok(actualPopupView.includes("shared=popup-update"));
  assert.ok(!actualPopupView.includes("session="));
  assert.ok(afterWindowPopup.includes("session=B-after"));
  assert.ok(afterWindowPopup.includes("shared=window-popup-update"));
  report.actualChromePopup = {
    initialWindowHeader,
    actualPopupView,
    afterWindowPopup,
  };
  report.result = "PASS";
  console.log(
    "WHOLE_COOKIE_MIGRATION_V2 PASS A-to-B resource and popup share migrated jar; HttpOnly preserved; copy-once; unknown/oversized whole profile defer before value reads",
  );
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir("evidence/local-first-backups-20261028", { recursive: true });
  await writeFile(
    "evidence/local-first-backups-20261028/WHOLE_COOKIE_MIGRATION_V2_BROWSER.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await app.close();
}
