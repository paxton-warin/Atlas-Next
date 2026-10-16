/** Hostile public-prototype regression in a genuinely opaque Window. IDB uses
 * real trusted native IndexedDB; sync marker XHR is a local explicit ACK fixture.
 * Real storage/cookie worker proofs are run separately, not implied here. */
import Fastify from "fastify";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild"),
  app = Fastify({ logger: false }),
  baseline = process.env.ATLAS_PRIVATE_PORT_BASELINE === "1";
let browser;
const compile = async (contents, format = "esm", plugins = []) =>
  (
    await build({
      stdin: { contents, resolveDir: process.cwd() },
      bundle: true,
      write: false,
      format,
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      plugins,
    })
  ).outputFiles[0].text;
const overrides = baseline
  ? [
      {
        name: "preserved-client-baseline",
        setup(build) {
          build.onLoad(
            { filter: /sandbox-(?:local-storage|document-cookie|idb)\.ts$/ },
            (args) => ({
              contents: fs.readFileSync(
                (process.env.ATLAS_PRIVATE_PORT_BASELINE_DIR ||
                  "evidence/combined-update-20261015/private-port-clients/baseline") +
                  "/" +
                  args.path.split("/").at(-1),
                "utf8",
              ),
              loader: "ts",
            }),
          );
        },
      },
    ]
  : [];
const child = await compile(
    "import {createSandboxStorageFacades} from './runtime/sandbox-local-storage.ts';import{createSandboxDocumentCookie}from'./runtime/sandbox-document-cookie.ts';import{createSandboxIndexedDB}from'./runtime/sandbox-idb.ts';globalThis.fixture={createSandboxStorageFacades,createSandboxDocumentCookie,createSandboxIndexedDB};",
    "iife",
    overrides,
  ),
  parent = await compile(
    "export{bindSandboxIndexedDB}from'./runtime/sandbox-idb.ts';",
  );
const bootstrap = `${child}\n(()=>{const apply=Reflect.apply,define=Object.defineProperty,getOwn=Object.getOwnPropertyDescriptor,deleteProperty=Reflect.deleteProperty,notify=parent.postMessage.bind(parent),nativeAdd=EventTarget.prototype.addEventListener,nativeRemove=EventTarget.prototype.removeEventListener,nativeData=getOwn(MessageEvent.prototype,'data').get,NativeXHR=XMLHttpRequest;const grant=async event=>{const data=apply(nativeData,event,[]);if(data?.type!=='grant')return;apply(nativeRemove,window,['message',grant]);try{class ACKXHR{open(){}setRequestHeader(){}send(){}get responseText(){return JSON.stringify({ok:true,revision:1})}get status(){return 200}};window.XMLHttpRequest=ACKXHR;const storage=await fixture.createSandboxStorageFacades({port:event.ports[0],documentId:data.documentId,endpoint:location.origin+'/browse/storage/commit/'+ 'a'.repeat(43)}),cookies=await fixture.createSandboxDocumentCookie({port:event.ports[1],documentId:data.documentId,endpoint:location.origin+'/browse/cookies/result/'+ 'b'.repeat(43)}),idb=fixture.createSandboxIndexedDB(event.ports[2],data.documentId);window.XMLHttpRequest=NativeXHR;
const leaks=[],restores=[],Port=MessagePort,Channel=MessageChannel,nativeCall=Function.prototype.call,nativeApply=Function.prototype.apply;function record(label,receiver){if(receiver instanceof Port)leaks.push(label)}function replace(proto,name,value){const old=getOwn(proto,name);define(proto,name,{configurable:true,writable:true,...old,value});restores.push(()=>old?define(proto,name,old):deleteProperty(proto,name))}
for(const name of ['port1','port2']){const old=getOwn(Channel.prototype,name);define(Channel.prototype,name,{...old,get(){leaks.push('MessageChannel.'+name);return apply(old.get,this,[])}});restores.push(()=>define(Channel.prototype,name,old));}
const oldData=getOwn(MessageEvent.prototype,'data');define(MessageEvent.prototype,'data',{...oldData,get(){record('MessageEvent.data',this.currentTarget);return apply(nativeData,this,[])}});restores.push(()=>define(MessageEvent.prototype,'data',oldData));
for(const [proto,names]of [[MessagePort.prototype,['postMessage','start','close']],[EventTarget.prototype,['addEventListener','removeEventListener']]])for(const name of names){const original=proto[name];replace(proto,name,function(...args){record(name,this);return apply(original,this,args)})}
replace(Reflect,'apply',function(target,receiver,args){record('Reflect.apply',receiver);if(receiver instanceof MessageEvent)record('Reflect.apply event',receiver.currentTarget);return apply(target,receiver,args)});replace(Function.prototype,'call',function(receiver,...args){record('Function.call',receiver);return apply(this,receiver,args)});replace(Function.prototype,'apply',function(receiver,args){record('Function.apply',receiver);return apply(this,receiver,args)});replace(globalThis,'MessageChannel',class extends Channel{constructor(){super();leaks.push('MessageChannel constructor')}});const fill=Uint8Array.prototype.fill;replace(Uint8Array.prototype,'fill',function(...args){if(this.byteLength===32)leaks.push('private cookie key fill');return apply(fill,this,args)});
notify({type:'hostile-ready'},'*');storage.localStorage.setItem('save','committed-marker');const db=await new Promise((resolve,reject)=>{const r=idb.open('hostile-prototype-test',1);r.onupgradeneeded=()=>r.result.createObjectStore('s');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const tx=db.transaction('s','readwrite');tx.objectStore('s').put('durable-value','k');await tx.done;const reading=db.transaction('s'),request=reading.objectStore('s').get('k');const value=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});await reading.done;await new Promise(r=>setTimeout(r,30));const snapshot=storage.localStorage.getItem('mirror');db.close();storage.dispose();cookies.dispose();idb.dispose();for(const restore of restores.reverse())restore();notify({type:'result',result:{leaks,value,snapshot,origin:window.origin}},'*');}catch(error){window.XMLHttpRequest=NativeXHR;notify({type:'error',name:error.name,message:error.message,stack:error.stack?.split('\\n').slice(0,6)},'*')}};apply(nativeAdd,window,['message',grant]);notify({type:'ready'},'*')})();`;
app.get("/", (_r, p) =>
  p
    .type("text/html")
    .send("<!doctype html><title>Private port attack fixture</title>"),
);
app.get("/parent.js", (_r, p) => p.type("application/javascript").send(parent));
app.get("/favicon.ico", (_r, p) => p.code(204).send());
app.get("/child", (_r, p) =>
  p
    .header(
      "Content-Security-Policy",
      "sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline'",
    )
    .type("text/html")
    .send(
      "<!doctype html><script>" +
        bootstrap.replaceAll("</script", "<\\/script") +
        "</script>",
    ),
);
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://localhost:" + app.server.address().port;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const { bindSandboxIndexedDB } = await import("/parent.js"),
      doc = "private_ports_document_123456",
      s = new MessageChannel(),
      c = new MessageChannel(),
      d = new MessageChannel(),
      frame = document.createElement("iframe");
    const binding = bindSandboxIndexedDB({
      port: d.port1,
      documentId: doc,
      website: "https://website.test/",
      frontendOrigin: location.origin,
      factory: indexedDB,
    });
    const ready = {
      type: "ready",
      documentId: doc,
      snapshots: {
        local: { revision: 0, entries: [] },
        session: { revision: 0, entries: [] },
      },
    };
    s.port1.postMessage(ready);
    c.port1.postMessage({
      protocol: "atlas-cookie-result-v1",
      documentId: doc,
      type: "ready",
      documentURL: "https://website.test/path",
      key: new Uint8Array(32).fill(7),
    });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("hostile fixture deadline")),
        10000,
      );
      const listener = (e) => {
        if (e.source !== frame.contentWindow) return;
        if (e.data?.type === "ready")
          frame.contentWindow.postMessage(
            { type: "grant", documentId: doc },
            "*",
            [s.port2, c.port2, d.port2],
          );
        else if (e.data?.type === "hostile-ready") {
          s.port1.postMessage({
            type: "snapshot",
            documentId: doc,
            kind: "local",
            snapshot: {
              revision: 2,
              entries: [["mirror", "from-trusted-peer"]],
            },
          });
          c.port1.postMessage({
            protocol: "atlas-cookie-result-v1",
            documentId: doc,
            type: "revoked",
          });
        } else if (e.data?.type === "result" || e.data?.type === "error") {
          clearTimeout(timer);
          removeEventListener("message", listener);
          resolve(e.data);
        }
      };
      addEventListener("message", listener);
    });
    frame.src = "/child";
    document.body.append(frame);
    const result = await done;
    binding.dispose();
    s.port1.close();
    c.port1.close();
    frame.remove();
    return result;
  });
  const dir = "evidence/combined-update-20261015/private-port-clients";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    dir +
      "/" +
      (process.env.ATLAS_PRIVATE_PORT_RECEIPT ||
        (baseline ? "baseline-attack.json" : "modified-attack.json")),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ baseline, result }));
  assert.equal(result.type, "result", JSON.stringify(result));
  assert.equal(result.result.value, "durable-value");
  assert.equal(result.result.snapshot, "from-trusted-peer");
  assert.equal(result.result.origin, "null");
  if (baseline) assert.ok(result.result.leaks.length > 0);
  else assert.deepEqual(result.result.leaks, []);
} finally {
  await browser?.close();
  await app.close();
}
