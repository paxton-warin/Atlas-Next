/** Actual opaque document + native trusted IDB, finite Cache API comparison. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { transpileModule, ScriptTarget, ModuleKind } from "typescript";
const app = Fastify({ logger: false });
const evidence =
  process.env.ATLAS_CACHE_EVIDENCE || "evidence/logical-cache-storage-20261016";
app.get("/runtime/:name", async (q, r) => {
  if (
    ![
      "sandbox-cache-protocol",
      "sandbox-caches",
      "opaque-caches",
      "opaque-runtime-adapter",
      "resource-response-budget",
    ].includes(q.params.name.replace(/\.js$/, ""))
  )
    return r.code(404).send();
  const source = await fs.readFile(
    "runtime/" + q.params.name.replace(/\.js$/, ".ts"),
    "utf8",
  );
  return r
    .header("Access-Control-Allow-Origin", "*")
    .type("application/javascript")
    .send(
      transpileModule(source, {
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module: ModuleKind.ESNext,
        },
      }).outputText.replaceAll('.ts"', '.js"'),
    );
});
app.get("/network/:id", (q, r) =>
  r
    .header("Access-Control-Allow-Origin", "*")
    .header("x-cache-readable", "yes")
    .header("Access-Control-Expose-Headers", "x-cache-readable")
    .code(q.params.id === "bad" ? 500 : 200)
    .type("text/plain")
    .send("network-" + q.params.id),
);
app.get("/", (_q, r) =>
  r.type("text/html")
    .send(`<!doctype html><title>Trusted Cache owner</title><script type="module">
import {bindSandboxCaches} from '/runtime/sandbox-caches.js';
window.cacheBindings=[];
window.openCacheFixture=async function(id,website='https://website.test/path/page',maxBytes){
 const frame=document.createElement('iframe');frame.id=id;frame.sandbox='allow-scripts';frame.src='/child';document.body.append(frame);
 await new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
 const pair=new MessageChannel(), owner=bindSandboxCaches({port:pair.port1,documentId:id,website,frontendOrigin:location.origin,factory:indexedDB,maxBytes});
 cacheBindings.push(owner);frame.contentWindow.postMessage({id,website,frontend:location.origin},'*',[pair.port2]);return id;
};window.rawCacheOwnerProof=async function(){
 const pair=new MessageChannel(),owner=bindSandboxCaches({port:pair.port1,documentId:'raw-owner',website:'https://raw-cache.test/',frontendOrigin:location.origin,factory:indexedDB}),replies=[];pair.port2.onmessage=e=>replies.push(e.data);pair.port2.start();
 const send=(sequence,op,extra={})=>pair.port2.postMessage({protocol:'atlas-cache-v1',documentId:'raw-owner',type:'request',sequence,op,...extra});
 pair.port2.postMessage({protocol:'wrong',documentId:'raw-owner',type:'request',sequence:1,op:'open',name:'wrong'});
 pair.port2.postMessage({protocol:'atlas-cache-v1',documentId:'other-doc',type:'request',sequence:1,op:'open',name:'wrong'});
 await new Promise(r=>setTimeout(r,20));const ignored=replies.length===0;
 const roundtrip=(sequence,op,extra)=>new Promise(resolve=>{const handler=e=>{if(e.data.sequence===sequence){pair.port2.removeEventListener('message',handler);resolve(e.data);}};pair.port2.addEventListener('message',handler);send(sequence,op,extra);});
 const one=await roundtrip(1,'open',{name:'repeat'});let stable=true;
 for(let sequence=2;sequence<=160;sequence++){const m=await roundtrip(sequence,'open',{name:'repeat'});stable&&=m.ok&&m.value===one.value;}
 const forged=await roundtrip(161,'match',{cacheId:one.value+100,request:{url:'https://raw-cache.test/x',method:'GET',headers:[],mode:'cors',credentials:'same-origin',redirect:'follow',referrer:'about:client',referrerPolicy:'',integrity:''},query:{ignoreSearch:false,ignoreMethod:false,ignoreVary:false}});
 owner.dispose();pair.port2.close();return [ignored,stable,forged.error];
};window.ownerReady=true;
</script>`),
);
app.get("/child", (_q, r) =>
  r
    .header(
      "Content-Security-Policy",
      `sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline' http://127.0.0.1:*;connect-src http://127.0.0.1:*;base-uri 'none';form-action 'none'`,
    )
    .type("text/html")
    .send(`<!doctype html><title>Opaque Cache client</title><script type="module">
import {createOpaqueCaches,captureOpaqueCacheNatives} from '/runtime/opaque-caches.js';
import {createOpaqueNetworkClient} from '/runtime/opaque-runtime-adapter.js';
const natives=captureOpaqueCacheNatives(globalThis), nativeFetch=fetch.bind(globalThis);
let baseline;try{await caches.open('native-opaque-denied');baseline='unexpected-native-success';}catch(e){baseline=e.name;}
addEventListener('message',async function init(event){
 if(!event.ports[0])return;removeEventListener('message',init);
 const {id,website,frontend}=event.data;window.nativeOpaqueBaseline=baseline;
 const networkPair=new MessageChannel();
 networkPair.port1.addEventListener('message',async e=>{const m=e.data;if(m.type!=='fetch')return;let value;
  if(new URL(m.request.url).pathname==='/network/opaque')value={url:'',status:0,statusText:'',headers:[],body:new ArrayBuffer(0),type:'opaque'};
  else{const url=new URL(m.request.url),res=await nativeFetch(frontend+url.pathname+url.search,{mode:'cors'});value={url:url.href,status:res.status,statusText:res.statusText,headers:[...res.headers],body:await res.arrayBuffer(),type:res.type,redirected:res.redirected};}
  networkPair.port1.postMessage({protocol:'atlas-network-v2',documentId:id,sequence:m.sequence,type:'response',response:value});
 });networkPair.port1.start();
 const network=createOpaqueNetworkClient({port:networkPair.port2,documentId:id,documentURL:website,natives});
 const client=createOpaqueCaches({port:event.ports[0],documentId:id,documentURL:website,natives,
 describeResponse:network.describeCacheResponse,rememberResponse:network.rememberCacheResponse,fetch:network.fetch});
 window.fetch=network.fetch;
 client.install(globalThis);window.cacheClient=client;window.cacheReady=true;
});
</script>`),
);
let browser;
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => window.ownerReady);
  async function child(id, website, maxBytes) {
    await page.evaluate(
      ([id, website, maxBytes]) => openCacheFixture(id, website, maxBytes),
      [id, website, maxBytes],
    );
    const frame = page
      .frames()
      .find(
        (x) =>
          x.parentFrame() && x.url().endsWith("/child") && !x._cacheAssigned,
      );
    frame._cacheAssigned = true;
    await frame.waitForFunction(() => window.cacheReady);
    return frame;
  }
  let frame = await child("doc-main");
  if (process.env.ATLAS_CACHE_BASELINE === "1") {
    const baseline = await frame.evaluate(() => nativeOpaqueBaseline);
    console.log(
      JSON.stringify({
        result: "native_opaque_cache_baseline",
        error: baseline,
        expected: "working logical cache owner required",
      }),
    );
    process.exitCode = 1;
    throw new Error("BASELINE_NATIVE_CACHE_SECURITY_ERROR");
  }
  const result = await frame.evaluate(async () => {
    const records = [],
      logical = "https://website.test",
      record = (name, actual, expected) =>
        records.push({
          name,
          actual,
          expected,
          pass: JSON.stringify(actual) === JSON.stringify(expected),
        }),
      failure = async (fn) => {
        try {
          await fn();
          return "none";
        } catch (e) {
          return e.name;
        }
      },
      sync = (fn) => {
        try {
          fn();
          return "none";
        } catch (e) {
          return e.name;
        }
      };
    record("opaque-native-baseline", nativeOpaqueBaseline, "SecurityError");
    const a = await caches.open("a"),
      a2 = await caches.open("a"),
      b = await caches.open("b");
    record(
      "cache-object-brand",
      [
        Object.prototype.toString.call(a),
        Object.prototype.toString.call(caches),
      ],
      ["[object Cache]", "[object CacheStorage]"],
    );
    record(
      "constructor-brands",
      [sync(() => new Cache()), sync(() => new CacheStorage())],
      ["TypeError", "TypeError"],
    );
    record(
      "method-brands",
      [
        await failure(() => Cache.prototype.match.call({}, "/x")),
        await failure(() => CacheStorage.prototype.open.call({}, "x")),
        await failure(() =>
          Cache.prototype.add.call({ addAll: () => Promise.resolve() }, "/x"),
        ),
      ],
      ["TypeError", "TypeError", "TypeError"],
    );
    record("open-distinct-wrapper-same-store", a !== a2, true);
    record("cache-insertion-order", await caches.keys(), ["a", "b"]);
    record(
      "storage-has",
      [await caches.has("a"), await caches.has("missing")],
      [true, false],
    );
    record(
      "missing-match",
      [
        (await a.match("/missing")) === undefined,
        (await caches.match("/missing")) === undefined,
      ],
      [true, true],
    );
    const input = new Response("durable-value", {
        headers: { "x-test": "visible" },
      }),
      clone = input.clone(),
      put = a.put("/entry?q=one#fragment", input),
      consumed = input.bodyUsed;
    await put;
    record(
      "put-consumes-response-not-clone",
      [consumed, input.bodyUsed, clone.bodyUsed, await clone.text()],
      [true, true, false, "durable-value"],
    );
    const matched = await a2.match("/entry?q=one#different");
    record(
      "key-fragment-ignored",
      [matched.status, await matched.text(), matched.headers.get("x-test")],
      [200, "durable-value", "visible"],
    );
    record(
      "match-clone-not-disturbed",
      await (await a.match("/entry?q=one")).text(),
      "durable-value",
    );
    record(
      "query-options",
      [
        (await a.match("/entry?q=two")) === undefined,
        await (await a.match("/entry?q=two", { ignoreSearch: true })).text(),
      ],
      [true, "durable-value"],
    );
    record(
      "method-options",
      [
        (await a.match(
          new Request(logical + "/entry?q=one", { method: "POST", body: "x" }),
        )) === undefined,
        await (
          await a.match(
            new Request(logical + "/entry?q=one", {
              method: "POST",
              body: "x",
            }),
            { ignoreMethod: true },
          )
        ).text(),
      ],
      [true, "durable-value"],
    );
    await a.put(
      new Request(logical + "/vary", { headers: { "accept-language": "en" } }),
      new Response("English", { headers: { vary: "accept-language" } }),
    );
    record(
      "vary-match",
      [
        await (
          await a.match(
            new Request(logical + "/vary", {
              headers: { "accept-language": "en" },
            }),
          )
        ).text(),
        (await a.match(
          new Request(logical + "/vary", {
            headers: { "accept-language": "fr" },
          }),
        )) === undefined,
        await (
          await a.match(
            new Request(logical + "/vary", {
              headers: { "accept-language": "fr" },
            }),
            { ignoreVary: true },
          )
        ).text(),
      ],
      ["English", true, "English"],
    );
    record(
      "put-validation",
      [
        await failure(() =>
          a.put(
            new Request(logical + "/post", { method: "POST", body: "x" }),
            new Response("bad"),
          ),
        ),
        await failure(() =>
          a.put("/partial", new Response("partial", { status: 206 })),
        ),
        await failure(() =>
          a.put("/star", new Response("star", { headers: { vary: "*" } })),
        ),
        await failure(() => a.put("data:text/plain,no", new Response("no"))),
      ],
      ["TypeError", "TypeError", "TypeError", "TypeError"],
    );
    const used = new Response("used");
    await used.text();
    record(
      "used-body-rejected",
      await failure(() => a.put("/used", used)),
      "TypeError",
    );
    const locked = new Response("locked"),
      reader = locked.body.getReader();
    record(
      "locked-body-rejected",
      await failure(() => a.put("/locked", locked)),
      "TypeError",
    );
    reader.releaseLock();
    await a.put("/replace", new Response("first"));
    await a.put("/last", new Response("last"));
    await a.put("/replace", new Response("updated"));
    const requests = await a.keys();
    record(
      "replacement-order",
      requests.slice(-2).map((x) => new URL(x.url).pathname),
      ["/last", "/replace"],
    );
    record(
      "keys-return-request",
      [
        requests.every((x) => x instanceof Request),
        requests.every((x) => x.method === "GET"),
      ],
      [true, true],
    );
    record("matchAll", (await a.matchAll()).length, requests.length);
    await b.put("/entry?q=one", new Response("from-b"));
    record(
      "storage-match-order-and-name",
      [
        await (await caches.match("/entry?q=one")).text(),
        await (await caches.match("/entry?q=one", { cacheName: "b" })).text(),
      ],
      ["durable-value", "from-b"],
    );
    await a.add("/network/one");
    const network = await a.match("/network/one");
    record(
      "real-CORS-readable-add",
      [
        network.type,
        network.url,
        network.headers.get("x-cache-readable"),
        await network.text(),
      ],
      ["cors", logical + "/network/one", "yes", "network-one"],
    );
    record(
      "addAll-failure-atomic",
      [
        await failure(() => a.addAll(["/network/two", "/network/bad"])),
        (await a.match("/network/two")) === undefined,
      ],
      ["TypeError", true],
    );
    record(
      "addAll-duplicate-atomic",
      [
        await failure(() => a.addAll(["/network/three", "/network/three"])),
        (await a.match("/network/three")) === undefined,
      ],
      ["InvalidStateError", true],
    );
    record(
      "delete-result",
      [await a.delete("/network/one"), await a.delete("/network/one")],
      [true, false],
    );
    record(
      "delete-cache-does-not-invalidate-handle",
      [
        await caches.delete("b"),
        await (await b.match("/entry?q=one")).text(),
        await caches.has("b"),
      ],
      [true, "from-b", false],
    );
    await a.put(
      "/persist",
      new Response(new Uint8Array([17, 23, 31]), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const forged = new Response("honest");
    Object.defineProperties(forged, {
      type: { value: "opaque" },
      status: { value: 206 },
      headers: { value: new Headers({ vary: "*" }) },
    });
    await a.put("/forged", forged);
    record(
      "public-response-properties-not-authority",
      await (await a.match("/forged")).text(),
      "honest",
    );
    const opaque = await fetch(logical + "/network/opaque");
    record(
      "opaque-put-explicitly-unsupported",
      [
        await failure(() => a.put("/opaque", opaque)),
        await failure(() =>
          a.put("/opaque-clone", Response.prototype.clone.call(opaque)),
        ),
      ],
      ["NotSupportedError", "NotSupportedError"],
    );
    const fromNetwork = await fetch(logical + "/network/clone");
    await a.put("/native-clone", Response.prototype.clone.call(fromNetwork));
    const clonedCache = Response.prototype.clone.call(
      await a.match("/native-clone"),
    );
    await a.put("/cache-native-clone", clonedCache);
    const cloneMatch = await a.match("/cache-native-clone");
    record(
      "shared-authority-native-clone-roundtrip",
      [cloneMatch.type, cloneMatch.url, await cloneMatch.text()],
      ["cors", logical + "/network/clone", "network-clone"],
    );
    const err = Response.error();
    await a.put("/error", err);
    const er = await a.match("/error");
    record(
      "error-response-native-parity",
      [er.type, er.status, er.body === null],
      ["error", 0, true],
    );
    await a.put(
      "/blob",
      new Response(
        new Blob([new Uint8Array([3, 5, 7])], {
          type: "application/octet-stream",
        }),
      ),
    );
    record(
      "blob-byte-preservation",
      [...new Uint8Array(await (await a.match("/blob")).arrayBuffer())],
      [3, 5, 7],
    );
    const nativeDesc = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "status",
    );
    Object.defineProperty(Response.prototype, "status", {
      get() {
        return 206;
      },
      configurable: true,
    });
    try {
      await a.put("/poison", new Response("native-getter"));
      record(
        "captured-native-status-getter",
        await (await a.match("/poison")).text(),
        "native-getter",
      );
    } finally {
      Object.defineProperty(Response.prototype, "status", nativeDesc);
    }
    const messageData = Object.getOwnPropertyDescriptor(
        MessageEvent.prototype,
        "data",
      ),
      portPost = MessagePort.prototype.postMessage,
      portListen = MessagePort.prototype.addEventListener,
      portUnlisten = MessagePort.prototype.removeEventListener;
    let poisoned = 0;
    Object.defineProperty(MessageEvent.prototype, "data", {
      get() {
        poisoned++;
        throw Error("poisoned");
      },
      configurable: true,
    });
    MessagePort.prototype.postMessage =
      MessagePort.prototype.addEventListener =
      MessagePort.prototype.removeEventListener =
        function () {
          poisoned++;
          throw Error("poisoned");
        };
    try {
      await a.put("/private-captured", new Response("captured"));
      const value = await (await a.match("/private-captured")).text();
      record(
        "captured-private-port-primordials",
        [value, poisoned],
        ["captured", 0],
      );
    } finally {
      Object.defineProperty(MessageEvent.prototype, "data", messageData);
      MessagePort.prototype.postMessage = portPost;
      MessagePort.prototype.addEventListener = portListen;
      MessagePort.prototype.removeEventListener = portUnlisten;
    }
    const before = (await a.keys()).length;
    record(
      "bounded-stream-atomic",
      [
        await failure(() =>
          a.put("/oversize", new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
        ),
        (await a.keys()).length === before,
      ],
      ["QuotaExceededError", true],
    );
    return { records };
  });
  // A second document/port and page reload change no storage namespace. Native
  // IDB transaction commits, not an asynchronous unload mirror, provide saving.
  const raw = await page.evaluate(() => rawCacheOwnerProof());
  result.records.push({
    name: "raw-binding-and-repeat-open-bound",
    actual: raw,
    expected: [true, true, "InvalidStateError"],
    pass: JSON.stringify(raw) === '[true,true,"InvalidStateError"]',
  });
  const concurrent = await child("doc-concurrent");
  const concurrentResult = await Promise.all([
    frame.evaluate(async () => {
      await (await caches.open("a")).put("/parallel-one", new Response("one"));
      return true;
    }),
    concurrent.evaluate(async () => {
      await (await caches.open("a")).put("/parallel-two", new Response("two"));
      return true;
    }),
  ]);
  const both = await frame.evaluate(async () => {
    const c = await caches.open("a");
    return [
      await (await c.match("/parallel-one")).text(),
      await (await c.match("/parallel-two")).text(),
    ];
  });
  result.records.push({
    name: "concurrent-tabs-no-lost-update",
    actual: both,
    expected: ["one", "two"],
    pass: JSON.stringify(both) === '["one","two"]',
  });
  const peer = await child("doc-peer", "https://peer.test/");
  const isolated = await peer.evaluate(async () => [
    await caches.keys(),
    (await caches.match("https://website.test/persist")) === undefined,
  ]);
  result.records.push({
    name: "fixed-logical-origin-isolation",
    actual: isolated,
    expected: [[], true],
    pass: JSON.stringify(isolated) === "[[],true]",
  });
  const quota = await child("doc-quota", "https://quota.test/", 4096);
  const failed = await quota.evaluate(async () => {
    const c = await caches.open("q");
    await c.put("/good", new Response("retained"));
    let failure;
    try {
      await c.put("/large", new Response(new Uint8Array(4096)));
    } catch (e) {
      failure = e.name;
    }
    return [
      failure,
      await (await c.match("/good")).text(),
      (await c.match("/large")) === undefined,
    ];
  });
  result.records.push({
    name: "quota-write-failure-is-atomic",
    actual: failed,
    expected: ["QuotaExceededError", "retained", true],
    pass: JSON.stringify(failed) === '["QuotaExceededError","retained",true]',
  });
  await page.reload();
  await page.waitForFunction(() => window.ownerReady);
  frame = await child("doc-after-reload");
  const persisted = await frame.evaluate(async () => [
    ...new Uint8Array(
      await (await (await caches.open("a")).match("/persist")).arrayBuffer(),
    ),
  ]);
  result.records.push({
    name: "commit-ack-immediate-reload-new-document",
    actual: persisted,
    expected: [17, 23, 31],
    pass: JSON.stringify(persisted) === "[17,23,31]",
  });
  const disposed = await frame.evaluate(async () => {
    cacheClient.dispose();
    try {
      await caches.open("after-dispose");
      return "none";
    } catch (e) {
      return e.name;
    }
  });
  result.records.push({
    name: "disposed-port-fails-closed",
    actual: disposed,
    expected: "AbortError",
    pass: disposed === "AbortError",
  });
  result.cases = result.records.length;
  result.passed = result.records.filter((r) => r.pass).length;
  result.scope =
    "Finite opaque-document facade + real trusted frontend native IndexedDB, local deterministic CORS; not public Discord or fleet qualification. Opaque Cache.put explicitly unsupported, not native-equivalent.";
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(
    evidence + "/BROWSER.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failed: result.records.filter((r) => !r.pass),
      scope: result.scope,
    }),
  );
  assert.equal(result.passed, result.cases);
} finally {
  await browser?.close();
  await app.close();
}
