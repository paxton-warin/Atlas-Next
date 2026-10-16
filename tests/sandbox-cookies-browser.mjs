#!/usr/bin/env node
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import assert from "node:assert/strict";
const output = resolve(
  process.argv[2] ||
    "evidence/combined-update-20261015/sandbox-cookies-browser.json",
);
const executablePath =
  process.env.CHROME_PATH ||
  [
    "/Users/paxton/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find(existsSync);
if (!executablePath)
  throw Error("Set CHROME_PATH to a local Chromium executable.");
const app = Fastify({ logger: false });
let frontend;
app.get("/sandbox-cookies.js", (_req, reply) =>
  reply
    .header("Access-Control-Allow-Origin", "*")
    .type("application/javascript")
    .send(
      transpileModule(readFileSync("runtime/sandbox-cookies.ts", "utf8"), {
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module: ModuleKind.ESNext,
        },
      }).outputText.replace('from "tldts"', 'from "/tldts.js"'),
    ),
);
app.get("/tldts.js", (_req, reply) =>
  reply
    .header("Access-Control-Allow-Origin", "*")
    .type("application/javascript")
    .send(readFileSync("node_modules/tldts/dist/index.esm.min.js", "utf8")),
);
app.get("/child", (_req, reply) =>
  reply
    .header(
      "Content-Security-Policy",
      `sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline';frame-ancestors 'self';connect-src 'none'`,
    )
    .type("text/html")
    .send("<!doctype html><title>Opaque cookie fixture</title>"),
);
app.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Trusted cookie fixture</title>"),
);
await app.listen({ port: 0, host: "127.0.0.1" });
frontend = "http://127.0.0.1:" + app.server.address().port;
const receipt = {
  version: 1,
  command: "node tests/sandbox-cookies-browser.mjs",
  recordedAt: new Date().toISOString(),
  productionChanged: false,
  localOnly: true,
  generalRuntimeQualified: false,
  sourceSha256: createHash("sha256")
    .update(readFileSync("runtime/sandbox-cookies.ts"))
    .digest("hex"),
  pslPackage: "tldts@7.4.18",
  groups: [],
};
let browser;
async function initialize(page, options = {}) {
  await page.goto(frontend);
  await page.evaluate(async (options) => {
    const { SandboxCookieJar } = await import("/sandbox-cookies.js");
    window.CookieJar = SandboxCookieJar;
    window.cookieClock = Date.now();
    window.jar = new SandboxCookieJar({
      factory: indexedDB,
      browserSessionId: "browser_session_fixture_A",
      forbiddenOrigins: [location.origin, "https://other-frontend.example"],
      now: () => cookieClock,
      ...options,
    });
    window.documentURL = "https://app.cookie.example/account/page";
    window.context = (requestURL = documentURL, extra = {}) => ({
      requestURL,
      documentURL,
      topLevelURL: documentURL,
      credentials: "include",
      ...extra,
    });
    window.doc = jar.document({
      documentId: "cookie_document_fixture_123",
      documentURL,
      topLevelURL: documentURL,
    });
  }, options);
}
async function reload(page, options = {}) {
  await page.reload();
  await initialize(page, options);
}
try {
  browser = await chromium.launch({ executablePath, headless: true });
  receipt.browser = browser.version();
  const context = await browser.newContext(),
    page = await context.newPage();
  await initialize(page);
  receipt.initial = await page.evaluate(async () => {
    const network = await jar.storeResponseCookies(
      [
        "hostOnly=host;Path=/;Max-Age=3600",
        "domainWide=domain;Domain=cookie.example;Path=/;Max-Age=3600",
        "auth=HTTP_ONLY_SYNTHETIC;Domain=cookie.example;Path=/;Secure;HttpOnly;SameSite=Lax;Max-Age=3600",
        "secureOnly=secure;Domain=cookie.example;Path=/;Secure;SameSite=Lax;Max-Age=3600",
        "strict=strict;Domain=cookie.example;Path=/;Secure;SameSite=Strict;Max-Age=3600",
        "none=none;Domain=cookie.example;Path=/;Secure;SameSite=None;Max-Age=3600",
        "scoped=path;Domain=cookie.example;Path=/account;Max-Age=3600",
        "defaultPath=default;Max-Age=3600",
        "session=session;Path=/",
      ],
      window.context(),
    );
    await jar.storeResponseCookies(
      ["peer=PEER_SYNTHETIC;Path=/;Secure;SameSite=None;Max-Age=3600"],
      window.context("https://evil.example/", {
        documentURL: "https://evil.example/",
        topLevelURL: "https://evil.example/",
      }),
    );
    return {
      accepted: network.accepted,
      view: await doc.view(),
      header: await jar.getRequestHeader(window.context()),
    };
  });
  assert.equal(receipt.initial.accepted, 9);
  assert.ok(!receipt.initial.view.includes("HTTP_ONLY_SYNTHETIC"));
  assert.ok(!receipt.initial.view.includes("PEER_SYNTHETIC"));
  assert.ok(receipt.initial.header.includes("auth=HTTP_ONLY_SYNTHETIC"));
  receipt.groups.push("network persistence and filtered document view");
  // First command after acknowledged Set-Cookie batch destroys the whole shell.
  await reload(page);
  receipt.reload = await page.evaluate(async () => ({
    view: await doc.view(),
    header: await jar.getRequestHeader(window.context()),
  }));
  assert.ok(receipt.reload.header.includes("auth=HTTP_ONLY_SYNTHETIC"));
  assert.ok(receipt.reload.view.includes("session=session"));
  receipt.groups.push("immediate full-shell reload persists cookies");
  receipt.domainPaths = await page.evaluate(async () => ({
    subdomain: await jar.getRequestHeader(
      window.context("https://api.cookie.example/account/settings"),
    ),
    siblingPath: await jar.getRequestHeader(
      window.context("https://app.cookie.example/accounting"),
    ),
    foreign: await jar.getRequestHeader(
      window.context("https://evil.example/", {
        documentURL: "https://evil.example/",
        topLevelURL: "https://evil.example/",
      }),
    ),
  }));
  assert.ok(receipt.domainPaths.subdomain.includes("domainWide=domain"));
  assert.ok(!receipt.domainPaths.subdomain.includes("hostOnly="));
  assert.ok(!receipt.domainPaths.siblingPath.includes("scoped="));
  assert.ok(!receipt.domainPaths.siblingPath.includes("defaultPath="));
  assert.ok(!receipt.domainPaths.foreign.includes("auth="));
  receipt.groups.push("host-only, domain, path boundaries");
  receipt.documentRejections = await page.evaluate(async () => {
    const attempts = [
      "auth=evil;Domain=cookie.example;Path=/;Secure",
      "auth=;Domain=cookie.example;Path=/;Secure;Max-Age=0",
      "forged=bad;HttpOnly;Secure",
      "foreign=bad;Domain=evil.example",
      "suffix=bad;Domain=example",
      "noneBad=bad;SameSite=None",
      "__Host-bad=bad;Secure;Domain=cookie.example;Path=/",
      "__Secure-bad=bad",
      "__HTTP-bad=bad;Secure",
    ];
    const results = [];
    for (const line of attempts) {
      const result = await doc.set(line);
      results.push({ accepted: result.accepted, rejected: result.rejected });
    }
    // Native HTTPS scripts can overwrite a non-HttpOnly Secure cookie while
    // omitting Secure; only insecure-transport overlays remain forbidden.
    const httpsOverwrite = await doc.set(
      "secureOnly=downgrade;Domain=cookie.example;Path=/",
    );
    const httpsOverwriteVisible = httpsOverwrite.view.includes(
      "secureOnly=downgrade",
    );
    await doc.set(
      "secureOnly=secure;Domain=cookie.example;Path=/;Secure;SameSite=Lax;Max-Age=3600",
    );
    const httpDoc = jar.document({
      documentId: "cookie_http_document_1234",
      documentURL: "http://app.cookie.example/account/page",
      topLevelURL: "http://app.cookie.example/",
    });
    const httpResults = [
      await httpDoc.set("secureOnly=evil;Domain=cookie.example;Path=/"),
      await httpDoc.set("secureFlag=bad;Secure"),
    ];
    httpDoc.dispose();
    const good = await doc.set("__Host-good=good;Secure;Path=/;Max-Age=3600");
    const privateContext = window.context("https://tenant.github.io/", {
      documentURL: "https://tenant.github.io/",
      topLevelURL: "https://tenant.github.io/",
    });
    const privatePSL = await jar.storeResponseCookies(
      ["private=bad;Domain=github.io;Path=/;Secure"],
      privateContext,
    );
    return {
      results,
      httpsOverwrite: {
        accepted: httpsOverwrite.accepted,
        visible: httpsOverwriteVisible,
      },
      httpResults: httpResults.map((r) => ({
        accepted: r.accepted,
        rejected: r.rejected,
      })),
      good: good.accepted,
      privatePSL: privatePSL.accepted,
      header: await jar.getRequestHeader(window.context()),
    };
  });
  assert.ok(
    receipt.documentRejections.results.every(
      (r) => r.accepted === 0 && r.rejected.length === 1,
    ),
  );
  assert.ok(
    receipt.documentRejections.httpResults.every((r) => r.accepted === 0),
  );
  assert.deepEqual(receipt.documentRejections.httpsOverwrite, {
    accepted: 1,
    visible: true,
  });
  assert.equal(receipt.documentRejections.good, 1);
  assert.equal(receipt.documentRejections.privatePSL, 0);
  assert.ok(
    receipt.documentRejections.header.includes("auth=HTTP_ONLY_SYNTHETIC"),
  );
  assert.ok(receipt.documentRejections.header.includes("secureOnly=secure"));
  receipt.groups.push(
    "HttpOnly/Secure overwrite, prefix and public/private PSL defenses",
  );
  receipt.sameSite = await page.evaluate(async () => {
    const cross = (extra) =>
      window.context("https://api.cookie.example/account/page", {
        documentURL: "https://foreign.example/",
        topLevelURL: "https://foreign.example/",
        ...extra,
      });
    const crossSub = await jar.getRequestHeader(cross({})),
      navGet = await jar.getRequestHeader(
        cross({ topLevelNavigation: true, method: "GET" }),
      ),
      navPost = await jar.getRequestHeader(
        cross({ topLevelNavigation: true, method: "POST" }),
      );
    const omit = await jar.getRequestHeader(
        window.context(documentURL, { credentials: "omit" }),
      ),
      sameOriginCross = await jar.getRequestHeader(
        window.context("https://api.cookie.example/", {
          credentials: "same-origin",
        }),
      );
    const differentPortSameOriginPolicy = await jar.getRequestHeader(
      window.context("https://app.cookie.example:8443/", {
        credentials: "same-origin",
      }),
    );
    const differentPortInclude = await jar.getRequestHeader(
      window.context("https://app.cookie.example:8443/"),
    );
    const insecure = await jar.getRequestHeader(
      window.context("http://app.cookie.example/account/page", {
        documentURL: "http://app.cookie.example/",
        topLevelURL: "http://app.cookie.example/",
      }),
    );
    const schemeful = await jar.getRequestHeader(
      window.context("http://app.cookie.example/account/page"),
    );
    const third = jar.document({
      documentId: "third_party_cookie_doc_123",
      documentURL,
      topLevelURL: "https://foreign.example/",
      siteForCookiesURL: null,
    });
    const thirdSet = await third.set("third=lax;SameSite=Lax;Secure"),
      thirdView = await third.view();
    third.dispose();
    return {
      crossSub,
      navGet,
      navPost,
      omit,
      sameOriginCross,
      differentPortSameOriginPolicy,
      differentPortInclude,
      insecure,
      schemeful,
      thirdSet: thirdSet.accepted,
      thirdView,
    };
  });
  assert.equal(receipt.sameSite.crossSub, "none=none");
  assert.ok(receipt.sameSite.navGet.includes("domainWide="));
  assert.ok(!receipt.sameSite.navGet.includes("strict="));
  assert.equal(receipt.sameSite.navPost, "none=none");
  assert.equal(receipt.sameSite.omit, "");
  assert.equal(receipt.sameSite.sameOriginCross, "");
  assert.equal(receipt.sameSite.differentPortSameOriginPolicy, "");
  assert.ok(receipt.sameSite.differentPortInclude.includes("hostOnly="));
  assert.ok(!receipt.sameSite.insecure.includes("secureOnly="));
  assert.equal(receipt.sameSite.schemeful, "");
  assert.equal(receipt.sameSite.thirdSet, 0);
  assert.equal(receipt.sameSite.thirdView, "none=none");
  receipt.groups.push(
    "schemeful SameSite, credentials, top-level navigation and third-party documents",
  );
  receipt.partition = await page.evaluate(async () => {
    const a = window.context(documentURL, {
        topLevelURL: "https://top-a.example/",
      }),
      b = window.context(documentURL, {
        topLevelURL: "https://top-b.example/",
      });
    await jar.storeResponseCookies(
      ["chip=A;Path=/;Secure;SameSite=None;Partitioned;Max-Age=3600"],
      a,
    );
    return {
      a: await jar.getRequestHeader(a),
      b: await jar.getRequestHeader(b),
    };
  });
  assert.ok(receipt.partition.a.includes("chip=A"));
  assert.ok(!receipt.partition.b.includes("chip="));
  receipt.groups.push("partitioned cookies remain top-level-site scoped");
  receipt.expiry = await page.evaluate(async () => {
    await jar.storeResponseCookies(
      [
        "ageWins=present;Max-Age=60;Expires=Thu, 01 Jan 1970 00:00:00 GMT;Path=/",
        "deleteWins=gone;Max-Age=0;Expires=Wed, 09 Jun 2099 10:18:14 GMT;Path=/",
        "long=clamped;Max-Age=999999999999999999999999;Path=/",
      ],
      window.context(),
    );
    const before = await doc.view();
    cookieClock += 61000;
    const after = await doc.view();
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("atlas.browsing.cookies.v2", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const records = await new Promise((resolve) => {
      const t = db.transaction("cookies"),
        r = t.objectStore("cookies").getAll();
      t.oncomplete = () => resolve(r.result);
    });
    db.close();
    const long = records.find((r) => r.name === "long");
    return {
      before,
      after,
      maxLifetimeMilliseconds: long.expires - long.created,
    };
  });
  assert.ok(receipt.expiry.before.includes("ageWins=present"));
  assert.ok(!receipt.expiry.before.includes("deleteWins="));
  assert.ok(!receipt.expiry.after.includes("ageWins="));
  assert.equal(receipt.expiry.maxLifetimeMilliseconds, 400 * 24 * 3600000);
  receipt.groups.push("expiry, Max-Age precedence and lifetime clamp");
  // Opaque document gets only the fixed document view, not the trusted jar.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.src = "/child";
        frame.onload = resolve;
        document.body.append(frame);
      }),
  );
  const child = page.frames().find((f) => f.parentFrame() === page.mainFrame());
  await child.evaluate(() => {
    window.received = [];
    window.ready = new Promise((resolve) => {
      onmessage = (e) => {
        if (e.source !== parent || e.ports.length !== 1) return;
        window.cookiePort = e.ports[0];
        cookiePort.onmessage = (e) => {
          received.push(e.data);
          if (e.data.type === "ready") resolve();
        };
        cookiePort.start();
      };
    });
  });
  await page.evaluate(() => {
    const c = new MessageChannel();
    window.boundPort = doc.bindPort(c.port1);
    document
      .querySelector("iframe")
      .contentWindow.postMessage({}, "*", [c.port2]);
  });
  await child.evaluate(() => ready);
  const beforePackets = await child.evaluate(() => JSON.stringify(received));
  assert.ok(!beforePackets.includes("HTTP_ONLY_SYNTHETIC"));
  assert.ok(!beforePackets.includes("PEER_SYNTHETIC"));
  await child.evaluate(() =>
    cookiePort.postMessage({
      protocol: "atlas-cookies-v2",
      type: "get",
      documentId: "cookie_document_fixture_123",
      sequence: 1,
      url: "https://evil.example/",
    }),
  );
  await child.waitForFunction(() => received.some((r) => r.type === "error"));
  await child.evaluate(() =>
    cookiePort.postMessage({
      protocol: "atlas-cookies-v2",
      type: "get",
      documentId: "cookie_document_fixture_123",
      sequence: 1,
    }),
  );
  await child.waitForFunction(() =>
    received.some((r) => r.type === "result" && r.sequence === 1),
  );
  await page.evaluate(() =>
    jar.storeResponseCookies(
      ["visibleUpdate=committed;Path=/;Max-Age=3600"],
      window.context(),
    ),
  );
  await child.waitForFunction(() =>
    received.some(
      (r) => r.type === "view" && r.value.includes("visibleUpdate=committed"),
    ),
  );
  receipt.opaqueBoundary = await child.evaluate(() => {
    let idb;
    try {
      indexedDB.open("atlas.browsing.cookies.v2");
      idb = "unexpected_allowed";
    } catch (e) {
      idb = e.name;
    }
    return {
      origin,
      nativeIDB: idb,
      views: received.map((r) => ({
        type: r.type,
        keys: Object.keys(r),
        value: r.value || r.view || "",
        code: r.code || null,
      })),
    };
  });
  assert.equal(receipt.opaqueBoundary.origin, "null");
  assert.equal(receipt.opaqueBoundary.nativeIDB, "SecurityError");
  assert.ok(
    receipt.opaqueBoundary.views.some(
      (r) => r.code === "invalid_cookie_capability",
    ),
  );
  assert.ok(
    !JSON.stringify(receipt.opaqueBoundary).includes("HTTP_ONLY_SYNTHETIC"),
  );
  receipt.groups.push(
    "real opaque MessagePort capability, URL-spoof rejection and filtered updates",
  );
  receipt.sessions = await page.evaluate(async () => {
    const second = new CookieJar({
      factory: indexedDB,
      browserSessionId: "browser_session_fixture_B",
      forbiddenOrigins: [location.origin],
    });
    const header = await second.getRequestHeader(window.context());
    await second.close();
    return {
      newSession: header,
      oldSession: await jar.getRequestHeader(window.context()),
    };
  });
  assert.ok(!receipt.sessions.newSession.includes("session=session"));
  assert.ok(receipt.sessions.oldSession.includes("session=session"));
  assert.ok(receipt.sessions.newSession.includes("hostOnly=host"));
  receipt.groups.push("browser-session cookies versus persistent cookies");
  // Native IDB lock demonstrates wrapped fetch cannot resolve before the
  // Set-Cookie transaction commits. Transport itself is an explicit fixture.
  const lockPage = await context.newPage();
  await lockPage.goto(frontend);
  await page.evaluate(() => {
    window.transportEntered = false;
    window.responseResolved = false;
    window.cookieWriteEntered = false;
    let release;
    window.transportRelease = new Promise((resolve) => (release = resolve));
    window.releaseTransport = release;
    const original = jar.storeResponseCookies.bind(jar);
    jar.storeResponseCookies = (...args) => {
      cookieWriteEntered = true;
      return original(...args);
    };
    const fetch = jar.wrapFetch(
      async (request) => {
        window.forwardedHeader =
          request.headers.find(([n]) => n === "cookie")?.[1] || "";
        transportEntered = true;
        await transportRelease;
        return {
          url: request.url,
          status: 200,
          statusText: "OK",
          headers: [
            ["set-cookie", "fetchCommit=durable;Path=/;Max-Age=3600"],
            ["content-type", "text/plain"],
          ],
          body: new TextEncoder().encode("fixture response").buffer,
        };
      },
      () => ({
        requestURL: documentURL,
        documentURL,
        topLevelURL: documentURL,
        credentials: "include",
      }),
    );
    window.fetchPromise = fetch(
      {
        url: documentURL,
        method: "GET",
        headers: [["cookie", "forged"]],
        credentials: "include",
        mode: "same-origin",
      },
      {
        documentId: "cookie_document_fixture_123",
        documentURL,
        origin: new URL(documentURL).origin,
        signal: new AbortController().signal,
        preflight: false,
      },
    ).then((value) => {
      responseResolved = true;
      return value.headers;
    });
  });
  await page.waitForFunction(() => transportEntered);
  await lockPage.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("atlas.browsing.cookies.v2", 1);
      r.onsuccess = () => resolve(r.result);
    });
    window.hold = true;
    const tx = db.transaction(["cookies", "meta"], "readwrite"),
      store = tx.objectStore("cookies");
    window.holdDone = new Promise(
      (resolve) =>
        (tx.oncomplete = () => {
          db.close();
          resolve();
        }),
    );
    function pump() {
      store.get("fixture-lock").onsuccess = () => {
        if (hold) pump();
      };
    }
    pump();
  });
  await page.evaluate(() => releaseTransport());
  await page.waitForFunction(() => cookieWriteEntered);
  assert.equal(await page.evaluate(() => responseResolved), false);
  await lockPage.evaluate(async () => {
    hold = false;
    await holdDone;
  });
  const wrappedHeaders = await page.evaluate(() => fetchPromise);
  assert.ok(!wrappedHeaders.some(([name]) => name === "set-cookie"));
  await reload(page);
  receipt.fetchCommit = await page.evaluate(() => doc.view());
  assert.ok(receipt.fetchCommit.includes("fetchCommit=durable"));
  receipt.groups.push(
    "fetch waits for real native cookie commit and strips Set-Cookie",
  );
  const quotaContext = await browser.newContext(),
    quotaPage = await quotaContext.newPage();
  await initialize(quotaPage, { maxCookiesPerSite: 2, maxBytes: 2048 });
  receipt.quota = await quotaPage.evaluate(async () => {
    await jar.storeResponseCookies(
      [
        "auth=protected;Path=/;HttpOnly;Max-Age=3600",
        "preference=existing;Path=/;Max-Age=3600",
      ],
      window.context(),
    );
    const before = await jar.getRequestHeader(window.context());
    let error;
    try {
      await doc.set("overflow=not-committed;Path=/;Max-Age=3600");
    } catch (e) {
      error = e.name;
    }
    return {
      before,
      error,
      after: await jar.getRequestHeader(window.context()),
    };
  });
  assert.equal(receipt.quota.error, "QuotaExceededError");
  assert.equal(receipt.quota.after, receipt.quota.before);
  await reload(quotaPage, { maxCookiesPerSite: 2, maxBytes: 2048 });
  assert.equal(
    await quotaPage.evaluate(() => jar.getRequestHeader(window.context())),
    receipt.quota.before,
  );
  receipt.groups.push(
    "cookie quota abort is atomic and preserves HttpOnly cookie across reload",
  );
  receipt.forbidden = await page.evaluate(async () => {
    const errors = [];
    for (const requestURL of [
      location.origin,
      "https://other-frontend.example/",
    ])
      try {
        await jar.getRequestHeader(window.context(requestURL));
        errors.push("unexpected_allowed");
      } catch (e) {
        errors.push(e.name);
      }
    return errors;
  });
  assert.deepEqual(receipt.forbidden, ["SecurityError", "SecurityError"]);
  receipt.groups.push("frontend cookie namespaces denied");
  // Real browser cookie baseline for the central HttpOnly/domain/path/prefix
  // cases. Route fulfillment is a synthetic HTTPS origin, not a live site.
  const nativeContext = await browser.newContext();
  await nativeContext.route("**/*", async (route) => {
    const target = new URL(route.request().url()),
      cookie = target.searchParams.get("set");
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: cookie ? { "set-cookie": cookie } : {},
      body: "<!doctype html><title>Native cookie baseline</title>",
    });
  });
  const nativePage = await nativeContext.newPage();
  await nativePage.goto(
    "https://app.native-cookie.example/account/page?set=" +
      encodeURIComponent("nativeAuth=protected;Secure;HttpOnly;Path=/"),
  );
  receipt.nativeHTTPSOverwrite = await nativePage.evaluate(() => {
    document.cookie = "nativeSecure=secure;Secure;Path=/account";
    document.cookie = "nativeSecure=downgrade;Path=/account";
    return { visible: document.cookie.includes("nativeSecure=downgrade") };
  });
  const nativeOverwriteCookie = (await nativeContext.cookies()).find(
    (cookie) => cookie.name === "nativeSecure",
  );
  receipt.nativeHTTPSOverwrite.value = nativeOverwriteCookie?.value;
  receipt.nativeHTTPSOverwrite.secure = nativeOverwriteCookie?.secure;
  assert.deepEqual(receipt.nativeHTTPSOverwrite, {
    visible: true,
    value: "downgrade",
    secure: false,
  });
  await nativePage.evaluate(() => {
    document.cookie = "nativeSecure=;Path=/account;Max-Age=0";
  });
  receipt.nativeBaseline = await nativePage.evaluate(() => {
    document.cookie = "nativeAuth=forged;Secure;Path=/";
    document.cookie = "visible=kept;Path=/account";
    document.cookie = "foreign=bad;Domain=foreign.example";
    document.cookie = "suffix=bad;Domain=example";
    document.cookie =
      "__Host-invalid=bad;Secure;Domain=native-cookie.example;Path=/";
    document.cookie = "__Secure-invalid=bad";
    return { view: document.cookie };
  });
  receipt.nativeBaseline.httpOnly = (await nativeContext.cookies()).find(
    (cookie) => cookie.name === "nativeAuth",
  )?.value;
  assert.equal(receipt.nativeBaseline.httpOnly, "protected");
  assert.equal(receipt.nativeBaseline.view, "visible=kept");
  await nativePage.goto("https://app.native-cookie.example/accounting");
  receipt.nativeBaseline.pathBoundary = await nativePage.evaluate(
    () => document.cookie,
  );
  assert.equal(receipt.nativeBaseline.pathBoundary, "");
  await nativePage.goto(
    "https://tenant.github.io/?set=" +
      encodeURIComponent("private=bad;Domain=github.io;Path=/;Secure"),
  );
  receipt.nativeBaseline.privatePSL = (await nativeContext.cookies()).some(
    (cookie) => cookie.name === "private",
  );
  assert.equal(receipt.nativeBaseline.privatePSL, false);
  await nativeContext.close();
  receipt.groups.push(
    "actual native browser baseline agrees on HttpOnly/domain/path/prefix/private-PSL defenses",
  );
  // An actual locked native cookie object store keeps these writes pending.
  // Disposal/abort must prevent a late commit once the lock is released.
  await lockPage.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("atlas.browsing.cookies.v2", 1);
      request.onsuccess = () => resolve(request.result);
    });
    window.hold = true;
    const tx = db.transaction(["cookies", "meta"], "readwrite"),
      store = tx.objectStore("cookies");
    window.holdDone = new Promise(
      (resolve) =>
        (tx.oncomplete = () => {
          db.close();
          resolve();
        }),
    );
    function pump() {
      store.get("fixture-lock").onsuccess = () => {
        if (hold) pump();
      };
    }
    pump();
  });
  await page.evaluate(() => {
    window.cookieAbort = new AbortController();
    window.abortedCookie = jar
      .storeResponseCookies(
        ["afterAbort=forbidden;Path=/;Max-Age=3600"],
        window.context(documentURL, { signal: cookieAbort.signal }),
      )
      .then(
        () => "unexpected_success",
        (error) => error.name,
      );
    window.disposableDocument = jar.document({
      documentId: "cookie_disposal_fixture_123",
      documentURL,
      topLevelURL: documentURL,
    });
    window.disposedCookie = disposableDocument
      .set("afterDispose=forbidden;Path=/;Max-Age=3600")
      .then(
        () => "unexpected_success",
        (error) => error.name,
      );
  });
  await page.evaluate(() => {
    cookieAbort.abort(new DOMException("fixture cancellation", "AbortError"));
    disposableDocument.dispose();
  });
  receipt.cancellation = await page.evaluate(async () => ({
    network: await abortedCookie,
    document: await disposedCookie,
  }));
  assert.equal(receipt.cancellation.network, "AbortError");
  assert.equal(receipt.cancellation.document, "AbortError");
  await lockPage.evaluate(async () => {
    hold = false;
    await holdDone;
  });
  receipt.afterCancellation = await page.evaluate(() => doc.view());
  assert.ok(!receipt.afterCancellation.includes("afterAbort="));
  assert.ok(!receipt.afterCancellation.includes("afterDispose="));
  receipt.groups.push(
    "native queued cookie writes abort on signal/document disposal without late persistence",
  );
  await page.evaluate(() => jar.endSession());
  receipt.endSession = await page.evaluate(() => doc.view());
  assert.ok(!receipt.endSession.includes("session=session"));
  assert.ok(receipt.endSession.includes("hostOnly=host"));
  receipt.groups.push(
    "explicit browser-session end removes only its session cookies",
  );
  await quotaContext.close();
  await context.close();
  receipt.result = "trusted_cookie_backend_verified";
  receipt.exitStatus = 0;
  receipt.constraints = [
    "Trusted backend and document-port boundary tested; native synchronous document.cookie setter integration remains a separate gate.",
    "Network transport in wrapFetch test is an explicit trusted fixture; no production or live-service login claim.",
    "SameSite default uses Lax behavior without the optional two-minute unsafe-navigation compatibility exception.",
    "Logical browserSessionId must be shared across current browser tabs and rotated/ended by trusted frontend lifecycle; no legacy jar migration occurs.",
    "Configured cookie quota aborts the whole transaction instead of evicting unrelated/authentication cookies; native total-browser quota exhaustion is not injected.",
  ];
} catch (error) {
  receipt.result = "test_failure";
  receipt.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  receipt.exitStatus = 1;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      receipt: output,
      result: receipt.result,
      groupsPassed: receipt.groups.length,
      exitStatus: receipt.exitStatus,
      generalRuntimeQualified: false,
    }),
  );
}
