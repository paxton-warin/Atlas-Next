/** Standalone component probe; does not start Atlas, rebuild dist or use accounts.
 * Run: node tests/opaque-runtime-browser.mjs
 */
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { adaptPinnedRuntimeBundle } from "./opaque-runtime-fork.mjs";
const documentURL = "https://website.test/path/index.html";
const root = new URL("../", import.meta.url);
const stock = fs.readFileSync(
  new URL("runtime/public/runtime/runtimekit.js", root),
  "utf8",
);
const rollbackCopy = process.argv
  .find((value) => value.startsWith("--rollback-copy="))
  ?.slice("--rollback-copy=".length);
const experimental = rollbackCopy
  ? fs.readFileSync(rollbackCopy, "utf8")
  : adaptPinnedRuntimeBundle(stock);
const wasm = fs.readFileSync(
  new URL("runtime/public/runtime/runtimekit.wasm", root),
);
const compile = (name) =>
  ts.transpileModule(
    fs.readFileSync(new URL(`runtime/${name}.ts`, root), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
const adapter = compile("opaque-runtime-adapter"),
  broker = compile("sandbox-network");
const requests = [];
const server = http.createServer((request, reply) => {
  requests.push(request.url);
  reply.setHeader("Cache-Control", "no-store");
  reply.setHeader("Access-Control-Allow-Origin", "*");
  const js = (value) => {
    reply.setHeader("Content-Type", "application/javascript");
    reply.end(value);
  };
  if (request.url === "/stock.js") return js(stock);
  if (request.url === "/experimental.js") return js(experimental);
  if (request.url === "/adapter.js") return js(adapter);
  if (request.url === "/broker.js") return js(broker);
  if (request.url === "/runtimekit.wasm") {
    reply.end(wasm);
    return;
  }
  if (request.url === "/frame?modified" || request.url === "/frame?baseline") {
    const modified = request.url.endsWith("modified");
    reply.setHeader("Content-Type", "text/html");
    reply.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http:; connect-src http:; style-src 'unsafe-inline'",
    );
    reply.end(`<!doctype html><html><head><script src="/${modified ? "experimental" : "stock"}.js"></script></head><body><script type="module">
      import { bootOpaqueRuntimeClient, createOpaqueNetworkClient, createPinnedOpaqueRewriter } from '/adapter.js';
      const documentURL = ${JSON.stringify(documentURL)};
      const wasm = new Uint8Array(await (await fetch('/runtimekit.wasm')).arrayBuffer());
      const originalEval = window.eval;
      const notify = parent.postMessage.bind(parent);
      const report = (value) => notify({type:'probe-result',...value},'*');
      addEventListener('message', async function receive(event) {
        if (event.source !== parent || event.data?.type !== 'opaque-probe-init' || event.ports.length !== 1) return;
        removeEventListener('message',receive);
        const port=event.ports[0];
        try {
          if (!${JSON.stringify(modified)}) {
            const {context}=createPinnedOpaqueRewriter({core:$runtimekit,wasm,documentURL,prefix:location.origin+'/~/app/probe/'});
            new $runtimekit.RuntimeKitClient(window,{context,transport:{ready:true,init:async()=>{}},initHeaders:[],history:[],sendSetCookie:async()=>{},hookSubcontext:()=>{throw Error('unqualified')}});
            report({baselineUnexpectedlyBooted:true}); return;
          }
          const storage = () => { const map=new Map(); return {getItem:(k)=>map.get(String(k))??null,setItem:(k,v)=>map.set(String(k),String(v)),removeItem:(k)=>map.delete(String(k)),clear:()=>map.clear(),key:(n)=>[...map.keys()][n]??null,get length(){return map.size}} };
          const network=createOpaqueNetworkClient({port,documentId:'probe-document',documentURL});
          const boot=bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL,prefix:'http://localhost/~/app/probe/',network,
            localStorage:storage(),sessionStorage:storage(),installIndexedDB:()=>{},onNavigate:()=>{},sendSetCookie:async()=>{throw Error('unqualified cookie mutation')}});
          let parentDenied=false; try { void parent.document.body } catch { parentDenied=true }
          const script=boot.rewriter.javascript(
            '(async()=>{window.fixtureResult={origin:location.origin,href:location.href};localStorage.setItem("save","progress");window.fixtureResult.saved=localStorage.getItem("save");window.fixtureResult.reply=await(await fetch("/api")).text();document.body.innerHTML="<div id=fixture-ready>real-runtime-client</div>";})()'
          );
          await originalEval.call(window,script);
          report({modifiedBooted:true,parentDenied,result:window.fixtureResult,dom:document.getElementById('fixture-ready')?.textContent,clientVersion:$runtimekit.versionInfo.version});
          boot.dispose();
        } catch(error) { report({error:{name:error.name,message:error.message,stack:error.stack?.split('\\n').slice(0,4)}}); }
      });
      notify({type:'probe-ready'},'*');
    </script></body></html>`);
    return;
  }
  if (request.url === "/") {
    reply.setHeader("Content-Type", "text/html");
    reply.end("<!doctype html><title>Opaque Runtime Component Probe</title>");
    return;
  }
  reply.statusCode = 404;
  reply.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const results = await page.evaluate(
    async ({ documentURL }) => {
      const { bindSandboxNetwork } = await import("/broker.js");
      const results = [];
      for (const mode of ["baseline", "modified"]) {
        results.push(
          await new Promise((resolve, reject) => {
            const frame = document.createElement("iframe");
            frame.sandbox = "allow-scripts";
            frame.src = "/frame?" + mode;
            const timeout = setTimeout(
              () => reject(Error("probe timeout: " + mode)),
              10000,
            );
            let bound;
            const receive = (event) => {
              if (
                event.source !== frame.contentWindow ||
                event.origin !== "null"
              )
                return;
              if (event.data?.type === "probe-ready") {
                const channel = new MessageChannel();
                bound = bindSandboxNetwork({
                  port: channel.port1,
                  documentId: "probe-document",
                  documentURL,
                  frontendOrigin: location.origin,
                  fetch: async (request) => ({
                    url: request.url,
                    status: 200,
                    statusText: "OK",
                    headers: [["content-type", "text/plain"]],
                    body: new TextEncoder().encode("real-broker-result").buffer,
                  }),
                });
                frame.contentWindow.postMessage(
                  { type: "opaque-probe-init" },
                  "*",
                  [channel.port2],
                );
              } else if (event.data?.type === "probe-result") {
                clearTimeout(timeout);
                removeEventListener("message", receive);
                bound?.dispose();
                const result = {
                  mode,
                  ...event.data,
                  contentDocumentIsNull: frame.contentDocument === null,
                };
                frame.remove();
                resolve(result);
              }
            };
            addEventListener("message", receive);
            document.body.append(frame);
          }),
        );
      }
      return results;
    },
    { documentURL },
  );
  console.log(JSON.stringify({ results, errors, requests }, null, 2));
  assert.equal(
    results[0].error?.name,
    "SecurityError",
    "baseline native service-worker getter is an opaque-origin blocker",
  );
  if (rollbackCopy) {
    assert.equal(results[1].error?.name, "TypeError");
    assert.match(results[1].error?.message || "", /experimental fork seam/);
    assert.equal(results[1].modifiedBooted, undefined);
    console.log(
      "ROLLBACK_RESULT: stock artifact restored; opaque self-boot gate rejected; exit 0",
    );
  } else {
    assert.equal(
      results[1].modifiedBooted,
      true,
      "experimental actual RuntimeKitClient boot succeeds",
    );
    assert.equal(results[1].parentDenied, true);
    assert.equal(results[1].contentDocumentIsNull, true);
    assert.equal(results[1].result.origin, "https://website.test");
    assert.equal(results[1].result.saved, "progress");
    assert.equal(results[1].result.reply, "real-broker-result");
    assert.equal(results[1].dom, "real-runtime-client");
    assert.ok(
      !requests.some((url) => url.startsWith("/~/")),
      "fetch never attempts frontend native proxy resources",
    );
    console.log(
      "BASELINE_RESULT: SecurityError at native serviceWorker getter; exit 0",
    );
    console.log(
      "MODIFIED_RESULT: real RuntimeKit opaque boot, broker fetch, parent isolation PASS; exit 0",
    );
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
