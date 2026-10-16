/** Real pinned runtime + client-local graph component probe. Website resources
 * are supplied by a trusted in-memory transport fixture, never frontend HTTP.
 */
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
  "/dynamic.js": compile("opaque-dynamic-resources"),
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
  "/native.js": [
    "application/javascript",
    "globalThis.crossSitePrivateMustNotRun=true;",
  ],
  "/classic.js": [
    "application/javascript",
    "globalThis.fixtureClassic=location.origin;",
  ],
  "/dynamic-classic.js": [
    "application/javascript",
    "globalThis.dynamicClassic=location.origin;",
  ],
  "/dynamic-module.js": [
    "application/javascript",
    "import {value} from 'lib'; globalThis.dynamicModule=value;",
  ],
  "/dynamic.css": ["text/css", "#dynamic-marker{color:rgb(40,50,60)}"],
  "/app/main.js": [
    "application/javascript",
    "import {value} from 'lib'; import {leaf} from 'pkg/leaf.js'; globalThis.fixtureCycle=value+leaf; globalThis.fixtureDynamic=import('lazy').then(m=>globalThis.fixtureLazy=m.default); globalThis.resolvedBare=import.meta.resolve('lib');",
  ],
  "/scoped.js": ["application/javascript", "export const value='SCOPED';"],
  "/global-lib.js": ["application/javascript", "export const value='GLOBAL';"],
  "/pkg/leaf.js": ["application/javascript", "export const leaf='-PREFIX';"],
  "/lazy.js": [
    "application/javascript",
    "export default 'dynamic-bare-loaded';",
  ],
  "/style.css": [
    "text/css",
    '@font-face{font-family:fixturefont;src:url("https://cdn.fixture.test/font.woff2")} body{color:rgb(10,20,30);background-image:url("https://cdn.fixture.test/pixel.png");font-family:fixturefont}',
  ],
  "/font.woff2": [
    "font/woff2",
    [
      ...fs.readFileSync(
        new URL(
          "./fonts/KaTeX_Main-Regular.woff2",
          new URL(
            "file://" +
              createRequire(import.meta.url).resolve(
                "katex/dist/katex.min.css",
              ),
          ),
        ),
      ),
    ],
  ],
  "/pixel.png": ["image/png", png],
  "/tamper-pixel.png": ["image/png", png],
};
const sri = (source) =>
  "sha384-" + createHash("sha384").update(source).digest("base64");
const importmap = {
  imports: {
    lib: "/global-lib.js",
    "pkg/": "https://cdn.fixture.test/pkg/",
    lazy: "https://cdn.fixture.test/lazy.js",
  },
  scopes: {
    "https://cdn.fixture.test/app/": {
      lib: "https://cdn.fixture.test/scoped.js",
    },
  },
};
const websiteHTML =
  '<html><head><script type="importmap">' +
  JSON.stringify(importmap) +
  '</script><link rel="stylesheet" crossorigin="anonymous" href="https://cdn.fixture.test/style.css" integrity="' +
  sri(resources["/style.css"][1]) +
  '"><script crossorigin="anonymous" src="https://cdn.fixture.test/classic.js" integrity="' +
  sri(resources["/classic.js"][1]) +
  '"></script><script type="module" src="https://cdn.fixture.test/app/main.js" integrity="' +
  sri(resources["/app/main.js"][1]) +
  '"></script><script type="module">import {value} from "lib";globalThis.inlineModuleValue=value;</script></head><body><img crossorigin="anonymous" id="fixture-image" src="https://cdn.fixture.test/pixel.png"><div id="fixture-ready">general-resources</div></body></html>';
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
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: http:; connect-src http: blob:; style-src 'unsafe-inline' blob:; img-src blob:; font-src blob:",
    );
    reply.end(`<!doctype html><html><head><script src="/core.js"></script></head><body><script type="module">
      import {bootOpaqueRuntimeClient,createOpaqueNetworkClient,createPinnedOpaqueRewriter} from '/adapter.js';
      import {createOpaqueResourceGraph} from '/graph.js';
      import {installOpaqueDynamicResources} from '/dynamic.js';
      const originalWrite=Document.prototype.write,originalOpen=Document.prototype.open,originalClose=Document.prototype.close;
      const originalEval=window.eval,notify=parent.postMessage.bind(parent);
      const natives={getAttribute:Element.prototype.getAttribute,DOMParser,Blob,createObjectURL:URL.createObjectURL.bind(URL),revokeObjectURL:URL.revokeObjectURL.bind(URL),importModule:Function('url','return import(url)'),appendChild:Node.prototype.appendChild,setAttribute:Element.prototype.setAttribute};
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

          const nativeTamper={digest:crypto.subtle.digest,blob:Blob.prototype.arrayBuffer,encode:TextEncoder.prototype.encode,btoa:window.btoa};
          let intrinsicCapture;
          try {
            crypto.subtle.digest=async()=>new Uint8Array(48).buffer;
            Blob.prototype.arrayBuffer=async()=>{throw Error('website replaced Blob.arrayBuffer')};
            TextEncoder.prototype.encode=function(){throw Error('website replaced TextEncoder.encode')};
            window.btoa=()=> 'invalid';
            let rejected;try{await graph.prepareModule('/integrity-only.js',documentURL,'sha384-invalid');rejected=false}catch(error){rejected=error.name==='SecurityError'}
            const probe=document.createElement('img');natives.setAttribute.call(probe,'src','https://cdn.fixture.test/tamper-pixel.png');await graph.prepareElement(probe);
            intrinsicCapture={badOriginalRejected:rejected,imageDigest:graph.integrityForBlob(natives.getAttribute.call(probe,'src'))};
          } finally {crypto.subtle.digest=nativeTamper.digest;Blob.prototype.arrayBuffer=nativeTamper.blob;TextEncoder.prototype.encode=nativeTamper.encode;window.btoa=nativeTamper.btoa;}
          const html=await graph.prepareDocument(event.data.html);
          try {await graph.prepareModule('https://cdn.fixture.test/app/main.js',documentURL,'sha384-invalid');denials.cachedModuleIntegrity='unexpected-success'}catch(error){denials.cachedModuleIntegrity=error.name}
          const storage=()=>{let data=new Map();return{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),clear:()=>data.clear(),key:n=>[...data.keys()][n]??null,get length(){return data.size}}};
          const boot=bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL,prefix:location.origin+'/~/app/graph/',network,localStorage:storage(),sessionStorage:storage(),installIndexedDB:()=>{},onNavigate:()=>{},sendSetCookie:async()=>{},importModule:(base,specifier)=>graph.importModule(base,specifier),resolveModule:(base,specifier)=>graph.resolveModule(base,specifier)});
          originalOpen.call(document);originalWrite.call(document,html);originalClose.call(document);
          for(let n=0;n<200&&(!window.fixtureLazy||!window.inlineModuleValue);n++)await new Promise(r=>setTimeout(r,5));await document.fonts.load('16px fixturefont');
          let denied;try{void parent.document.body;denied=false}catch{denied=true}
          const image=document.getElementById('fixture-image');const inlineModule=window.inlineModuleValue,resolvedBare=window.resolvedBare,fontLoaded=document.fonts.check('16px fixturefont');
          const dynamicAdapter=installOpaqueDynamicResources({global:window,client:boot.client,graph});
          originalEval(rewriter.javascript(\`
            globalThis.dynamicDone=(async()=>{
              const load=(element,parent)=>new Promise((resolve,reject)=>{element.onload=()=>resolve();element.onerror=()=>reject(Error('dynamic load failed'));parent.appendChild(element)});
              const script=document.createElement('script');script.src='https://cdn.fixture.test/dynamic-classic.js';await load(script,document.head);
              const module=document.createElement('script');module.type='module';module.src='https://cdn.fixture.test/dynamic-module.js';await load(module,document.head);
              const image=document.createElement('img');image.id='dynamic-image';image.src='https://cdn.fixture.test/pixel.png';await load(image,document.body);
              const marker=document.createElement('div');marker.id='dynamic-marker';document.body.append(marker);
              const link=document.createElement('link');link.rel='stylesheet';link.href='https://cdn.fixture.test/dynamic.css';await load(link,document.head);
              globalThis.dynamicImage=image.complete&&image.naturalWidth===1;
              globalThis.dynamicColor=getComputedStyle(marker).color;
            })();
          \`,documentURL));
          await window.dynamicDone;
          const dynamic={classic:window.dynamicClassic,module:window.dynamicModule,image:window.dynamicImage,color:window.dynamicColor};
          const integrityAttested=Array.from(document.querySelectorAll('[integrity]')).every(element=>{const url=natives.getAttribute.call(element,'src')||natives.getAttribute.call(element,'href');return graph.integrityForBlob(url)===natives.getAttribute.call(element,'integrity')});
          notify({type:'graph-result',classic:window.fixtureClassic,cycle:window.fixtureCycle,lazy:window.fixtureLazy,color:getComputedStyle(document.body).color,image:image.complete&&image.naturalWidth===1,parentDenied:denied,denials,inlineModule,resolvedBare,fontLoaded,dynamic,integrityAttested,intrinsicCapture,resourceCount:graph.resourceCount,htmlHasProxyPath:html.includes('/~/app/graph/')},'*');
          dynamicAdapter.dispose();graph.dispose();boot.dispose();
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
                  headers: [
                    ["content-type", resource[0]],
                    ...(new URL(request.url).hostname === "cdn.fixture.test"
                      ? [
                          [
                            "access-control-allow-origin",
                            "https://website.test",
                          ],
                        ]
                      : []),
                  ],
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
    cachedModuleIntegrity: "SecurityError",
  });
  assert.equal(result.classic, "https://website.test");
  assert.equal(result.cycle, "SCOPED-PREFIX");
  assert.equal(result.inlineModule, "GLOBAL");
  assert.equal(result.resolvedBare, "https://cdn.fixture.test/scoped.js");
  assert.equal(result.fontLoaded, true);
  assert.equal(result.lazy, "dynamic-bare-loaded");
  assert.deepEqual(result.dynamic, {
    classic: "https://website.test",
    module: "GLOBAL",
    image: true,
    color: "rgb(40, 50, 60)",
  });
  assert.equal(result.integrityAttested, true);
  assert.deepEqual(result.intrinsicCapture, {
    badOriginalRejected: true,
    imageDigest: sri(new Uint8Array(png)),
  });
  assert.equal(result.color, "rgb(10, 20, 30)");
  assert.equal(result.image, true);
  assert.equal(result.parentDenied, true);
  assert.equal(result.parentCannotRead, true);
  assert.equal(result.htmlHasProxyPath, false);
  assert.ok(
    result.calls.every((call) => call.origin === "https://website.test"),
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
    "GENERAL_RESOURCE_RESULT: CORS-readable scripts/styles/images/fonts + original SRI + scoped/prefix/bare importmaps + inline modules PASS",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
