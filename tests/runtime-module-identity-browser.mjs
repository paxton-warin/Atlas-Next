/** Anonymous synthetic React/hooks/ESM singleton diagnostic. No production writes.
 * Native control and actual prepared pinned Controller/core Window rewriting.
 * The transport is an explicit loopback-only synthetic resource provider; this
 * does not qualify GFN/Epic authentication or the real custom network engine. */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { adaptModuleIdentity } from "../scripts/runtime-module-identity.mjs";
import { adaptNormalRuntimeCore } from "../scripts/runtime-normal-core.mjs";
import { adaptToggleAttribute } from "../scripts/runtime-toggle-attribute.mjs";
import { adaptLiteralEval } from "../scripts/runtime-literal-eval.mjs";
import { adaptGfnIma } from "../scripts/runtime-gfn-ima.mjs";
import { adaptRequestCancellationCore } from "../scripts/runtime-request-cancellation.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const baseline = process.argv.includes("--baseline");
const E = resolve("test-results/runtime-module-identity");
await mkdir(E, { recursive: true });
const hash = (b) => createHash("sha256").update(b).digest("hex");
const bundle = async (contents, external = []) =>
  (
    await build({
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      external,
      stdin: { resolveDir: process.cwd(), loader: "js", contents },
    })
  ).outputFiles[0].text;
const reactExports = Object.keys(
  createRequire(import.meta.url)("react"),
).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
const react =
  "globalThis.reactModuleEvaluations=(globalThis.reactModuleEvaluations||0)+1;\n" +
  (await bundle(
    `import React from 'react';export const {${reactExports.join(",")}}=React;export default React;`,
  ));
const renderer = (
  await build({
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { "process.env.NODE_ENV": '\"production\"' },
    external: ["native-react"],
    plugins: [
      {
        name: "fixture-external-react",
        setup(b) {
          b.onResolve({ filter: /^react$/ }, () => ({
            path: "external-react",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `import React from 'native-react';globalThis.rendererReact=React;export const {${reactExports.join(",")}}=React;export default React;`,
            loader: "js",
          }));
        },
      },
    ],
    stdin: {
      resolveDir: process.cwd(),
      loader: "js",
      contents: `export {createRoot} from 'react-dom/client';`,
    },
  })
).outputFiles[0].text;
const app = `import React,{useMemo,useState,useEffect,useRef,useCallback,useContext,createContext} from 'react';import {createRoot} from 'https://renderer.fixture.test/renderer.js';
const C=createContext('context-ok');globalThis.probeReact=React;globalThis.hookCalls=0;globalThis.effectCalls=0;
function App(){hookCalls++;const[n,setN]=useState(1),v=useMemo(()=>n*2,[n]),r=useRef('ref-ok'),ctx=useContext(C),click=useCallback(()=>setN(x=>x+1),[]);useEffect(()=>{effectCalls++},[n]);return React.createElement('button',{id:'hooks',onClick:click},[v,r.current,ctx].join('|'))}
createRoot(document.querySelector('#root')).render(React.createElement(App));
globalThis.singletonCheck=Promise.all([import('react'),import('https://cdn.fixture.test/react.js'),import('https://cdn.fixture.test/react.js')]).then(([a,b,c])=>({same:a.default===b.default&&b.default===c.default&&a.default===probeReact,versions:[a.version,b.version,c.version]}));`;
const absoluteApp = app
  .replaceAll("from 'react'", "from 'https://cdn.fixture.test/react.js'")
  .replaceAll("import('react')", "import('https://cdn.fixture.test/react.js')")
  .replaceAll("/renderer.js", "/renderer-absolute.js");
const absoluteRenderer = renderer.replaceAll(
  '\"native-react\"',
  '\"https://cdn.fixture.test/react.js\"',
);
const sameOriginApp = app
  .replaceAll(
    "https://renderer.fixture.test/renderer.js",
    "https://app.fixture.test/renderer.js",
  )
  .replaceAll(
    "https://cdn.fixture.test/react.js",
    "https://app.fixture.test/react.js",
  );
const allInOne = await bundle(
  `import React,{useState,useMemo,useEffect} from 'react';import{createRoot}from'react-dom/client';globalThis.hookCalls=0;globalThis.effectCalls=0;function App(){hookCalls++;const[n,setN]=useState(1),v=useMemo(()=>n*2,[n]);useEffect(()=>{effectCalls++},[n]);return React.createElement('button',{id:'hooks',onClick:()=>setN(n+1)},String(v))};createRoot(document.querySelector('#root')).render(React.createElement(App));`,
);
const fixture = (url, native = false) => {
  const u = new URL(url),
    p = u.pathname;
  if (p === "/react.js") return { type: "application/javascript", body: react };
  if (p === "/renderer-absolute.js")
    return { type: "application/javascript", body: absoluteRenderer };
  if (p === "/app-absolute.js")
    return { type: "application/javascript", body: absoluteApp };
  if (p === "/renderer.js")
    return { type: "application/javascript", body: renderer };
  if (p === "/app.js")
    return {
      type: "application/javascript",
      body: u.searchParams.get("same")
        ? "// same-origin\n" + sameOriginApp
        : app,
    };
  if (p === "/bundle.js")
    return { type: "application/javascript", body: allInOne };
  if (
    p === "/classic" ||
    p === "/modules" ||
    p === "/modules-same" ||
    p === "/modules-absolute"
  ) {
    const same = p === "/modules-same";
    return {
      type: "text/html",
      body: `<!doctype html><title>Synthetic React hook fixture</title><div id="root"></div>${p === "/classic" ? '<script type="module" src="https://app.fixture.test/bundle.js"></script>' : `<script type="importmap">{"imports":{"react":"https://${same ? "app" : "cdn"}.fixture.test/react.js","native-react":"https://${same ? "app" : "cdn"}.fixture.test/react.js"}}</script><script type="module" src="https://app.fixture.test/${p === "/modules-absolute" ? "app-absolute.js" : "app.js"}${same ? "?same=1" : ""}"></script>`}`,
    };
  }
  return { type: "text/plain", body: "missing", status: 404 };
};
const baselineCore = adaptRequestCancellationCore(
  adaptLiteralEval(
    adaptToggleAttribute(
      adaptNormalRuntimeCore(
        await readFile("upstream/scramjet-ls-bypass/app/vendor/runtimekit.js"),
      ),
    ),
  ),
);
if (baseline && process.argv.includes("--with-gfn-ima"))
  throw Error("--with-gfn-ima qualifies the candidate only");
const moduleCandidateCore = adaptModuleIdentity(baselineCore);
const candidateCore = process.argv.includes("--with-gfn-ima")
  ? adaptGfnIma(moduleCandidateCore)
  : moduleCandidateCore;
const copyIndex = process.argv.indexOf("--core-file");
const coreFile = copyIndex < 0 ? null : process.argv[copyIndex + 1];
if (copyIndex >= 0 && (!coreFile || coreFile.startsWith("--")))
  throw Error("--core-file requires a local core path");
const selectedCore = coreFile
  ? await readFile(resolve(coreFile))
  : baseline
    ? baselineCore
    : candidateCore;
assert.equal(
  hash(selectedCore),
  hash(baseline ? baselineCore : candidateCore),
  "Explicit core copy must match selected frozen baseline or candidate",
);
const assets = {};
for (const path of [
  "/runtime/runtimekit-normal.js",
  "/runtime/runtimekit-utils.js",
  "/runtime/runtimekit.wasm",
  "/controller/controller.api.js",
  "/controller/controller.inject.js",
  "/controller/controller.worker.js",
])
  assets[path] =
    path === "/runtime/runtimekit-normal.js"
      ? selectedCore
      : await readFile("runtime/public" + path);
const requests = [],
  connections = new Set();
const appServer = createServer((q, r) => {
  const u = new URL(q.url, "http://fixture.invalid");
  r.setHeader("cache-control", "no-store");
  if (u.pathname === "/worker.js") {
    r.setHeader("content-type", "application/javascript");
    r.end(
      `importScripts('/controller/controller.worker.js');self.addEventListener('fetch',event=>{if($runtimekitController.shouldRoute(event))event.respondWith($runtimekitController.route(event))});`,
    );
    return;
  }
  if (assets[u.pathname]) {
    r.setHeader(
      "content-type",
      u.pathname.endsWith(".wasm")
        ? "application/wasm"
        : "application/javascript",
    );
    r.end(assets[u.pathname]);
    return;
  }
  if (u.pathname === "/fixture") {
    const target = u.searchParams.get("url"),
      v = fixture(target);
    requests.push({ target, mode: q.headers["x-fixture-mode"] || null });
    r.writeHead(v.status || 200, {
      "content-type": v.type,
      "access-control-allow-origin": "*",
    });
    r.end(v.body);
    return;
  }
  if (u.pathname === "/native") {
    const v = fixture("https://app.fixture.test/" + u.searchParams.get("case"));
    r.setHeader("content-type", "text/html");
    r.end(v.body);
    return;
  }
  r.setHeader("content-type", "text/html");
  r.end(
    '<!doctype html><title>Trusted generic runtime diagnostic</title><iframe id="site"></iframe>',
  );
});
appServer.on("connection", (s) => {
  connections.add(s);
  s.on("close", () => connections.delete(s));
});
await new Promise((r) => appServer.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + appServer.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--no-proxy-server"],
});
const rows = [];
let report;
try {
  for (const native of [true, false]) {
    const ctx = await browser.newContext(),
      p = await ctx.newPage(),
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    const nativeURLs = [];
    p.on("request", (r) => nativeURLs.push(r.url()));
    if (native) {
      await ctx.route("https://**.fixture.test/**", (route) => {
        const v = fixture(route.request().url());
        return route.fulfill({
          status: v.status || 200,
          contentType: v.type,
          body: v.body,
          headers: { "access-control-allow-origin": "*" },
        });
      });
    } else {
      await p.goto(origin);
      await p.evaluate(async () => {
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
            document.head.append(s);
          });
        const fetch = window.fetch.bind(window),
          transport = {
            ready: true,
            async init() {},
            async request(remote, method, body, headers, signal) {
              const r = await fetch(
                "/fixture?url=" + encodeURIComponent(remote.href),
                {
                  signal,
                  headers: { "x-fixture-mode": "controller-synthetic" },
                },
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
              throw Error("fixture sockets are out of scope");
            },
          };
        const { Controller, config } = $runtimekitController;
        config.injectPath = "/controller/controller.inject.js";
        config.wasmPath = "/runtime/runtimekit.wasm";
        config.runtimekitPath = "/runtime/runtimekit-normal.js";
        window.ctrl = new Controller({ serviceworker: reg.active, transport });
        await ctrl.wait();
        window.frame = ctrl.createFrame(document.querySelector("#site"));
      });
    }
    for (const name of [
      "classic",
      "modules-same",
      "modules",
      "modules-absolute",
    ]) {
      const index = requests.length,
        errorIndex = errors.length,
        urlIndex = nativeURLs.length;
      let f;
      if (native) {
        await p.goto(origin + "/native?case=" + name);
        f = p.mainFrame();
      } else {
        await p.evaluate(
          (name) => frame.go("https://app.fixture.test/" + name),
          name,
        );
        await p.waitForTimeout(100);
        f = p.frames().find((f) => f.parentFrame() === p.mainFrame());
      }
      let row = { native, case: name };
      try {
        await f.waitForFunction(
          () => document.querySelector("#hooks")?.textContent?.startsWith("2"),
          null,
          { timeout: 12000 },
        );
        const before = await f.evaluate(() => ({
          text: document.querySelector("#hooks").textContent,
          hookCalls,
          effectCalls,
          singleton:
            typeof singletonCheck === "undefined" ? null : singletonCheck,
        }));
        await f.locator("#hooks").click();
        await f.waitForFunction(
          () =>
            document.querySelector("#hooks")?.textContent?.startsWith("4") &&
            globalThis.effectCalls === 2,
          null,
          { timeout: 4000 },
        );
        const after = await f.evaluate(async () => ({
          text: document.querySelector("#hooks").textContent,
          hookCalls,
          effectCalls,
          evaluations: globalThis.reactModuleEvaluations ?? null,
          rendererSame: globalThis.rendererReact === globalThis.probeReact,
          singleton:
            typeof singletonCheck === "undefined" ? null : await singletonCheck,
        }));
        row = {
          ...row,
          result: "PASS",
          before,
          after,
          errors: errors.slice(errorIndex),
          requests: requests.slice(index),
        };
        assert.equal(after.singleton?.same ?? true, true);
        assert.equal(after.effectCalls, 2);
        assert.equal(after.hookCalls, 2);
        if (name !== "classic") {
          assert.equal(after.rendererSame, true);
          assert.equal(after.evaluations, 1);
        }
        assert.deepEqual(row.errors, []);
      } catch (e) {
        row = {
          ...row,
          result: "FAIL",
          error: String(e),
          singleton: await f
            .evaluate(async () => ({
              evaluations: globalThis.reactModuleEvaluations ?? null,
              rendererSame: globalThis.rendererReact === globalThis.probeReact,
              singleton:
                typeof singletonCheck === "undefined"
                  ? null
                  : await singletonCheck,
            }))
            .catch((e) => ({ error: String(e) })),
          errors: errors.slice(errorIndex),
          requests: requests.slice(index),
        };
      }
      row.nativeModuleURLs = nativeURLs
        .slice(urlIndex)
        .filter(
          (u) =>
            u.includes("react.js") || u.includes("/~/") || u.includes("v1."),
        );
      rows.push(row);
    }
    await ctx.close();
  }
  const absolute = rows.find((r) => !r.native && r.case === "modules-absolute");
  if (baseline) {
    assert.ok(
      rows
        .filter((r) => r.native || r.case !== "modules-absolute")
        .every((r) => r.result === "PASS"),
    );
    assert.equal(absolute.result, "FAIL");
    assert.equal(absolute.singleton.evaluations, 2);
    assert.equal(absolute.singleton.rendererSame, false);
    assert.ok(
      absolute.errors.some((e) => e.includes("Cannot read properties of null")),
    );
  } else {
    assert.ok(rows.every((r) => r.result === "PASS"));
    assert.equal(absolute.after.evaluations, 1);
    assert.equal(absolute.after.rendererSame, true);
  }
  report = {
    result: baseline
      ? "BASELINE_DEFECT_REPRODUCED"
      : "MODIFIED_ALL_8_CASES_PASS",
    variant: baseline ? "baseline" : "modified",
    coreCopy: coreFile ? resolve(coreFile) : null,
    scope:
      "Synthetic React19.3 production hooks, real prepared pinned Window/controller/core. Loopback synthetic transport; no GFN/Epic real app/authentication or real HTTP engine qualification.",
    browser: browser.version(),
    assetSHA256: Object.fromEntries(
      Object.entries(assets).map(([k, v]) => [k, hash(v)]),
    ),
    fixtures: {
      reactVersion: JSON.parse(
        await readFile("node_modules/react/package.json"),
      ).version,
      reactSHA256: hash(react),
      rendererSHA256: hash(renderer),
    },
    rows,
  };
} catch (e) {
  report = { result: "FAIL", error: String(e), rows };
  throw e;
} finally {
  await writeFile(
    E + "/" + (baseline ? "baseline" : "modified") + ".json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
  for (const c of connections) c.destroy();
  await new Promise((r) => appServer.close(r));
  if (report.result !== "FAIL") {
    const reopened = JSON.parse(
      await readFile(
        E + "/" + (baseline ? "baseline" : "modified") + ".json",
        "utf8",
      ),
    );
    assert.equal(reopened.result, report.result);
    console.log(
      baseline
        ? "BASELINE=REPRODUCED;native4pass;rewritten3pass;crossCDNduplicatedReact2;rendererMismatch;exit0"
        : "MODIFIED=PASS;native4pass;rewritten4pass;ReactSingleton1;hooksAndEffectsExact;errors0;exit0",
    );
  }
}
