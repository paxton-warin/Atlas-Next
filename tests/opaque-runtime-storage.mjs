/** Joint component proof: actual copied RuntimeKit + real durable synchronous
 * storage worker/rendezvous + real native-backed IDB facade. This uses an
 * explicitly in-memory network transport fixture, not a deployed relay/node.
 * Run: node tests/opaque-runtime-storage.mjs
 */
import Fastify from "fastify";
import fs from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { adaptPinnedRuntimeBundle } from "./opaque-runtime-fork.mjs";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
import { installSandboxStorageRendezvous } from "../server/sandbox-storage-rendezvous.mjs";

const app = Fastify({ logger: false });
const websiteOrigin = "https://orteil.dashnet.org";
const website = websiteOrigin + "/cookieclicker/";
const sessionId = "actual_runtime_storage_tab_0123456";
const save = "actual RuntimeKit CookieClicker manual save committed";
const blobText = "actual RuntimeKit IDB Blob bytes";
const markerWire = [],
  requests = [];
let frontend;
const compiled = new Map();
for (const name of [
  "sandbox-controller",
  "sandbox-storage-owner",
  "sandbox-storage-worker",
  "sandbox-local-storage",
  "sandbox-vault",
  "sandbox-broker",
  "sandbox-network",
  "sandbox-idb",
  "opaque-runtime-adapter",
]) {
  const source = fs.readFileSync(
    new URL(`../runtime/${name}.ts`, import.meta.url),
    "utf8",
  );
  const text = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replaceAll(/(from\s+["'])\.\/([^"']+)\.ts/g, "$1./$2.js");
  compiled.set(name, text);
  app.get(`/${name}.js`, (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .type("application/javascript")
      .send(text),
  );
}
const exportsFor = (name, names) =>
  `(()=>{${compiled.get(name).replaceAll(/^export /gm, "")}\nreturn {${names.join(",")}};})()`;
const core = adaptPinnedRuntimeBundle(
  fs.readFileSync(
    new URL("../runtime/public/runtime/runtimekit.js", import.meta.url),
    "utf8",
  ),
);
const wasm = fs
  .readFileSync(
    new URL("../runtime/public/runtime/runtimekit.wasm", import.meta.url),
  )
  .toString("base64");
const bootstrap = `
${core}
const storageAPI=${exportsFor("sandbox-local-storage", ["createSandboxStorageFacades"])};
const idbAPI=${exportsFor("sandbox-idb", ["createSandboxIndexedDB", "installSandboxIndexedDB"])};
const runtimeAPI=${exportsFor("opaque-runtime-adapter", ["bootOpaqueRuntimeClient", "createOpaqueNetworkClient"])};
const wasm=Uint8Array.from(atob(${JSON.stringify(wasm)}),value=>value.charCodeAt(0));
const nativeEval=window.eval,notify=parent.postMessage.bind(parent);
addEventListener('atlas:document-capabilities',event=>{
  const grant=event.detail;
  grant.control.onmessage=async event=>{
    if(event.data.type!=='initialize')return;
    try {
      const data=event.data;
      const storage=await storageAPI.createSandboxStorageFacades({documentId:grant.documentId,endpoint:data.storageEndpoint,port:grant.storage});
      const idb=idbAPI.createSandboxIndexedDB(grant.indexedDB,grant.documentId);
      const network=runtimeAPI.createOpaqueNetworkClient({port:grant.network,documentId:grant.documentId,documentURL:data.website});
      const boot=runtimeAPI.bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL:data.website,prefix:location.origin+'/~/app/joint/',network,
        localStorage:storage.localStorage,sessionStorage:storage.sessionStorage,
        installIndexedDB:(_client,win)=>idbAPI.installSandboxIndexedDB(win,idb),
        onNavigate:()=>{throw Error('navigation is not qualified')},sendSetCookie:async()=>{throw Error('cookie mutation is not qualified')}
      });
      // These are exactly the four trusted, already-bound capability ports.
      // RuntimeKit must not wrap storage/IDB protocol messages as website data.
      for(const port of [grant.control,grant.storage,grant.indexedDB,grant.network])boot.client.nativeMessagePorts.add(port);
      const writing=new URL(data.website).hash==='#write';
      const source=writing ? ${JSON.stringify(`(async()=>{
        const events=[];
        const previous=localStorage.getItem('CookieClickerGame');
        const returned=localStorage.setItem('CookieClickerGame',${JSON.stringify(save)});
        sessionStorage.setItem('joint-session','same-browser-tab');
        const db=await new Promise((resolve,reject)=>{
          const open=indexedDB.open('actual-runtime-save',1);
          open.onupgradeneeded=()=>{const store=open.result.createObjectStore('records',{keyPath:'id'});store.put({id:1,blob:new Blob([${JSON.stringify(blobText)}],{type:'text/plain'})});};
          open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);
        });
        const tx=db.transaction('records','readwrite'),store=tx.objectStore('records');
        const first=store.get(1);let record;
        first.onsuccess=()=>{events.push('get');store.put({id:2,name:'second',blob:first.result.blob}).onsuccess=()=>{events.push('put');store.get(2).onsuccess=event=>{events.push('read-after-put');record=event.target.result;};};};
        tx.oncomplete=()=>events.push('complete');
        await tx.done;
        const bytes=await record.blob.text();db.close();
        const transport=await(await fetch('/transport-label')).text();
        return{phase:'write',previous,returnedUndefined:returned===undefined,save:localStorage.getItem('CookieClickerGame'),borrowed:Storage.prototype.getItem.call(localStorage,'CookieClickerGame'),session:sessionStorage.getItem('joint-session'),events,blob:bytes,transport,origin:location.origin};
      })()`)} : ${JSON.stringify(`(async()=>{
        const saved=localStorage.getItem('CookieClickerGame'),session=sessionStorage.getItem('joint-session');
        const db=await new Promise((resolve,reject)=>{const open=indexedDB.open('actual-runtime-save');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
        const tx=db.transaction('records'),get=tx.objectStore('records').get(2);
        const record=await new Promise((resolve,reject)=>{get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);});
        await tx.done;const bytes=await record.blob.text();db.close();
        const transport=await(await fetch('/transport-label')).text();
        return{phase:'read',save:saved,session,blob:bytes,name:record.name,transport,origin:location.origin};
      })()`)};
      const rewritten=boot.rewriter.javascript(source);
      const result=await nativeEval.call(window,rewritten);
      let parentDenied=false;try{void parent.document.body}catch{parentDenied=true}
      notify({type:'joint-storage-result',documentId:grant.documentId,result,parentDenied},location.origin);
    } catch(error) {
      notify({type:'joint-storage-result',documentId:grant.documentId,error:{name:error.name,message:error.message,stack:error.stack?.split('\\n').slice(0,5)}},location.origin);
    }
  };grant.control.start();
});
`;
app.get("/", (_request, reply) =>
  reply
    .header("Cache-Control", "no-store")
    .type("text/html")
    .send(
      "<!doctype html><title>Joint actual runtime storage controller</title><main></main>",
    ),
);
app.get("/favicon.ico", (_request, reply) => reply.code(204).send());
app.addHook("onRequest", (request, _reply, done) => {
  requests.push(request.url.split("#")[0]);
  done();
});
app.addHook("preHandler", async (request) => {
  if (request.url.startsWith("/browse/storage/commit/")) {
    markerWire.push({
      body:
        typeof request.body === "string"
          ? JSON.parse(request.body)
          : request.body,
      origin: request.headers.origin,
      cookie: !!request.headers.cookie,
      authorization: !!request.headers.authorization,
    });
  }
});
installSandboxStorageRendezvous(app, {
  originFor: () => frontend,
  authorizeOwner: (request) =>
    request.headers["x-joint-fixture-owner"] === "valid"
      ? { session: "joint-component-fixture" }
      : null,
  validateOwner: () => true,
  timeoutMs: 2000,
});
installSandboxFramePrototype(app, {
  capabilities: true,
  trustedBootstrap: bootstrap,
  storageEndpointOrigin: () => frontend,
});
// Component-only CSP extension needed by the EXISTING real RuntimeKit JS/WASM
// rewriter/eval machinery. Still native opaque; no website network fallback.
app.addHook("onSend", async (request, reply, payload) => {
  if (request.url.startsWith("/browse/frame/")) {
    const csp = String(reply.getHeader("Content-Security-Policy"));
    reply.header(
      "Content-Security-Policy",
      csp.replace(
        "script-src 'unsafe-inline'",
        "script-src 'unsafe-inline' 'unsafe-eval'",
      ),
    );
  }
  return payload;
});
await app.listen({ host: "127.0.0.1", port: 0 });
frontend = "http://127.0.0.1:" + app.server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(frontend);
  async function initialize(phase, label) {
    return await page.evaluate(
      async ({ website, sessionId, phase, label }) => {
        const { createSandboxStorageOwner } = await import(
          "/sandbox-storage-owner.js"
        );
        const { createSandboxDocument } = await import(
          "/sandbox-controller.js"
        );
        const owner = await createSandboxStorageOwner({
          workerURL: "/sandbox-storage-worker.js",
          registrationHeaders: () => ({ "x-joint-fixture-owner": "valid" }),
        });
        let binding;
        const result = new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error("joint actual runtime storage timeout")),
            20000,
          );
          addEventListener("message", function receive(event) {
            if (
              event.source !== binding?.frame.contentWindow ||
              event.origin !== "null" ||
              event.data?.type !== "joint-storage-result" ||
              event.data.documentId !== binding.documentId
            )
              return;
            clearTimeout(timeout);
            removeEventListener("message", receive);
            resolve({
              ...event.data,
              parentCannotRead: binding.frame.contentDocument === null,
              documentURL:
                new URL(binding.frame.src).origin +
                new URL(binding.frame.src).pathname,
              controllerOrigin: location.origin,
            });
          });
        });
        binding = createSandboxDocument({
          website: website + "#" + phase,
          container: document.querySelector("main"),
          storageProvider: owner,
          sessionId,
          factory: indexedDB,
          fetch: async (request, context) => {
            if (new URL(request.url).pathname !== "/transport-label")
              throw Error("unregistered fixture transport request");
            (window.fixtureTraffic || (window.fixtureTraffic = [])).push({
              label,
              origin: context.origin,
              mode: request.mode,
            });
            return {
              url: request.url,
              status: 200,
              statusText: "OK",
              headers: [["content-type", "text/plain"]],
              body: new TextEncoder().encode(label).buffer,
            };
          },
        });
        window.fixtureOwner = owner;
        window.fixtureBinding = binding;
        await binding.ready;
        return await result;
      },
      { website, sessionId, phase, label },
    );
  }
  const written = await initialize("write", "fixture-node-a");
  // The sole next browser action is FULL trusted controller reload. No flush,
  // sleep, native DB read or extra child/owner task occurs after script ack.
  await page.reload();
  const restored = await initialize("read", "fixture-node-b");
  assert.equal(written.error, undefined);
  assert.equal(restored.error, undefined);
  assert.notEqual(written.documentId, restored.documentId);
  assert.equal(written.result.previous, null);
  assert.equal(written.result.returnedUndefined, true);
  assert.equal(written.result.save, save);
  assert.equal(written.result.borrowed, save);
  assert.deepEqual(written.result.events, [
    "get",
    "put",
    "read-after-put",
    "complete",
  ]);
  assert.equal(written.result.blob, blobText);
  assert.equal(restored.result.blob, blobText);
  assert.equal(restored.result.save, save);
  assert.equal(restored.result.session, "same-browser-tab");
  assert.equal(restored.result.name, "second");
  assert.equal(written.result.transport, "fixture-node-a");
  assert.equal(restored.result.transport, "fixture-node-b");
  assert.equal(written.parentDenied, true);
  assert.equal(restored.parentDenied, true);
  assert.equal(written.parentCannotRead, true);
  assert.equal(restored.parentCannotRead, true);
  assert.equal(written.controllerOrigin, restored.controllerOrigin);
  const native = await page.evaluate(
    async ({ origin, sessionId }) => {
      const open = (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const db = await open("atlas.browsing.v2");
      const read = (key) =>
        new Promise((resolve, reject) => {
          const request = db
            .transaction("origins")
            .objectStore("origins")
            .get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const local = await read(origin),
        session = await read(["session", sessionId, origin]);
      db.close();
      const name =
        "atlas.browsing.idb.v2:" +
        encodeURIComponent(origin) +
        ":actual-runtime-save";
      const native = await open(name);
      const record = await new Promise((resolve, reject) => {
        const request = native
          .transaction("records")
          .objectStore("records")
          .get(2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      native.close();
      return {
        local,
        session,
        idbName: name,
        blob: await record.blob.text(),
        name: record.name,
        names: (await indexedDB.databases()).map((value) => value.name),
      };
    },
    { origin: websiteOrigin, sessionId },
  );
  assert.equal(new Map(native.local.entries).get("CookieClickerGame"), save);
  assert.equal(
    new Map(native.session.entries).get("joint-session"),
    "same-browser-tab",
  );
  assert.equal(native.blob, blobText);
  assert.equal(native.name, "second");
  assert.equal(
    native.names.filter((name) => name.startsWith("atlas.browsing.idb.v2:") && !name.endsWith(":#quota"))
      .length,
    1,
  );
  assert.ok(
    markerWire.length === 2 &&
      markerWire.every(
        (value) =>
          Object.keys(value.body).join(",") === "sequence" &&
          !value.cookie &&
          !value.authorization &&
          value.origin === "null",
      ),
  );
  assert.ok(
    !JSON.stringify(markerWire).includes(save) &&
      !JSON.stringify(markerWire).includes("CookieClickerGame"),
  );
  assert.ok(!requests.some((path) => path.startsWith("/~/")));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        localOnly: true,
        productionChanged: false,
        transport: "in-memory fixture labels; NOT real nodes",
        sameHostOpaque: true,
        actualPinnedRuntime: true,
        volatileStorage: false,
        fullControllerReload: true,
        written,
        restored,
        nativeBackend: native,
        markerWire,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "JOINT_STORAGE_RESULT: actual RuntimeKit + real synchronous worker/rendezvous + native-backed IDB callback Blob commit survives immediate full controller reload PASS",
  );
} finally {
  await browser.close();
  await app.close();
}
