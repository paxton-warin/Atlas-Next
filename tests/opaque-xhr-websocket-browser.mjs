/** Actual copied RuntimeKit in a browser-enforced opaque Window, async XHR and
 * website WS through unchanged pinned HttpEngine workers and two authorized
 * local assigned Wisp nodes. Ephemeral ports only; no deployed fleet claims. */
import Fastify from "fastify";
import fs from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";
import { adaptPinnedRuntimeBundle } from "./opaque-runtime-fork.mjs";
import { adaptPinnedHttpEngine } from "../scripts/opaque-httpengine.mjs";
import { signTicket } from "../server/node-ticket.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const frontendApp = Fastify({ logger: false }),
  site = Fastify({ logger: false }),
  socketSite = Fastify({ logger: false }),
  nodes = [],
  calls = [],
  errors = [],
  payloads = [],
  wsRequests = [],
  closeFrames = [];
let browser;
const baseline = process.env.ATLAS_XHR_WS_BASELINE === "1",
  adaptedEngine = process.env.ATLAS_ADAPTED_HTTPENGINE === "1";
site.addContentTypeParser(
  "text/plain",
  { parseAs: "string" },
  (_r, body, done) => done(null, body),
);
site.get("/xhr", (req, reply) => {
  calls.push({
    path: req.url,
    origin: req.headers.origin || "",
    cookie: req.headers.cookie || "",
  });
  return reply
    .header("set-cookie", "xhr=durable; HttpOnly; Path=/; Max-Age=600")
    .header("x-visible", "yes")
    .type("application/json")
    .send({ ok: true, phase: req.query.phase });
});
site.post("/upload", (req, reply) => {
  calls.push({
    path: req.url,
    cookie: req.headers.cookie || "",
    body: req.body,
  });
  return reply.type("text/plain").send(req.body);
});
site.get("/slow", async (_req, reply) => {
  await new Promise((r) => setTimeout(r, 150));
  return reply.type("text/plain").send("late");
});
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  handleProtocols: (protocols) => [...protocols].at(-1),
});
wss.on("headers", (headers) =>
  headers.push("Set-Cookie: ws=durable; HttpOnly; Path=/; Max-Age=600"),
);
socketSite.server.on("upgrade", (req, socket, head) => {
  wsRequests.push({
    origin: req.headers.origin,
    cookie: req.headers.cookie || "",
    path: req.url,
  });
  if (req.url === "/redirect") {
    socket.end(
      "HTTP/1.1 302 Found\r\nLocation: /redirect-target\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data, binary) => ws.send(data, { binary }));
    ws.on("error", () => {});
    ws.on("close", (code, reason) =>
      closeFrames.push({ path: req.url, code, reason: String(reason) }),
    );
    if (req.url === "/server-close")
      setTimeout(() => ws.close(3002, "server-finish"), 20);
  });
});
const bundle = async (entry, format = "esm") =>
  (
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format,
      target: "es2022",
      platform: "browser",
      logLevel: "silent",
    })
  ).outputFiles[0].text;
const modules = new Map();
for (const [name, entry] of [
  ["relay", "sandbox-relay"],
  ["relay-worker", "sandbox-relay-worker"],
])
  modules.set("/" + name + ".js", await bundle("runtime/" + entry + ".ts"));
const parentBundle = (
  await build({
    stdin: {
      contents: `export {bindSandboxNetwork} from './runtime/sandbox-network.ts';export {bindOpaqueWebSockets} from './runtime/opaque-websocket.ts';export {SandboxCookieJar} from './runtime/sandbox-cookies.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    platform: "browser",
    logLevel: "silent",
  })
).outputFiles[0].text;
modules.set("/parent.js", parentBundle);
const childBundle = (
  await build({
    stdin: {
      contents: `import {createOpaqueXMLHttpRequest} from './runtime/opaque-xhr.ts';import {createOpaqueWebSocket} from './runtime/opaque-websocket.ts';import {createOpaqueNetworkClient,bootOpaqueRuntimeClient} from './runtime/opaque-runtime-adapter.ts';globalThis.fixture={createOpaqueXMLHttpRequest,createOpaqueWebSocket,createOpaqueNetworkClient,bootOpaqueRuntimeClient};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    platform: "browser",
    logLevel: "silent",
  })
).outputFiles[0].text;
for (const [path, source] of modules)
  frontendApp.get(path, (_r, reply) =>
    reply.type("application/javascript").send(source),
  );
frontendApp.get("/clients/httpengine-client.js", (_r, reply) =>
  reply
    .type("application/javascript")
    .send(
      (adaptedEngine ? adaptPinnedHttpEngine : (x) => x)(
        fs.readFileSync("runtime/public/clients/httpengine-client.js", "utf8"),
      ),
    ),
);
frontendApp.get("/", (_r, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Opaque XHR/WS qualification</title>"),
);
frontendApp.get("/favicon.ico", (_r, reply) => reply.code(204).send());
frontendApp.addHook("onRequest", (request, _reply, done) => {
  payloads.push(request.url);
  done();
});
const core = adaptPinnedRuntimeBundle(
    fs.readFileSync("runtime/public/runtime/runtimekit.js", "utf8"),
  ),
  wasm = fs
    .readFileSync("runtime/public/runtime/runtimekit.wasm")
    .toString("base64");
const source = `(async()=>{const request=(path,init={})=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open(init.method||'GET',path);x.responseType=init.responseType||'';const states=[];x.onreadystatechange=()=>states.push(x.readyState);x.onload=()=>resolve({status:x.status,response:x.response,text:x.responseType?'':x.responseText,url:x.responseURL,states,hidden:x.getResponseHeader('set-cookie')});x.onerror=()=>reject(Error('XHR error'));x.send(init.body??null)});stage('before-json');const json=await request('/xhr?phase='+PHASE,{responseType:'json'});stage('before-upload');const upload=await request('/upload',{method:'POST',body:'uploaded-'+PHASE});stage('before-timeout');const timed=await new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','/slow');x.timeout=15;x.ontimeout=()=>resolve({status:x.status,type:'timeout'});x.onerror=()=>resolve({status:x.status,type:'error'});x.send()});stage('before-denied');const denied=await new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET',FRONTEND+'/private');x.onerror=()=>resolve(x.status);x.onload=()=>resolve('leak');x.send()});stage('before-ws');const ws=new WebSocket(WS_URL,['first','actual']);const opened=await new Promise((resolve,reject)=>{ws.onopen=()=>resolve({protocol:ws.protocol,url:ws.url});ws.onerror=()=>reject(Error('WS open failed'))});stage('ws-opened');const receive=()=>new Promise(resolve=>ws.onmessage=e=>resolve(e));let result=receive();ws.send('text-'+PHASE);const text=(await result).data;ws.binaryType='arraybuffer';result=receive();const bytes=new Uint8Array([1,2,3,4]);ws.send(bytes.subarray(1,3));const binary=[...new Uint8Array((await result).data)];result=receive();ws.binaryType='blob';ws.send(new Blob(['blob-'+PHASE]));const blob=await (await result).data.text();const closing=new Promise(resolve=>ws.onclose=e=>resolve({code:e.code,clean:e.wasClean}));ws.close(3001,'held-close-parity');const close=await closing;let parentDenied=false;try{void parent.document.body}catch{parentDenied=true}return{json,upload,timed,denied,opened,text,binary,blob,close,parentDenied,origin:window.origin,constructor:XMLHttpRequest.name,wsConstructor:WebSocket.name}})()`;
const bootstrap = `${core}\n${childBundle}\nconst realParent=parent,nativeOrigin=window.origin;const nativeEval=eval,notify=parent.postMessage.bind(parent),wasm=Uint8Array.from(atob(${JSON.stringify(wasm)}),c=>c.charCodeAt(0));addEventListener('message',async e=>{if(e.data?.type!=='grant'||e.ports.length!==2)return;try{const d=e.data,network=fixture.createOpaqueNetworkClient({port:e.ports[0],documentId:d.documentId,documentURL:d.website});let boot;const xhr=fixture.createOpaqueXMLHttpRequest({window,documentURL:()=>boot?.client.url.href||d.website,fetch:network.fetch,request:network.request});const sockets=fixture.createOpaqueWebSocket({window,port:e.ports[1],documentId:d.documentId,documentURL:()=>boot?.client.url.href||d.website});const storage={getItem:()=>null,setItem(){},removeItem(){},clear(){},key:()=>null,length:0};boot=fixture.bootOpaqueRuntimeClient({global:window,core:$runtimekit,wasm,documentURL:d.website,prefix:d.frontend+'/~/app/xhr-ws/',network,localStorage:storage,sessionStorage:storage,installIndexedDB:()=>{},installXHR:d.baseline?undefined:()=>xhr.install(),installWebSocket:d.baseline?undefined:()=>sockets.install(),onNavigate:()=>{},sendSetCookie:async()=>{throw Error('stock cookie path')}});for(const p of e.ports)boot.client.nativeMessagePorts.add(p);globalThis.PHASE=d.phase;globalThis.FRONTEND=d.frontend;globalThis.WS_URL=d.socketURL;globalThis.stage=label=>notify({type:"stage",label},"*");const result=d.baseline?await(async()=>{let xhrDenied=false;try{new XMLHttpRequest()}catch(e){xhrDenied=e.name==='NotSupportedError'}let wsDenied=false;try{const socket=new WebSocket(d.socketURL);wsDenied=await new Promise(resolve=>socket.onerror=()=>resolve(true));}catch(e){wsDenied=e.name==='NotSupportedError'}return{xhrDenied,wsDenied}})():await nativeEval(boot.rewriter.javascript(${JSON.stringify(source)}));result.parentDenied=(()=>{try{void realParent.document.body;return false}catch{return true}})();result.origin=nativeOrigin;notify({type:'result',phase:d.phase,result},'*');}catch(error){notify({type:'result',phase:e.data.phase,error:{name:error.name,message:error.message,stack:error.stack?.split('\\n').slice(0,6)}},'*')}});notify({type:'ready'},'*');`;
try {
  await site.listen({ host: "127.0.0.1", port: 0 });
  await socketSite.listen({ host: "127.0.0.1", port: 0 });
  const socketURL =
    "ws://127.0.0.1:" + socketSite.server.address().port + "/echo";
  // The existing production module's local-fixture exception is4199-only.
  // Preserve it; adapt only an authenticated read-only test COPY to this test's
  // allocated website port, never touching shared4199 or production guards.
  const evidence = new URL(
    "../evidence/combined-update-20261015/opaque-xhr-websocket/",
    import.meta.url,
  );
  fs.mkdirSync(evidence, { recursive: true });
  const runtimeURL = new URL("../server/runtime.mjs", import.meta.url),
    nodeURL = new URL("../server/node-service.mjs", import.meta.url);
  const originalRuntime = fs.readFileSync(runtimeURL, "utf8");
  assert.equal(originalRuntime.split("this.port === 4199").length, 2);
  const imports = (source, base, special = {}) =>
    source.replace(
      /(from\s+["'])\.\/([^"']+)/g,
      (_match, start, path) =>
        start + (special[path] || new URL(path, base).href),
    );
  const runtimeCopy = new URL("fixture-runtime.mjs", evidence),
    nodeCopy = new URL("fixture-node-service.mjs", evidence);
  fs.writeFileSync(
    new URL("fixture-runtime-baseline.mjs", evidence),
    originalRuntime,
  );
  fs.writeFileSync(
    runtimeCopy,
    imports(
      originalRuntime.replace(
        "this.port === 4199",
        "[" +
          site.server.address().port +
          "," +
          socketSite.server.address().port +
          "].includes(this.port)",
      ),
      runtimeURL,
    ),
  );
  fs.writeFileSync(
    nodeCopy,
    imports(fs.readFileSync(nodeURL, "utf8"), nodeURL, {
      "runtime.mjs": runtimeCopy.href,
    }),
  );
  fs.writeFileSync(
    new URL("fixture-source.json", evidence),
    JSON.stringify(
      {
        productionRuntimeSHA256: createHash("sha256")
          .update(originalRuntime)
          .digest("hex"),
        testRuntimeSHA256: createHash("sha256")
          .update(fs.readFileSync(runtimeCopy))
          .digest("hex"),
        onlyGuardChange:
          "fixture-only localhost:4199 becomes this process's allocated ephemeral HTTP and WS website ports",
        productionEdited: false,
      },
      null,
      2,
    ),
  );
  const { createNodeService } = await import(
    nodeCopy.href + "?port=" + site.server.address().port
  );
  const website = "http://127.0.0.1:" + site.server.address().port + "/page";
  await frontendApp.listen({ host: "127.0.0.1", port: 0 });
  const frontend = "http://localhost:" + frontendApp.server.address().port,
    lease = "d".repeat(64),
    secret = "xhr-websocket-controlled-secret-0123456789";
  for (let i = 0; i < 2; i++) {
    const node = await createNodeService({
      id: "xhr-ws-node-" + i,
      secret,
      fixture: true,
      staticDir: "/not-built",
      runtimeOrigin: "http://localhost:1",
    });
    await node.listen({ host: "127.0.0.1", port: 0 });
    node.applyControl({
      state: "active",
      revision: 1,
      leases: [lease],
      grants: [{ hash: lease, generation: 1, expiresAt: Date.now() + 600000 }],
    });
    nodes.push(node);
  }
  const assignments = nodes.map((node, i) => {
    const origin = "http://localhost:" + node.server.address().port;
    return {
      origin,
      generation: 1,
      sessionHash: lease,
      ticket: signTicket(
        {
          lease,
          generation: 1,
          node: "xhr-ws-node-" + i,
          name: "Controlled node" + i,
          origin: frontend,
          runtimeOrigin: frontend,
          relayOrigin: origin,
          role: "frontend-controller-v2",
          expires: Date.now() + 600000,
        },
        secret,
      ),
    };
  });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(frontend);
  const results = await page.evaluate(
    async ({
      assignments,
      website,
      bootstrap,
      socketURL,
      baseline,
      adaptedEngine,
    }) => {
      const {
          createSandboxRelay,
          createSandboxRelayFetch,
          createSandboxRelayWebSocketConnect,
        } = await import("/relay.js"),
        { bindSandboxNetwork, bindOpaqueWebSockets, SandboxCookieJar } =
          await import("/parent.js");
      const cookie = new SandboxCookieJar({
        factory: indexedDB,
        browserSessionId: "xhr_ws_shared_browser_session_012345",
        forbiddenOrigins: [
          location.origin,
          ...assignments.map((a) => a.origin),
        ],
      });
      await cookie.storeResponseCookies(
        ["seed=trusted; HttpOnly; Path=/; Max-Age=600"],
        {
          requestURL: website,
          documentURL: website,
          topLevelURL: website,
          credentials: "include",
        },
      );
      const output = [];
      for (let phase = 0; phase < 2; phase++) {
        const relay = await createSandboxRelay({
          assignment: assignments[phase],
          workerURL: "/relay-worker.js",
          timeoutMs: 5000,
        });
        const documentId = "real_xhr_ws_document_" + phase,
          networkChannel = new MessageChannel(),
          socketChannel = new MessageChannel();
        const fetch = createSandboxRelayFetch({
          documentId,
          documentURL: website,
          topLevelURL: website,
          frontendOrigin: location.origin,
          forbiddenOrigins: assignments.map((a) => a.origin),
          relay,
          cookies: cookie,
        });
        const broker = bindSandboxNetwork({
          documentId,
          documentURL: website,
          frontendOrigin: location.origin,
          forbiddenOrigins: assignments.map((a) => a.origin),
          port: networkChannel.port1,
          fetch,
        });
        const wsBroker = bindOpaqueWebSockets({
          documentId,
          documentURL: website,
          frontendOrigin: location.origin,
          forbiddenOrigins: assignments.map((a) => a.origin),
          port: socketChannel.port1,
          connect: baseline
            ? async () => {
                throw Error("baseline default deny");
              }
            : createSandboxRelayWebSocketConnect({
                documentId,
                documentURL: website,
                topLevelURL: website,
                frontendOrigin: location.origin,
                forbiddenOrigins: assignments.map((a) => a.origin),
                relay,
                cookies: cookie,
              }),
        });
        const frame = document.createElement("iframe");
        frame.sandbox = "allow-scripts";
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("opaque fixture deadline")),
            20000,
          );
          const receive = (e) => {
            if (e.source !== frame.contentWindow) return;
            if (e.data?.type === "ready")
              frame.contentWindow.postMessage(
                {
                  type: "grant",
                  baseline,
                  website,
                  socketURL,
                  documentId,
                  phase,
                  frontend: location.origin,
                },
                "*",
                [networkChannel.port2, socketChannel.port2],
              );
            else if (e.data?.type === "result") {
              clearTimeout(timer);
              removeEventListener("message", receive);
              resolve(e.data);
            }
          };
          addEventListener("message", receive);
        });
        frame.srcdoc =
          "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'\"><script>" +
          bootstrap.replaceAll("</script", "<\\/script") +
          "</script>";
        document.body.append(frame);
        output.push(await result);
        frame.remove();
        broker.dispose();
        wsBroker.dispose();
        relay.dispose();
      }
      if (!baseline) {
        const relay = await createSandboxRelay({
          assignment: assignments[0],
          workerURL: "/relay-worker.js",
          timeoutMs: 5000,
        });
        const documentId = "replacement_real_ws_document",
          signal = new AbortController();
        const connect = createSandboxRelayWebSocketConnect({
          documentId,
          documentURL: website,
          topLevelURL: website,
          frontendOrigin: location.origin,
          forbiddenOrigins: assignments.map((a) => a.origin),
          relay,
          cookies: cookie,
        });
        const context = {
          documentId,
          documentURL: website,
          origin: new URL(website).origin,
          signal: signal.signal,
        };
        const opening = (url) =>
          new Promise(async (resolve, reject) => {
            let socket;
            const messages = [];
            let deliver, finishClose;
            const closed = new Promise((r) => (finishClose = r));
            const timer = setTimeout(
              () => reject(Error("direct WS fixture timeout")),
              7000,
            );
            const events = {
              open: (actual) => {
                clearTimeout(timer);
                resolve({
                  socket,
                  actual,
                  closed,
                  receive: () =>
                    messages.length
                      ? Promise.resolve(messages.shift())
                      : new Promise((r) => (deliver = r)),
                });
              },
              message: (v) => {
                if (deliver) {
                  const r = deliver;
                  deliver = undefined;
                  r(v);
                } else messages.push(v);
              },
              close: (code, reason, wasClean) => {
                finishClose({ code, reason, wasClean });
                clearTimeout(timer);
                reject(Error("closed before open"));
              },
              error: () => {},
            };
            try {
              socket = await connect(url, ["first", "actual"], context, events);
            } catch (e) {
              clearTimeout(timer);
              reject(e);
            }
          });
        const first = await opening(socketURL);
        await first.socket.send("before-replace");
        const before = await first.receive();
        await relay.replace(assignments[1], { allowNodeChange: true });
        await first.socket.send("after-replace");
        const after = await first.receive();
        const retained = relay.webSockets === 1;
        const second = await opening(socketURL);
        await second.socket.send("new-peer");
        const newPeer = await second.receive();
        const remote = await opening(
            socketURL.replace("/echo", "/server-close"),
          ),
          serverClose = await remote.closed;
        let redirectDenied = false;
        try {
          await opening(socketURL.replace("/echo", "/redirect"));
        } catch {
          redirectDenied = true;
        }
        output.push({
          transport: {
            before,
            after,
            newPeer,
            retained,
            redirectDenied,
            actual: first.actual,
            secondActual: second.actual,
            serverClose,
          },
        });
        signal.abort();
        relay.dispose();
      }
      cookie.close();
      return output;
    },
    { assignments, website, bootstrap, socketURL, baseline, adaptedEngine },
  );
  if (baseline) {
    for (const value of results) {
      assert.equal(value.error, undefined, JSON.stringify(value));
      assert.equal(value.result.xhrDenied, true);
      assert.equal(value.result.wsDenied, true);
      assert.equal(value.result.parentDenied, true);
    }
    assert.equal(calls.length, 0);
    assert.equal(wsRequests.length, 0);
    console.log(
      JSON.stringify({
        phases: 2,
        baseline: "existing default opaque runtime denies XHR and website WS",
        payloadRequests: 0,
        passed: true,
      }),
    );
  } else {
    for (const [phase, value] of results.slice(0, 2).entries()) {
      assert.equal(value.error, undefined, JSON.stringify(value));
      const r = value.result;
      assert.equal(r.json.response.ok, true);
      assert.equal(r.json.response.phase, String(phase));
      assert.equal(r.json.hidden, null);
      assert.equal(r.upload.text, "uploaded-" + phase);
      assert.deepEqual(r.timed, { status: 0, type: "timeout" });
      assert.equal(r.denied, 0);
      assert.equal(r.opened.protocol, "actual");
      assert.equal(r.text, "text-" + phase);
      assert.deepEqual(r.binary, [2, 3]);
      assert.equal(r.blob, "blob-" + phase);
      assert.deepEqual(
        r.close,
        adaptedEngine
          ? { code: 3001, clean: true }
          : { code: 1006, clean: false },
      );
      assert.equal(r.parentDenied, true);
      assert.equal(r.origin, "null");
    }
    assert.deepEqual(results[2].transport, {
      before: "before-replace",
      after: "after-replace",
      newPeer: "new-peer",
      retained: true,
      redirectDenied: true,
      actual: "actual",
      secondActual: "actual",
      serverClose: adaptedEngine
        ? { code: 3002, reason: "server-finish", wasClean: true }
        : { code: 1006, reason: "", wasClean: false },
    });
    assert.equal(
      wsRequests.some((r) => r.path === "/redirect-target"),
      false,
      "unchecked WS redirects must not be followed",
    );
    assert.equal(wsRequests.length, 6);
    if (adaptedEngine)
      assert.deepEqual(
        closeFrames.find((x) => x.path === "/server-close"),
        { path: "/server-close", code: 3002, reason: "server-finish" },
        "real peer received matching close ACK",
      );
    for (const req of wsRequests) {
      assert.equal(req.origin, new URL(website).origin);
      assert.match(req.cookie, /seed=trusted/);
      assert.match(req.cookie, /xhr=durable/);
      assert.ok(!req.cookie.includes("Atlas"));
    }
    assert.ok(
      calls
        .filter((x) => x.path === "/upload")
        .every((x) => x.cookie.includes("xhr=durable")),
    );
    assert.equal(
      payloads.some(
        (p) =>
          p.startsWith("/xhr") ||
          p.startsWith("/upload") ||
          p.startsWith("/echo") ||
          p.startsWith("/private"),
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          phases: 2,
          xhrAndWebSocket: true,
          actualCopiedRuntimeKit: true,
          opaqueOrigin: true,
          actualPinnedHttpEngine: true,
          adaptedEngine,
          closeFrames,
          authorizedAssignedNodes: 2,
          frontendPayloadRequests: 0,
          logicalOriginAndHttpOnlyCookies: true,
          realReplacementRetainsEstablishedWS: true,
          uncheckedWebSocketRedirectDenied: true,
          closeHandshakeParity: adaptedEngine
            ? "Real client3001/server3002 close code/reason and matching native peer ACK observed; partial write/backpressure remains held"
            : "Original pin: unclean1006 fallback",
          results,
          requests: calls,
          websockets: wsRequests,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await browser?.close();
  for (const node of nodes) await node.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => wss.close(r));
  await site.close();
  await socketSite.close();
  await frontendApp.close();
}
