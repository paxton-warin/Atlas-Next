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
for (const file of ['local-idb-accounting','local-dirty-v2','local-authority','local-idb-catalog','profile-locks']) app.get('/'+file+'.ts',(_q,r)=>r.header('Access-Control-Allow-Origin','*').type('application/javascript').send(transpileModule(readFileSync('runtime/'+file+'.ts','utf8'),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"')));

app.get("/sandbox-cookies.js", (_req, reply) =>
  reply
    .header("Access-Control-Allow-Origin", "*")
    .type("application/javascript")
    .send(
      transpileModule(readFileSync(process.env.ATLAS_COOKIE_SOURCE || "runtime/sandbox-cookies.ts", "utf8"), {
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module: ModuleKind.ESNext,
        },
      }).outputText.replace('from "tldts"', 'from "/tldts.js"'),
    ),
);
app.get("/profile-permissions.ts",(_q,r)=>r.header("Access-Control-Allow-Origin","*").type("application/javascript").send(transpileModule(readFileSync("runtime/profile-permissions.ts","utf8"),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"')));
app.get("/profile-idb-catalog.ts",(_q,r)=>r.header("Access-Control-Allow-Origin","*").type("application/javascript").send(transpileModule(readFileSync("runtime/profile-idb-catalog.ts","utf8"),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"')));
app.get("/profile-idb-quota.ts",(_q,r)=>r.header("Access-Control-Allow-Origin","*").type("application/javascript").send(transpileModule(readFileSync("runtime/profile-idb-quota.ts","utf8"),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"')));
app.get("/hub-contracts.ts",(_q,r)=>r.header("Access-Control-Allow-Origin","*").type("application/javascript").send(transpileModule(readFileSync("runtime/hub-contracts.ts","utf8"),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText.replace('from "tldts"','from "/tldts.js"')));
app.get("/profile-journal.ts", (_req,reply)=>reply.header("Access-Control-Allow-Origin","*").type("application/javascript").send(transpileModule(readFileSync("runtime/profile-journal.ts","utf8"),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.ESNext}}).outputText));
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
 browser=await chromium.launch({executablePath,headless:true});const context=await browser.newContext();const page=await context.newPage();const session=await context.newCDPSession(page);await session.send('Emulation.setCPUThrottlingRate',{rate:6});
 const id='aceace00-0000-4000-8000-000000000001';await page.goto(frontend);await page.evaluate(async id=>{const {setProfilePermit}=await import('/profile-permissions.ts');await setProfilePermit(indexedDB,{profileId:id,group:'cookie.example',contextId:'benchmark',epoch:1,expiresAt:Date.now()+900000,offline:false,revoked:false})},id);
 await initialize(page,{profileId:id,profileContextId:'benchmark'});
 await page.evaluate(async()=>{await jar.storeResponseCookies(Array.from({length:100},(_,i)=>'cookie'+i+'=SYNTHETIC_'+i+';Path=/;Max-Age=3600'),context());globalThis.io={readwrite:0,readonly:0,puts:0,controlOpen:0};const tx=IDBDatabase.prototype.transaction,put=IDBObjectStore.prototype.put,open=IDBFactory.prototype.open;IDBFactory.prototype.open=function(...a){if(a[0]==='atlas.profile.control.v1')io.controlOpen++;return Reflect.apply(open,this,a)};IDBDatabase.prototype.transaction=function(...a){const value=Reflect.apply(tx,this,a);if(this.name.startsWith('atlas.browsing.cookies.v2'))io[value.mode]++;return value};IDBObjectStore.prototype.put=function(...a){if(this.name==='cookies')io.puts++;return Reflect.apply(put,this,a)}});
 const results=await page.evaluate(async()=>{const start=performance.now();for(let i=0;i<200;i++){cookieClock+=5;const value=i%2?await doc.view():await jar.getRequestHeader(context());if(!value.includes('cookie99=SYNTHETIC_99'))throw Error('Read lost the latest cookie')}const measured={milliseconds:performance.now()-start,io:{...io}};await doc.set('fresh=immediate;Path=/;Max-Age=3600');if(!(await doc.view()).includes('fresh=immediate')||!(await jar.getRequestHeader(context())).includes('fresh=immediate'))throw Error('Cookie visibility was delayed');await doc.set('short=expires;Path=/;Max-Age=1');cookieClock+=1001;if((await doc.view()).includes('short=expires'))throw Error('Expired cookie remained visible');const before=io.readwrite;cookieClock+=15000;await doc.view();const boundaryReadwrites=io.readwrite-before;await jar.close();return{...measured,boundaryReadwrites,immediateAuthCookie:true,immediateExpiry:true}});
 const expected=process.env.ATLAS_COOKIE_EXPECT||'baseline';assert.equal(results.io.readwrite,expected==='modified'?1:200);assert.equal(results.io.puts,expected==='modified'?100:20000);if(expected==='modified'){assert.equal(results.io.readonly,199);assert.equal(results.io.controlOpen,1)}assert.equal(results.boundaryReadwrites,1);
 const report={result:'PASS',variant:expected,CPUThrottle:6,reads:200,cookies:100,...results};mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();await app.close()}
