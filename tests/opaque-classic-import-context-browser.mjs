/** Actual copied pin + built default frontend/controller/opaque document/native
 * owner/gateway, with ONLY website response payloads supplied deterministically.
 * Main Wisp probe, storage and original-policy decisions use real components.
 * Baseline runs restore historical source into another copy, not the workspace.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { chromium } from "@playwright/test";
const root = resolve(),
  evidence = join(root, "evidence/classic-import-context-20261016"),
  temporary = await fs.mkdtemp(join(tmpdir(), "atlas-classic-context-"));
const dataImageAllowed = process.env.ATLAS_DATA_IMAGE_DENY !== "1";
await fs.mkdir(evidence, { recursive: true });
// Native Chrome reference: a nonce belongs to the particular classic Script's
// fetch options, not an ambient source-URL lookup. An identical unnonced script
// executes from an allowed path but its relative dynamic module is denied.
const nativeCalls = [];
const nativeServer = http.createServer((req, res) => {
  nativeCalls.push(req.url);
  if (req.url.startsWith("/entry/shared.js")) {
    res.setHeader("content-type", "application/javascript");
    return res.end(
      '{const label=document.currentScript.dataset.context;import("../private.js?case="+label).then(m=>window.nativeContexts[label]=m.value,e=>window.nativeContexts[label]=e.name)}',
    );
  }
  if (req.url.startsWith("/private.js")) {
    res.setHeader("content-type", "application/javascript");
    return res.end('export const value="module-ok"');
  }
  res.setHeader("content-type", "text/html");
  res.setHeader(
    "content-security-policy",
    "script-src http://127.0.0.1:" +
      nativeServer.address().port +
      "/entry/ 'nonce-dGVzdA=='",
  );
  res.end(
    '<!doctype html><script nonce="dGVzdA==">window.nativeContexts={}</script><script src="/entry/shared.js" nonce="dGVzdA==" data-context="allowed"></script><script src="/entry/shared.js" data-context="denied"></script>',
  );
});
await new Promise((r) => nativeServer.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + nativeServer.address().port);
  await page.waitForFunction(
    () => Object.keys(window.nativeContexts).length === 2,
  );
  const native = await page.evaluate(() => window.nativeContexts);
  assert.deepEqual(native, { allowed: "module-ok", denied: "TypeError" });
  assert.equal(nativeCalls.includes("/private.js?case=denied"), false);
  await fs.writeFile(
    join(evidence, "NATIVE-REFERENCE.json"),
    JSON.stringify({ native, requests: nativeCalls }, null, 2) + "\n",
  );
} finally {
  await browser?.close();
  await new Promise((r) => nativeServer.close(r));
}
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
const replace = (before, after) => {
  assert.equal(
    source.split(before).length,
    2,
    "fixture seam changed: " + before.slice(0, 65),
  );
  source = source.replace(before, after);
};
replace(
  "<head><title>Native site</title>",
  `<head><title>Native site</title>
<script nonce="dGVzdA==">window.importContextResults={};window.websiteWasmDenied=false;try{new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))}catch(e){window.websiteWasmDenied=e.name==='CompileError'}</script>
<script src="https://site.example/entry/readable.js" nonce="dGVzdA==" data-context="readableAllowed"></script>
<script src="https://site.example/entry/readable.js" data-context="readableDenied"></script>
<script src="https://assets.example/entry/classic.js" nonce="dGVzdA==" data-context="nativeAllowed"></script>
<script src="https://assets.example/entry/classic.js" data-context="nativeDenied"></script>
<script nonce="dGVzdA==">import("https://modules.example/private.js?case=inlineAllowed").then(m=>window.importContextResults.inlineAllowed=m.value,e=>window.importContextResults.inlineAllowed=e.code||e.name)</script>`,
);
replace(
  "<script>\n  (async()=>{let parentFrontendLeak=false;",
  '<script nonce="dGVzdA==">\n  (async()=>{let parentFrontendLeak=false;',
);
replace(
  "default-src 'none'; script-src https://assets.example 'unsafe-inline'; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
  "default-src 'none'; script-src https://site.example/entry/ https://assets.example/entry/ https://assets.example/code 'nonce-dGVzdA=='; style-src https://assets.example; img-src https://assets.example" +
    (dataImageAllowed ? " data:" : "") +
    "; connect-src 'none'",
);
replace(
  '<body><img id="picture" src="https://assets.example/image">',
  '<body><img id="picture" src="https://assets.example/image"><img id="local-data" src="data:image/png;base64,${png}">',
);
replace(
  '      } else throw Error("Synthetic transport denied");',
  `      } else if(request.url==="https://site.example/entry/readable.js") {
        body='{const label=document.currentScript.getAttribute("data-context");import("https://modules.example/private.js?case="+label).then(m=>window.importContextResults[label]=m.value,e=>window.importContextResults[label]=e.code||e.name)}';type="application/javascript";
      } else if(request.url==="https://assets.example/entry/classic.js") {
        body="";type="application/javascript";status=302;extra=[["location","/real/classic.js"]];
      } else if(request.url==="https://assets.example/real/classic.js") {
        body='{const label=document.currentScript.getAttribute("data-context");import("./private.js?case="+label).then(m=>window.importContextResults[label]=m.value,e=>window.importContextResults[label]=e.code||e.name)}';type="application/javascript";
      } else if(request.url.startsWith("https://modules.example/private.js?")||request.url.startsWith("https://assets.example/real/private.js?")) {
        body='export const value="module-ok"';type="application/javascript";extra=[["access-control-allow-origin","https://site.example"]];
      } else throw Error("Synthetic transport denied");`,
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `  await frame.waitForFunction(()=>Object.keys(window.importContextResults||{}).length===5);
  const contextResults=await frame.evaluate(()=>window.importContextResults),contextRequests=await page.evaluate(()=>jointCalls.map(c=>c.url));
  console.log(JSON.stringify({classicImportContext:contextResults,privateRequests:contextRequests.filter(s=>s.includes("/private.js")),nativeFinalBaseVerified:contextRequests.includes("https://assets.example/real/private.js?case=nativeAllowed"),fullPolicyQualified:false}));
  await fs.writeFile(${JSON.stringify(join(evidence, process.env.ATLAS_CLASSIC_CONTEXT_BASELINE === "1" ? "BASELINE-BROWSER.json" : "MODIFIED-BROWSER.json"))},JSON.stringify({contextResults,contextRequests,fullPolicyQualified:false},null,2)+"\\n");
  assert.deepEqual(contextResults,{readableAllowed:"module-ok",readableDenied:"original_policy_denied",nativeAllowed:"module-ok",nativeDenied:"original_policy_denied",inlineAllowed:"module-ok"});
  assert.equal(contextRequests.some(s=>s.includes("/private.js?")&&s.endsWith("Denied")),false);
  const localDataImage=await frame.evaluate(()=>({width:document.getElementById('local-data').naturalWidth,websiteWasmDenied:window.websiteWasmDenied}));
  assert.equal(localDataImage.width,${dataImageAllowed ? 1 : 0});assert.equal(localDataImage.websiteWasmDenied,true);
  assert.equal(contextRequests.some(s=>s.startsWith('data:')),false);
  console.log(JSON.stringify({dataImageAllowed:${dataImageAllowed},localDataImage,noDataTransport:true}));
  await fs.writeFile(${JSON.stringify(join(evidence, dataImageAllowed ? "DATA-IMAGE-ALLOW.json" : "DATA-IMAGE-DENY.json"))},JSON.stringify({allowed:${dataImageAllowed},...localDataImage,noDataTransport:true},null,2)+"\\n");
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(join(evidence, "FRONTEND-BROWSER.json")),
);
if (
  process.env.ATLAS_CLASSIC_CONTEXT_BASELINE === "1" ||
  process.env.ATLAS_CLASSIC_CONTEXT_SOURCE_COPY
) {
  const copy = join(temporary, "source");
  await fs.mkdir(join(copy, "runtime"), { recursive: true });
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copy, "runtime", file),
      );
  for (const [file, baseline] of Object.entries({
    "opaque-resource-graph.ts": "BASELINE_GRAPH.ts",
    "opaque-runtime-adapter.ts": "BASELINE_ADAPTER.ts",
    "native-resource-preparer.ts": "BASELINE_PREPARER.ts",
    "native-resource-owner.ts": "BASELINE_OWNER.ts",
    "frontend-rewriter.ts": "BASELINE_FRONTEND_REWRITER.ts",
  }))
    await fs.copyFile(
      process.env.ATLAS_CLASSIC_CONTEXT_SOURCE_COPY
        ? join(
            resolve(process.env.ATLAS_CLASSIC_CONTEXT_SOURCE_COPY),
            "runtime",
            file,
          )
        : join(evidence, baseline),
      join(copy, "runtime", file),
    );
  await fs.mkdir(join(copy, "scripts"));
  for (const file of [
    "build-opaque-runtime.mjs",
    "opaque-httpengine.mjs",
    "runtime-fork.json",
  ])
    await fs.copyFile(join(root, "scripts", file), join(copy, "scripts", file));
  await fs.copyFile(
    process.env.ATLAS_CLASSIC_CONTEXT_SOURCE_COPY
      ? join(
          resolve(process.env.ATLAS_CLASSIC_CONTEXT_SOURCE_COPY),
          "scripts/opaque-runtime-core.mjs",
        )
      : join(evidence, "BASELINE_CORE.mjs"),
    join(copy, "scripts/opaque-runtime-core.mjs"),
  );
  for (const name of ["server", "node_modules", "web"])
    await fs.symlink(join(root, name), join(copy, name), "dir");
  await fs.symlink(
    join(root, "runtime/public"),
    join(copy, "runtime/public"),
    "dir",
  );
  replace(
    "import { buildOpaqueRuntime } from " +
      JSON.stringify(
        pathToFileURL(join(root, "scripts/build-opaque-runtime.mjs")).href,
      ) +
      ";",
    "import { buildOpaqueRuntime } from " +
      JSON.stringify(
        pathToFileURL(join(copy, "scripts/build-opaque-runtime.mjs")).href,
      ) +
      ";",
  );
  replace(
    "manifest = await buildOpaqueRuntime({ outdir: assetDir });",
    `manifest = await (async()=>{const cwd=process.cwd();process.chdir(${JSON.stringify(copy)});try{return await buildOpaqueRuntime({outdir:assetDir})}finally{process.chdir(cwd)}})();`,
  );
  replace(
    'resolveDir: resolve("runtime"),',
    `resolveDir: ${JSON.stringify(join(copy, "runtime"))},`,
  );
}
const probe = join(evidence, "probe-" + process.pid + ".mjs");
await fs.writeFile(probe, source);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await fs.rm(probe, { force: true });
  await fs.rm(temporary, { recursive: true, force: true });
}
