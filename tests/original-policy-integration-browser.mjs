/** Actual controller + document + graph original-policy integration.
 * Website transport is deterministic; the socket observer delegates unchanged
 * to the actual default connector. This is not complete physical/public-site qualification. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(),
  evidence = join(root, "evidence/original-policy-integration-20261016");
await fs.mkdir(evidence, { recursive: true });
const temporary = await fs.mkdtemp(join(tmpdir(), "atlas-original-policy-"));
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
function replace(from, to) {
  assert.equal(
    source.split(from).length,
    2,
    "policy fixture source changed: " + from.slice(0, 80),
  );
  source = source.replace(from, to);
}
replace(
  "export {createFrontendBrowser} from './frontend-browser.ts';",
  "export {createFrontendBrowser} from './frontend-browser.ts';export {createSandboxRelayWebSocketConnect} from './sandbox-relay.ts';",
);
replace(
  'const { createFrontendBrowser } = await import("/fixture.js");',
  'const { createFrontendBrowser, createSandboxRelayWebSocketConnect } = await import("/fixture.js");',
);
replace(
  "    window.jointCalls = calls;",
  "    window.jointCalls = calls;window.policySocketAttempts=[];",
);
replace(
  "      components: {",
  `      components: {
        socket: fixed => {const actual=createSandboxRelayWebSocketConnect(fixed);return (...args)=>{window.policySocketAttempts.push(args[0]);return actual(...args)}},`,
);
replace(
  'componentsOverride: ["fetch"],',
  'componentsOverride: ["fetch deterministic payload", "socket transparent observer; actual default connector"],',
);
replace(
  "<head><title>Native site</title>",
  `<head><title>Native site</title><script>window.policyBlockedInline=true;</script><script src="https://site.example/denied-classic.js"></script><script type="module" src="https://site.example/allowed/main.js"></script>`,
);
replace(
  "<script>\n  (async()=>{let parentFrontendLeak=false;",
  `<script nonce="dGVzdA==">\n  (async()=>{
  window.policyCompilation={eval:false,Function:false,wasm:false};
  try{eval('window.policyCompilation.eval=true')}catch{}
  try{Function('window.policyCompilation.Function=true')()}catch{}
  try{new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));window.policyCompilation.wasm=true}catch{}
  window.policyFetchDenied=false;
  try {await fetch('https://site.example/allowed/data')}catch{window.policyFetchDenied=true}
  const denied=document.createElement('script');denied.src='https://site.example/denied-dynamic.js';document.head.appendChild(denied);
  const inline=document.createElement('script');inline.textContent='window.policyBlockedDynamicInline=true';document.head.appendChild(inline);
  const allowed=document.createElement('script');allowed.src='https://site.example/allowed/dynamic.js';document.head.appendChild(allowed);
  window.policySocketDenied=await new Promise(resolve=>{try{const s=new WebSocket('wss://site.example/socket');s.onopen=()=>{s.close();resolve(false)};s.onerror=()=>resolve(true);setTimeout(()=>resolve(false),3000)}catch{resolve(true)}});
  let parentFrontendLeak=false;`,
);
replace(
  "default-src 'none'; script-src https://assets.example 'unsafe-inline'; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
  "default-src 'none'; script-src https://assets.example https://site.example/allowed/ 'nonce-dGVzdA=='; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
);
replace(
  '      } else throw Error("Synthetic transport denied");',
  `      } else if (request.url === "https://site.example/allowed/main.js") {
        body="import {value} from './nested.js';window.policyModule=value";type="application/javascript";
      } else if (request.url === "https://site.example/allowed/nested.js") {
        body="export const value='module-allowed'";type="application/javascript";
      } else if(request.url === "https://site.example/allowed/dynamic.js") {
        body="window.policyDynamicAllowed=true";type="application/javascript";
      } else if(request.url === "https://site.example/denied-classic.js") {
        body="window.policyBlockedClassic=true";type="application/javascript";
      } else if(request.url === "https://site.example/denied-dynamic.js") {
        body="window.policyBlockedDynamic=true";type="application/javascript";
      } else if(request.url === "https://site.example/allowed/data") {
        body="not allowed by connect-src";type="text/plain";
      } else throw Error("Synthetic transport denied");`,
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `  await frame.waitForFunction(()=>window.policyModule==='module-allowed'&&window.policyDynamicAllowed===true);
  const policyResult=await frame.evaluate(()=>({inline:!!window.policyBlockedInline,classic:!!window.policyBlockedClassic,dynamic:!!window.policyBlockedDynamic,dynamicInline:!!window.policyBlockedDynamicInline,fetchDenied:window.policyFetchDenied,socketDenied:window.policySocketDenied,module:window.policyModule,dynamicAllowed:window.policyDynamicAllowed,compilation:window.policyCompilation}));
  const policyRequests=await page.evaluate(()=>jointCalls.map(v=>v.url));
  const socketAttempts=await page.evaluate(()=>window.policySocketAttempts);
  console.log(JSON.stringify({originalPolicyIntegration:policyResult,deniedTransportRequests:policyRequests.filter(v=>v.includes('/denied-')||v.endsWith('/allowed/data')),socketAttempts,physicalPolicyComplete:false}));
  assert.deepEqual(policyResult,{inline:false,classic:false,dynamic:false,dynamicInline:false,fetchDenied:true,socketDenied:true,module:'module-allowed',dynamicAllowed:true,compilation:{eval:false,Function:false,wasm:false}});
  assert.equal(policyRequests.some(v=>v.includes('/denied-')||v.endsWith('/allowed/data')),false);
  assert.deepEqual(socketAttempts,[]);
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(
    join(
      evidence,
      process.env.ATLAS_ORIGINAL_POLICY_BASELINE === "1"
        ? "BASELINE-RECEIPT.json"
        : "MODIFIED-RECEIPT.json",
    ),
  ),
);
if (process.env.ATLAS_ORIGINAL_POLICY_BASELINE === "1") {
  const copy = join(temporary, "source");
  await fs.mkdir(join(copy, "runtime"), { recursive: true });
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copy, "runtime", file),
      );
  for (const file of [
    "opaque-document.ts",
    "opaque-resource-graph.ts",
    "opaque-runtime-adapter.ts",
    "sandbox-controller.ts",
    "sandbox-network.ts",
  ])
    await fs.copyFile(
      join(evidence, "before", file),
      join(copy, "runtime", file),
    );
  for (const name of ["scripts", "node_modules", "web"])
    await fs.symlink(join(root, name), join(copy, name), "dir");
  await fs.symlink(
    join(root, "runtime/public"),
    join(copy, "runtime/public"),
    "dir",
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
