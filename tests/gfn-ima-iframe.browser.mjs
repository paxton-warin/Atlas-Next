/** Owned, anonymous reproduction of IMA's initial-blank measurement frame.
 * Real pinned Controller/core/SW, synthetic loopback transport only. No NVIDIA,
 * Google ad requests, account state, queue-success overrides or sandbox changes.
 * --baseline reproduces the native un-controlled child/66-byte 503 failure;
 * --profile exercises the real profile plugin with owned prepared capabilities;
 * --legacy preserves the pre-cancellation controllers deployed on older nodes;
 * --core-file PATH additionally qualifies an exact downloaded deployed core. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { adaptNormalRuntimeCore } from "../scripts/runtime-normal-core.mjs";
import { adaptToggleAttribute } from "../scripts/runtime-toggle-attribute.mjs";
import { adaptLiteralEval } from "../scripts/runtime-literal-eval.mjs";
import { adaptRequestCancellationCore } from "../scripts/runtime-request-cancellation.mjs";
import {
  adaptModuleIdentity,
  adaptModuleIdentityForPreCancellationRelease,
} from "../scripts/runtime-module-identity.mjs";
import { adaptControllerDecode } from "../scripts/runtime-controller-decode.mjs";
import {
  adaptGfnIma,
  createGfnImaSourceAdapter,
  GFN_IMA_INPUTS,
  GFN_IMA_OUTPUTS,
} from "../scripts/runtime-gfn-ima.mjs";

const baseline = process.argv.includes("--baseline"),
  legacy = process.argv.includes("--legacy"),
  profile = process.argv.includes("--profile");
const generation = legacy ? "pre" : "post",
  variant = baseline ? "baseline" : "modified";
const E = resolve("test-results/gfn-ima-iframe");
await mkdir(E, { recursive: true });
const reportPath =
  E +
  "/" +
  variant +
  (legacy ? "-legacy" : "") +
  (profile ? "-profile" : "") +
  ".json";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const profileBundle = profile
  ? (
      await build({
        entryPoints: ["runtime/scramjet-profile.ts"],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
      })
    ).outputFiles[0].contents
  : null;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fallback =
  "Proxy worker is not controlling this page. Reload Atlas and retry.";
assert.equal(Buffer.byteLength(fallback), 66);
const imaURL = "https://imasdk.googleapis.com/js/sdkloader/ima3.js";
const measurementURL = "https://measurement.fixture.test/omsdk.js";
const sdk = await readFile("tests/fixtures/gfn-ima-source.js", "utf8");
const adaptSource = createGfnImaSourceAdapter();
assert.notEqual(
  adaptSource(sdk, imaURL, false),
  sdk,
  "Authored public-shape factory must qualify",
);
const measurement =
  'globalThis.fixtureHydrationAtMeasurement=globalThis.fixtureProfileCapabilities?{documentId:fixtureProfileCapabilities.documentId,website:fixtureProfileCapabilities.website,saved:fixtureProfileCapabilities.storage.getItem("saved"),cookie:fixtureProfileCapabilities.cookie}:null;globalThis.fixtureMeasurementReady=true;globalThis.omidSessionInterface={fixture:true};';
let base = adaptLiteralEval(
  adaptToggleAttribute(
    adaptNormalRuntimeCore(
      await readFile("upstream/scramjet-ls-bypass/app/vendor/runtimekit.js"),
    ),
  ),
);
base = legacy
  ? adaptModuleIdentityForPreCancellationRelease(base)
  : adaptModuleIdentity(adaptRequestCancellationCore(base));
const expected = baseline ? base : adaptGfnIma(base);
assert.equal(
  sha(expected),
  (baseline ? GFN_IMA_INPUTS : GFN_IMA_OUTPUTS)[
    generation + "-runtimekit-normal.js"
  ],
);
const coreIndex = process.argv.indexOf("--core-file"),
  coreFile = coreIndex < 0 ? null : process.argv[coreIndex + 1];
if (coreIndex >= 0 && (!coreFile || coreFile.startsWith("--")))
  throw Error("--core-file requires a local core path");
const selected = coreFile ? await readFile(resolve(coreFile)) : expected;
assert.equal(
  sha(selected),
  sha(expected),
  "Explicit core must match the complete selected frozen generation",
);
const assets = {};
for (const path of [
  "/runtime/runtimekit-normal.js",
  "/runtime/runtimekit-utils.js",
  "/runtime/runtimekit.wasm",
  "/controller/controller.api.js",
  "/controller/controller.inject.js",
  "/controller/controller.worker.js",
]) {
  if (path === "/runtime/runtimekit-normal.js") assets[path] = selected;
  else if (legacy && path.startsWith("/controller/")) {
    const raw = await readFile(
      "upstream/scramjet-ls-bypass/app/vendor/" + path.split("/").at(-1),
    );
    assets[path] = path.endsWith("controller.inject.js")
      ? adaptControllerDecode(raw)
      : raw;
  } else assets[path] = await readFile("runtime/public" + path);
}
const fixture = (url) => {
  const u = new URL(url);
  if (url === imaURL) return { type: "application/javascript", body: sdk };
  if (url === measurementURL)
    return { type: "application/javascript", body: measurement };
  if (u.pathname === "/host" || u.pathname === "/bridge")
    return {
      type: "text/html",
      body: "<!doctype html><title>Owned SDK host</title><h1>Owned SDK host</h1>",
    };
  return { type: "text/plain", status: 404, body: "missing owned fixture" };
};
const requests = [],
  connections = new Set();
let origin;
const server = createServer((req, res) => {
  const u = new URL(req.url, origin || "http://fixture.invalid");
  res.setHeader("cache-control", "no-store");
  if (assets[u.pathname]) {
    res.setHeader(
      "content-type",
      u.pathname.endsWith(".wasm")
        ? "application/wasm"
        : "application/javascript",
    );
    res.end(assets[u.pathname]);
    return;
  }
  if (u.pathname === "/profile-plugin.js" && profileBundle) {
    res.setHeader("content-type", "application/javascript");
    res.end(profileBundle);
    return;
  }
  if (u.pathname === "/worker.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(
      "importScripts('/controller/controller.worker.js');self.addEventListener('fetch',event=>{if($runtimekitController.shouldRoute(event))event.respondWith($runtimekitController.route(event))});",
    );
    return;
  }
  if (u.pathname === "/fixture") {
    const target = u.searchParams.get("url"),
      f = fixture(target);
    requests.push({ kind: "transport", target });
    res.writeHead(f.status || 200, {
      "content-type": f.type,
      "access-control-allow-origin": "*",
    });
    res.end(f.body);
    return;
  }
  if (u.pathname.startsWith("/~/app/")) {
    requests.push({ kind: "http-fallback", path: u.pathname });
    res.writeHead(503, { "content-type": "text/plain" });
    res.end(fallback);
    return;
  }
  if (u.pathname === "/native") {
    const policy = u.searchParams.get("policy") || "none";
    if (policy === "trusted")
      res.setHeader(
        "content-security-policy",
        "require-trusted-types-for 'script'; trusted-types goog#html",
      );
    if (policy === "denied")
      res.setHeader(
        "content-security-policy",
        "require-trusted-types-for 'script'; trusted-types 'none'",
      );
    if (policy === "blocked-script")
      res.setHeader(
        "content-security-policy",
        "script-src 'self' https://imasdk.googleapis.com",
      );
    res.setHeader("content-type", "text/html");
    res.end(
      '<!doctype html><title>Native publisher-policy control</title><script src="' +
        imaURL +
        '"' +
        (policy === "integrity"
          ? ' integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" crossorigin="anonymous"'
          : "") +
        '></script><div id="container"></div>',
    );
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    '<!doctype html><title>Trusted owned runtime fixture</title><iframe id="site"></iframe>',
  );
});
server.on("connection", (s) => {
  connections.add(s);
  s.on("close", () => connections.delete(s));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-proxy-server"],
});
const rows = [],
  nativeControls = [];
let report;

// Factory timeout is test-owned. The original factory intentionally has no
// script-error resolution; no timeout, success callback or ad state is patched.
async function exercise(
  owner,
  { creation = "parent", alternate = false, timeout = 1500 } = {},
) {
  return owner.evaluate(
    async ({ creation, alternate, timeout, measurementURL }) => {
      globalThis.fixtureCreateInChild = creation === "child";
      globalThis.fixtureAlternateElementFactory = alternate;
      globalThis.fixtureMeasurementURL = measurementURL;
      const unrelated = document.createElement("iframe");
      unrelated.title = "unrelated";
      document.body.appendChild(unrelated);
      const unrelatedState = {
        src: unrelated.getAttribute("src"),
        srcdoc: unrelated.getAttribute("srcdoc"),
        sandbox: unrelated.getAttribute("sandbox"),
      };
      unrelated.remove();
      const container = document.createElement("div");
      document.body.appendChild(container);
      let settled = "pending",
        error = null,
        loads = 0;
      const append = container.appendChild.bind(container);
      container.appendChild = function (child) {
        child.addEventListener("load", () => loads++);
        return append(child);
      };
      let operation;
      try {
        operation = fixtureCreateMeasurementFrame(container);
        Promise.resolve(operation).then(
          () => (settled = "fulfilled"),
          (e) => {
            settled = "rejected";
            error = e?.name || String(e);
          },
        );
      } catch (e) {
        settled = "threw";
        error = e.name;
      }
      await Promise.race([
        Promise.resolve(operation).catch(() => {}),
        new Promise((r) => setTimeout(r, timeout)),
      ]);
      const frame = globalThis.fixtureLastFrame;
      let ready = false,
        attributes = null,
        scriptAttributes = null,
        accessible = false,
        hydration = null,
        parentHydration =
          globalThis.fixtureProfileCapabilities?.documentId || null;
      if (frame) {
        attributes = Object.fromEntries(
          [...frame.attributes].map((a) => [
            a.name,
            frame.getAttribute(a.name),
          ]),
        );
        try {
          const doc = frame.contentDocument;
          accessible = !!doc;
          ready = frame.contentWindow.fixtureMeasurementReady === true;
          hydration = frame.contentWindow.fixtureHydrationAtMeasurement || null;
          const script = doc?.querySelector("script[src]");
          if (script)
            scriptAttributes = {
              type: script.getAttribute("type"),
              integrity: script.getAttribute("integrity"),
              crossorigin: script.getAttribute("crossorigin"),
              nonce: script.getAttribute("nonce"),
            };
        } catch {}
      }
      const result = {
        creation,
        alternate,
        settled,
        error,
        loads,
        ready,
        accessible,
        attributes,
        scriptAttributes,
        unrelatedState,
        hydration,
        parentHydration,
      };
      container.remove();
      return result;
    },
    { creation, alternate, timeout, measurementURL },
  );
}
function checkPublicAttributes(row, adapted) {
  assert.equal(row.attributes.title, "Advertisement");
  assert.equal(row.attributes.src, undefined);
  assert.equal(row.attributes.sandbox, undefined);
  assert.equal(row.attributes.referrerpolicy, undefined);
  assert.equal(row.attributes.allow, undefined);
  assert.equal(row.attributes.srcdoc, adapted ? "" : undefined);
  assert.equal(
    row.attributes.style,
    row.alternate
      ? "visibility: hidden; width: 0px; height: 0px; position: absolute; left: 0px; top: 0px;"
      : "visibility: hidden; width: 0; height: 0; position: absolute; left: 0; top: 0;",
  );
  assert.equal(
    row.loads,
    1,
    "Factory must await a single initial document load",
  );
  assert.deepEqual(
    row.unrelatedState,
    { src: null, srcdoc: null, sandbox: null },
    "No global blank-frame adaptation",
  );
  assert.deepEqual(
    row.scriptAttributes,
    { type: null, integrity: null, crossorigin: null, nonce: null },
    "No integrity, nonce, mode or crossorigin removal/addition",
  );
}
try {
  // Native Chrome receives only owned public-shape SDK and measurement bodies.
  // These controls are independent of Atlas's iframe attribute interception.
  for (const policy of [
    "original-direct",
    "none",
    "trusted",
    "denied",
    "blocked-script",
    "integrity",
  ]) {
    const ctx = await browser.newContext(),
      p = await ctx.newPage(),
      errors = [],
      responses = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("response", (r) => {
      if ([imaURL, measurementURL].includes(r.url()))
        responses.push({
          url: r.url(),
          status: r.status(),
          fromServiceWorker: r.fromServiceWorker(),
        });
    });
    await ctx.route("https://**/*", (route) => {
      const url = route.request().url();
      if (url === imaURL)
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body:
            policy === "original-direct"
              ? sdk
              : adaptSource(sdk, imaURL, false),
          headers: { "access-control-allow-origin": "*" },
        });
      if (url === measurementURL)
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: measurement,
        });
      throw Error("Unexpected external fixture request");
    });
    await p.goto(origin + "/native?policy=" + encodeURIComponent(policy));
    if (policy === "integrity") {
      const blocked = await p.evaluate(() => ({
        executed: typeof fixtureCreateMeasurementFrame !== "undefined",
        integrity: document
          .querySelector("script[src]")
          .getAttribute("integrity"),
        crossorigin: document
          .querySelector("script[src]")
          .getAttribute("crossorigin"),
      }));
      assert.deepEqual(blocked, {
        executed: false,
        integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        crossorigin: "anonymous",
      });
      nativeControls.push({ policy, ...blocked, responses, errors });
      await ctx.close();
      continue;
    }
    await p.waitForFunction(
      () => typeof fixtureCreateMeasurementFrame === "function",
    );
    const row = { policy, ...(await exercise(p)), responses, errors };
    if (policy === "denied") {
      assert.ok(["threw", "rejected"].includes(row.settled));
      assert.equal(row.error, "TypeError");
      assert.equal(row.ready, false);
    } else if (policy === "blocked-script") {
      assert.equal(row.settled, "pending");
      assert.equal(row.ready, false);
      checkPublicAttributes(row, true);
    } else {
      assert.equal(row.settled, "fulfilled");
      assert.equal(row.ready, true);
      checkPublicAttributes(row, policy !== "original-direct");
      assert.deepEqual(errors, []);
    }
    // A genuinely opaque sandbox remains opaque with an empty srcdoc. The SDK
    // never creates this sandbox; the control proves the primitive keeps policy.
    if (policy === "none")
      row.opaqueSandbox = await p.evaluate(async () => {
        const f = document.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.srcdoc = gk(fk(""));
        const loaded = new Promise((r) => (f.onload = r));
        document.body.appendChild(f);
        await loaded;
        let error = null;
        try {
          void f.contentWindow.document;
        } catch (e) {
          error = e.name;
        }
        const value = {
          sandbox: f.getAttribute("sandbox"),
          accessible: f.contentDocument !== null,
          error,
        };
        f.remove();
        return value;
      });
    if (row.opaqueSandbox)
      assert.deepEqual(row.opaqueSandbox, {
        sandbox: "allow-scripts",
        accessible: false,
        error: "SecurityError",
      });
    nativeControls.push(row);
    await ctx.close();
  }
  const ctx = await browser.newContext(),
    p = await ctx.newPage(),
    errors = [],
    responses = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("response", (r) => {
    if (r.url().includes("/~/app/"))
      responses.push({
        url: r.url(),
        status: r.status(),
        fromServiceWorker: r.fromServiceWorker(),
      });
  });
  // Any unexpected external request fails locally instead of reaching a service.
  await ctx.route("https://**/*", (route) => route.abort("blockedbyclient"));
  await p.goto(origin);
  await p.evaluate(async (profile) => {
    const reg = await navigator.serviceWorker.register("/worker.js", {
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((r) =>
        navigator.serviceWorker.addEventListener("controllerchange", r, {
          once: true,
        }),
      );
    for (const path of [
      "/runtime/runtimekit-normal.js",
      "/controller/controller.api.js",
      "/runtime/runtimekit-utils.js",
    ])
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = path;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    const nativeFetch = window.fetch.bind(window),
      transport = {
        ready: true,
        async init() {},
        async request(remote, method, body, headers, signal) {
          const r = await nativeFetch(
            "/fixture?url=" + encodeURIComponent(remote.href),
            { signal },
          );
          return {
            url: remote.href,
            status: r.status,
            statusText: r.statusText,
            headers: [...r.headers],
            body: r.body,
          };
        },
        connect() {
          throw Error("No socket fixture");
        },
      };
    const { Controller, config } = $runtimekitController;
    config.injectPath = "/controller/controller.inject.js";
    config.wasmPath = "/runtime/runtimekit.wasm";
    config.runtimekitPath = "/runtime/runtimekit-normal.js";
    const plugins = [];
    window.profileEvents = [];
    window.profileErrors = [];
    if (profile) {
      const { createScramjetProfilePlugin, neutralizeScramjetCookies } =
        await import("/profile-plugin.js");
      neutralizeScramjetCookies(window);
      const profileId = "11111111-1111-4111-8111-111111111111";
      const bridge = {
        profileId,
        profileContextId: "owned-gfn-profile",
        browserSessionId: "owned-browser",
        frameId: "owned-root",
        topLevelURL: () => "https://play.geforcenow.com/host",
        async prepareOrigin(website, options) {
          profileEvents.push({
            kind: "prepare-origin",
            website,
            interactive: options?.interactive,
          });
        },
        async getRequestHeader() {
          return "";
        },
        async storeResponseCookies() {
          throw Error("Owned fixture must not emit cookies");
        },
        async prepareDocument(input) {
          profileEvents.push({
            kind: "prepare-document",
            documentId: input.documentId,
            website: input.website,
          });
          // This owner is deliberately synthetic: its capabilities demonstrate the
          // real plugin's synchronous inheritance/install ordering without account
          // databases, filesystem receipts, native-worker or backup side effects.
          const saved = new Map([["saved", "hydrated-before-script"]]);
          let disposed = false;
          return {
            ...input,
            profileId,
            install(win, client) {
              if (disposed) throw Error("Prepared fixture disposed");
              const cap = {
                documentId: input.documentId,
                website: input.website,
                storage: { getItem: (key) => saved.get(key) || null },
                cookie: "owned-profile-cookie",
              };
              Object.defineProperty(win, "fixtureProfileCapabilities", {
                configurable: true,
                value: cap,
              });
              profileEvents.push({
                kind: "install",
                documentId: input.documentId,
                url: client.url.href,
                token:
                  client.initHeaders?.get("x-atlas-profile-document") || null,
              });
            },
            dispose() {
              disposed = true;
              profileEvents.push({
                kind: "dispose",
                documentId: input.documentId,
              });
            },
          };
        },
        async bindWorkerIndexedDB() {
          throw Error("Worker storage not part of this owned plugin fixture");
        },
      };
      window.profilePlugin = createScramjetProfilePlugin(window, bridge, {
        host: window,
        frameId: "owned-root",
        onError: (error) => profileErrors.push(error.message),
      });
      plugins.push(profilePlugin);
    }
    window.ctrl = new Controller({ serviceworker: reg.active, transport });
    await ctrl.wait();
    window.frame = ctrl.createFrame(document.querySelector("#site"), {
      plugins,
    });
    frame.go("https://play.geforcenow.com/host");
  }, profile);
  const root = p.frames().find((f) => f.parentFrame() === p.mainFrame());
  await root.getByRole("heading", { name: "Owned SDK host" }).waitFor();
  for (const placement of ["root", "nested-bridge"]) {
    let owner = root;
    if (placement === "nested-bridge") {
      await root.evaluate(() => {
        const bridge = document.createElement("iframe");
        bridge.id = "bridge";
        bridge.src = "https://imasdk.googleapis.com/bridge";
        document.body.appendChild(bridge);
      });
      await p.waitForTimeout(100);
      owner = p.frames().find((f) => f.parentFrame() === root);
      await owner.getByRole("heading", { name: "Owned SDK host" }).waitFor();
    }
    await owner.evaluate(async (imaURL) => {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = imaURL;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }, imaURL);
    for (const creation of ["parent", "child"]) {
      const start = responses.length,
        requestStart = requests.length,
        errorStart = errors.length;
      const row = {
        placement,
        ...(await exercise(owner, {
          creation,
          alternate: creation === "child",
        })),
        responses: responses.slice(start),
        requests: requests.slice(requestStart),
        errors: errors.slice(errorStart),
      };
      // Select only the measurement request, never SDK/core/document bootstraps.
      const measurementResponses = row.responses.filter(
        (r) =>
          r.url.includes("measurement.fixture.test") ||
          r.url.includes("bWVhc3VyZW1lbnQuZml4dHVyZS50ZXN0"),
      );
      row.measurementResponses = measurementResponses;
      checkPublicAttributes(row, !baseline);
      assert.equal(row.errors.length, 0);
      if (baseline) {
        assert.equal(row.settled, "pending");
        assert.equal(row.ready, false);
        assert.ok(
          measurementResponses.some(
            (r) => r.status === 503 && !r.fromServiceWorker,
          ),
          "Initial blank child must miss native worker control",
        );
        assert.ok(row.requests.some((r) => r.kind === "http-fallback"));
        assert.equal(
          row.requests.some(
            (r) => r.kind === "transport" && r.target === measurementURL,
          ),
          false,
        );
      } else {
        assert.equal(row.settled, "fulfilled");
        assert.equal(row.ready, true);
        if (profile) {
          assert.equal(row.hydration?.documentId, row.parentHydration);
          assert.equal(row.hydration?.saved, "hydrated-before-script");
          assert.equal(row.hydration?.cookie, "owned-profile-cookie");
        }
        assert.ok(
          measurementResponses.some(
            (r) => r.status === 200 && r.fromServiceWorker,
          ),
          "Measurement script must travel through actual worker",
        );
        assert.ok(
          row.requests.some(
            (r) => r.kind === "transport" && r.target === measurementURL,
          ),
        );
        assert.equal(
          row.requests.some((r) => r.kind === "http-fallback"),
          false,
        );
      }
      rows.push(row);
    }
  }
  const profileState = profile
    ? await p.evaluate(() => ({ events: profileEvents, errors: profileErrors }))
    : null;
  if (profile) {
    assert.deepEqual(profileState.errors, []);
    assert.ok(
      profileState.events.some(
        (e) => e.kind === "install" && e.url === "about:srcdoc",
      ) || baseline,
      "Controlled srcdoc must use actual profile install hook",
    );
  }
  await ctx.close();
  report = {
    profile,
    profileState,
    result: baseline
      ? "BASELINE_DEFECT_REPRODUCED"
      : "MODIFIED_ALL_4_ROUTED_CASES_PASS",
    variant,
    generation,
    coreCopy: coreFile ? resolve(coreFile) : null,
    browser: browser.version(),
    scope:
      "Authored public-factory shape, actual pinned Window Controller/core/SW, owned loopback transport. Proves native blank-frame routing and policy boundaries, not signed-in GFN queue/game completion or real relay performance.",
    fallbackBytes: 66,
    fixtureSHA256: sha(sdk),
    assetSHA256: Object.fromEntries(
      Object.entries(assets).map(([k, v]) => [k, sha(v)]),
    ),
    nativeControls,
    rows,
  };
} catch (e) {
  report = {
    result: "FAIL",
    error: String(e),
    variant,
    generation,
    nativeControls,
    rows,
  };
  throw e;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await browser.close();
  for (const s of connections) s.destroy();
  await new Promise((r) => server.close(r));
  const reopened = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(reopened.result, report.result);
  if (report.result !== "FAIL")
    console.log(
      `${baseline ? "BASELINE=REPRODUCED;4initialBlank503;factoryPending4" : "MODIFIED=PASS;4controlledMeasurement200;factoryFulfilled4"};nativeDirect;trustedTypesRetained;scriptCSPRetained;badIntegrityBlocked;opaqueSandboxRetained;unrelatedBlankUnchanged;generation=${generation};profile=${profile};exit0`,
    );
}
