/** Actual Chrome hostile prototype regression; component control ports only,
 * deterministic worker selfboot stub, not full runtime/website acceptance. */
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const bundle = await build({
  plugins:
    process.env.PORT_BASELINE === "1"
      ? [
          {
            name: "preserved-baseline",
            setup(build) {
              build.onLoad(
                { filter: /opaque-(?:workers|websocket)\.ts$/ },
                (args) => ({
                  contents: fs.readFileSync(
                    "evidence/private-port-hardening-20261016/BASELINE-" +
                      (args.path.endsWith("opaque-workers.ts")
                        ? "WORKERS"
                        : "WEBSOCKET") +
                      ".ts",
                    "utf8",
                  ),
                  loader: "ts",
                  resolveDir: resolve("runtime"),
                }),
              );
            },
          },
        ]
      : [],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "silent",
  stdin: {
    resolveDir: resolve("runtime"),
    contents: `export{createOpaqueWebSocket,bindOpaqueWebSockets}from'./opaque-websocket.ts';export{createOpaqueWorkerManager,workerBootstrap}from'./opaque-workers.ts';`,
  },
});
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Content-Type",
    req.url === "/api.js" ? "application/javascript" : "text/html",
  );
  if (req.url === "/api.js") return res.end(bundle.outputFiles[0].contents);
  if (req.url === "/frame") {
    res.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline' 'unsafe-eval' http: data: blob:;worker-src blob: data:;connect-src http:;",
    );
    return res.end(`<!doctype html><script type='module'>
import{createOpaqueWebSocket,createOpaqueWorkerManager}from'/api.js';
const apply=Reflect.apply,nativeData=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get,nativePortPost=MessagePort.prototype.postMessage,nativeListen=EventTarget.prototype.addEventListener,nativeStart=MessagePort.prototype.start,nativeClose=MessagePort.prototype.close,first=Object.getOwnPropertyDescriptor(MessageChannel.prototype,'port1').get,second=Object.getOwnPropertyDescriptor(MessageChannel.prototype,'port2').get;
const notify=parent.postMessage.bind(parent),chan=()=>{const c=new MessageChannel();return[apply(first,c,[]),apply(second,c,[])]}, socketPorts=chan();
const wsClient=createOpaqueWebSocket({port:socketPorts[0],documentId:'hostile_private_socket',documentURL:()=> 'https://site.test/page'});
const source=\`const apply=Reflect.apply,get=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;let leaked=0;Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get(){if(this.currentTarget instanceof MessagePort)leaked++;return apply(get,this,[])}});for(const key of ['postMessage','close','start']){const fn=MessagePort.prototype[key];MessagePort.prototype[key]=function(...args){leaked++;return apply(fn,this,args)}};self.onmessage=()=>{postMessage({workerLeak:leaked});self.close()};\`;
const stub='data:text/javascript,'+encodeURIComponent('export function bootOpaqueDedicatedWorker(){return{dispose(){}}}');
const manager=createOpaqueWorkerManager({global:self,documentURL:'https://site.test/page',network:{fetch:async()=>({ok:true,type:'basic',headers:new Headers({'content-type':'application/javascript'}),arrayBuffer:async()=>new TextEncoder().encode(source).buffer})},rewriter:{javascript:s=>s},coreSource:'',wasm:new Uint8Array(),runtimeModuleURL:stub,prefix:location.origin+'/logical/',bindWorker:async()=>{const a=chan(),b=chan();return{network:a[0],indexedDB:b[0],dispose(){for(let i=0;i<2;i++){apply(nativeClose,a[i],[]);apply(nativeClose,b[i],[])}}}},natives:{Worker,Blob,createObjectURL:URL.createObjectURL.bind(URL),revokeObjectURL:URL.revokeObjectURL.bind(URL)}});
let leaks=[];Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get(){if(this.currentTarget instanceof MessagePort)leaks.push('data');return apply(nativeData,this,[])}});
for(const key of ['postMessage','close','start']){const fn=MessagePort.prototype[key];MessagePort.prototype[key]=function(...args){leaks.push(key);return apply(fn,this,args)}};
const setAdd=Set.prototype.add,weakSet=WeakMap.prototype.set;Set.prototype.add=function(value){if(value?.control instanceof MessagePort)leaks.push('record-set');return apply(setAdd,this,[value])};WeakMap.prototype.set=function(key,value){if(value?.control instanceof MessagePort)leaks.push('record-weakmap');return apply(weakSet,this,[key,value])};
notify({type:'socket-offer'},'*',[socketPorts[1]]);
for(const key of ['port1','port2']){const descriptor=Object.getOwnPropertyDescriptor(MessageChannel.prototype,key);Object.defineProperty(MessageChannel.prototype,key,{...descriptor,get(){leaks.push('channel-'+key);return apply(descriptor.get,this,[])}})};
const iterator=Array.prototype[Symbol.iterator];Array.prototype[Symbol.iterator]=function(){for(let i=0;i<this.length;i++)if(this[i] instanceof MessagePort)leaks.push('transfer-iterator');return apply(iterator,this,[])};
const call=Function.prototype.call;Function.prototype.call=function(receiver,...args){if(receiver instanceof MessagePort)leaks.push('function-call');return apply(call,this,[receiver,...args])};

try{const socket=new wsClient.WebSocket('/socket');await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});const received=new Promise(r=>socket.onmessage=e=>r(e.data));socket.send('echo');const echo=await received;const worker=new manager.Worker('/worker.js');const workerReply=await new Promise((r,j)=>{worker.onmessage=e=>r(e.data);worker.onerror=e=>j(Error(e.message));worker.postMessage('deliver-after-ready')});await new Promise(r=>setTimeout(r,30));manager.dispose();wsClient.dispose();notify({type:'result',echo,workerReply,leaks,active:manager.active},'*')}catch(error){notify({type:'result',error:error.message,leaks},'*')}
</script>`);
  }
  res.end("<!doctype html><main></main>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(async () => {
    const { bindOpaqueWebSockets } = await import("/api.js");
    return new Promise((resolve, reject) => {
      let broker;
      const f = document.createElement("iframe");
      f.sandbox = "allow-scripts";
      f.src = "/frame";
      const timer = setTimeout(
        () => reject(Error("private port hardening timeout")),
        10000,
      );
      addEventListener("message", function receive(e) {
        if (e.source !== f.contentWindow) return;
        if (e.data?.type === "socket-offer")
          broker = bindOpaqueWebSockets({
            port: e.ports[0],
            documentId: "hostile_private_socket",
            documentURL: "https://site.test/page",
            frontendOrigin: location.origin,
            connect: (_u, _p, _c, events) => {
              queueMicrotask(() => events.open("", ""));
              let n = 0;
              return {
                send(value) {
                  events.message(value);
                },
                close() {
                  if (!n++) events.close(1000, "", true);
                },
              };
            },
          });
        if (e.data?.type === "result") {
          clearTimeout(timer);
          broker?.dispose();
          resolve(e.data);
        }
      });
      document.body.appendChild(f);
    });
  });
  console.log(JSON.stringify(result));
  assert.ok(!result.error);
  assert.equal(result.echo, "echo");
  assert.equal(result.workerReply.workerLeak, 0);
  assert.deepEqual(result.leaks, []);
  assert.equal(result.active, 0);
  fs.writeFileSync(
    "evidence/private-port-hardening-20261016/BROWSER.json",
    JSON.stringify(
      {
        result,
        browser: browser.version(),
        scope:
          "actual browser private-control prototypes; deterministic worker selfboot stub",
        exitStatus: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
