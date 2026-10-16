/** Real pinned runtime + client-local graph component probe. Website resources
 * are supplied by a trusted in-memory transport fixture, never frontend HTTP.
 */
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { adaptPinnedRuntimeBundle } from "./opaque-runtime-fork.mjs";
const root = new URL("../", import.meta.url);
const documentURL = "https://website.test/index.html";
const core = adaptPinnedRuntimeBundle(
  fs.readFileSync(
    new URL("runtime/public/runtime/runtimekit.js", root),
    "utf8",
  ),
);
const wasm = fs.readFileSync(
  new URL("runtime/public/runtime/runtimekit.wasm", root),
);
const compile = (name) =>
  ts
    .transpileModule(
      fs.readFileSync(new URL(`runtime/${name}.ts`, root), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      },
    )
    .outputText.replaceAll(/(from\s+["'])\.\/([^"']+)\.ts/g, "$1./$2.js")
    .replaceAll("es-module-lexer/minimal", "/lexer.js");
const modules = {
  "/adapter.js": compile("opaque-runtime-adapter"),
  "/graph.js": compile("opaque-resource-graph"),
  "/native-css-dependencies.js": compile("native-css-dependencies"),
  "/raster-image-mime.js": compile("raster-image-mime"),
  "/local-css-data-resource.js": compile("local-css-data-resource"),
  "/native-srcset.js": compile("native-srcset"),
  "/inline-svg.js": compile("inline-svg"),
  "/opaque-runtime-adapter.js": compile("opaque-runtime-adapter"),
  "/opaque-import-map.js": compile("opaque-import-map"),
  "/opaque-resource-integrity.js": compile("opaque-resource-integrity"),
  "/lexer.js": fs.readFileSync(
    new URL(import.meta.resolve("es-module-lexer/minimal")),
    "utf8",
  ),
  "/broker.js": compile("sandbox-network"),
  "/resource-response-budget.js": compile("resource-response-budget"),
  "/core.js": core,
};
const png = [
  ...Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
    "base64",
  ),
];
const resources = {
  "/integrity-only.js": [
    "application/javascript",
    "globalThis.wrongIntegrityMustNotRun=true;",
  ],
  "/classic.js": [
    "application/javascript",
    "globalThis.fixtureClassic = location.origin;",
  ],
  "/main.js": [
    "application/javascript",
    "import { cycleValue } from './a.js'; globalThis.fixtureCycle=cycleValue(); globalThis.fixtureDynamic=import('./lazy.js').then(m=>{globalThis.fixtureLazy=m.default;});",
  ],
  "/a.js": [
    "application/javascript",
    "import { labelB } from './b.js'; export const labelA='A'; export function cycleValue(){return labelA+labelB;}",
  ],
  "/b.js": [
    "application/javascript",
    "import { labelA } from './a.js'; export const labelB='B'; export function readA(){return labelA;}",
  ],
  "/lazy.js": ["application/javascript", "export default 'dynamic-loaded';"],
  "/style.css": [
    "text/css",
    'body { color:rgb(10, 20, 30); background-image:url("/pixel.png"); }',
  ],
  "/pixel.png": ["image/png", png],
};
const websiteHTML =
  '<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script src="/classic.js"></script><script type="module" src="/main.js"></script></head><body><img id="fixture-image" src="/pixel.png"><div id="fixture-ready">external-resources</div></body></html>';
const requests = [];
const server = http.createServer((request, reply) => {
  requests.push(request.url);
  reply.setHeader("Access-Control-Allow-Origin", "*");
  reply.setHeader("Cache-Control", "no-store");
  if (modules[request.url]) {
    reply.setHeader("Content-Type", "application/javascript");
    reply.end(modules[request.url]);
    return;
  }
  if (request.url === "/runtimekit.wasm") {
    reply.end(wasm);
    return;
  }
  if (request.url === "/frame") {
    reply.setHeader("Content-Type", "text/html");
    reply.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: http:; connect-src http: blob:; style-src 'unsafe-inline' blob:; img-src blob:",
    );
    reply.end(`<!doctype html><html><head><script src="/core.js"></script></head><body><script type="module">
      import {bootOpaqueRuntimeClient,createOpaqueNetworkClient,createPinnedOpaqueRewriter} from '/adapter.js';
      import {createOpaqueResourceGraph} from '/graph.js';
      const originalWrite=Document.prototype.write,originalOpen=Document.prototype.open,originalClose=Document.prototype.close;
      const originalEval=window.eval,notify=parent.postMessage.bind(parent);
      const natives={DOMParser,Blob,createObjectURL:URL.createObjectURL.bind(URL),revokeObjectURL:URL.revokeObjectURL.bind(URL),importModule:Function('url','return import(url)'),appendChild:Node.prototype.appendChild,setAttribute:Element.prototype.setAttribute};
      const wasm=new Uint8Array(await(await fetch('/runtimekit.wasm')).arrayBuffer());
      addEventListener('message',async function receive(event){if(event.source!==parent||event.data?.type!=='graph-init'||event.ports.length!==1)return;removeEventListener('message',receive);
        try {
          const documentURL=${JSON.stringify(documentURL)},port=event.ports[0];
          const network=createOpaqueNetworkClient({port,documentId:'graph-document',documentURL});
          const rewriter=createPinnedOpaqueRewriter({core:$runtimekit,wasm,documentURL,prefix:location.origin+'/~/app/graph/'});
          const graph=createOpaqueResourceGraph({documentURL,network,rewriter,document,natives});
          const denials={};
          for (const [name,html] of [
            ['integrity','<script src="/integrity-only.js" integrity="sha256-invalid"></'+'script>'],

            ['crossOrigin','<script src="https://peer.test/native.js"></'+'script>']
          ]) {try{await graph.prepareDocument(html);denials[name]='unexpected-success'}catch(error){denials[name]=error.name}}

          const html=await graph.prepareDocument(event.data.html);
          const storage=()=>{let data=new Map();return{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),clear:()=>data.clear(),key:n=>[...data.keys()][n]??null,get length(){return data.size}}};
          const boot=bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL,prefix:location.origin+'/~/app/graph/',network,localStorage:storage(),sessionStorage:storage(),installIndexedDB:()=>{},onNavigate:()=>{},sendSetCookie:async()=>{},importModule:(base,specifier)=>graph.importModule(base,specifier)});
          originalOpen.call(document);originalWrite.call(document,html);originalClose.call(document);
          for(let n=0;n<200&&!window.fixtureLazy;n++)await new Promise(r=>setTimeout(r,5));
          let denied;try{void parent.document.body;denied=false}catch{denied=true}
          const image=document.getElementById('fixture-image');
          notify({type:'graph-result',classic:window.fixtureClassic,cycle:window.fixtureCycle,lazy:window.fixtureLazy,color:getComputedStyle(document.body).color,image:image.complete&&image.naturalWidth===1,parentDenied:denied,denials,resourceCount:graph.resourceCount,htmlHasProxyPath:html.includes('/~/app/graph/')},'*');
          graph.dispose();boot.dispose();
        }catch(error){notify({type:'graph-result',error:{name:error.name,message:error.message,stack:error.stack?.split('\\n').slice(0,5)}},'*')}
      });notify({type:'graph-ready'},'*');
    </script></body></html>`);
    return;
  }
  if (request.url === "/favicon.ico") {
    reply.statusCode = 204;
    reply.end();
    return;
  }
  if (request.url === "/") {
    reply.setHeader("Content-Type", "text/html");
    reply.end("<!doctype html><title>Opaque resource graph</title>");
    return;
  }
  reply.statusCode = 404;
  reply.end("Native website requests forbidden");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage();
  const errors = [],
    consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(
    async ({ resources, html, documentURL }) => {
      const { bindSandboxNetwork } = await import("/broker.js");
      const calls = [];
      return await new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        frame.src = "/frame";
        let broker;
        const timeout = setTimeout(
          () => reject(Error("resource graph timeout")),
          12000,
        );
        addEventListener("message", function receive(event) {
          if (event.source !== frame.contentWindow || event.origin !== "null")
            return;
          if (event.data?.type === "graph-ready") {
            const channel = new MessageChannel();
            broker = bindSandboxNetwork({
              port: channel.port1,
              documentId: "graph-document",
              documentURL,
              frontendOrigin: location.origin,
              fetch: async (request, context) => {
                const path = new URL(request.url).pathname,
                  resource = resources[path];
                calls.push({
                  path,
                  mode: request.mode,
                  origin: context.origin,
                });
                if (!resource) throw Error("unregistered fixture resource");
                return {
                  url: request.url,
                  status: 200,
                  statusText: "OK",
                  headers: [["content-type", resource[0]]],
                  body:
                    typeof resource[1] === "string"
                      ? new TextEncoder().encode(resource[1]).buffer
                      : new Uint8Array(resource[1]).buffer,
                };
              },
            });
            frame.contentWindow.postMessage({ type: "graph-init", html }, "*", [
              channel.port2,
            ]);
          }
          if (event.data?.type === "graph-result") {
            clearTimeout(timeout);
            removeEventListener("message", receive);
            broker?.dispose();
            resolve({
              ...event.data,
              calls,
              parentCannotRead: frame.contentDocument === null,
            });
            frame.remove();
          }
        });
        document.body.append(frame);
      });
    },
    { resources, html: websiteHTML, documentURL },
  );
  console.log(
    JSON.stringify({ result, errors, consoleErrors, requests }, null, 2),
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.denials, {
    integrity: "SecurityError",
    crossOrigin: "OpaqueNetworkError",
  });
  assert.equal(result.classic, "https://website.test");
  assert.equal(result.cycle, "AB");
  assert.equal(result.lazy, "dynamic-loaded");
  assert.equal(result.color, "rgb(10, 20, 30)");
  assert.equal(result.image, true);
  assert.equal(result.parentDenied, true);
  assert.equal(result.parentCannotRead, true);
  assert.equal(result.htmlHasProxyPath, false);
  assert.ok(
    result.calls.every(
      (call) =>
        call.mode === (call.path === "/native.js" ? "cors" : "same-origin") &&
        call.origin === "https://website.test",
    ),
  );
  assert.ok(
    !requests.some(
      (url) =>
        url.includes("/~/") ||
        /^\/(?:classic|main|lazy|a|b)\.js/.test(url) ||
        /pixel|style\.css/.test(url),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "RESOURCE_GRAPH_RESULT: actual RuntimeKit classic+cyclic ESM+dynamic import+CSS+image through broker and child-local Blobs PASS",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
