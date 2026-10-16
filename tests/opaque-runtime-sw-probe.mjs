/** Browser truth probe: opaque header document vs opaque srcdoc under a scoped,
 * genuinely controlling service worker. No runtime or server files modified. */
import http from "node:http";
import { chromium } from "@playwright/test";
const networkFallbacks = [];
const sw = `addEventListener('install',e=>e.waitUntil(skipWaiting()));addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('fetch',event=>{const url=new URL(event.request.url);if(!url.pathname.startsWith('/sw-probe/'))return;event.respondWith((async()=>{for(const c of await clients.matchAll({includeUncontrolled:true}))c.postMessage({type:'sw-fetch',path:url.pathname,clientId:event.clientId,destination:event.request.destination,mode:event.request.mode});let type='text/plain',body='SERVICE_WORKER_RESPONSE';if(url.pathname.includes('/script-')){type='application/javascript';body='parent.postMessage({type:"resource-result",kind:"script",mode:'+JSON.stringify(url.pathname.split('/script-')[1])+'},"*")'}if(url.pathname.includes('/image-')){type='image/svg+xml';body='<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>'}return new Response(body,{headers:{'content-type':type,'access-control-allow-origin':'*'}})})())});`;
let origin;
const html = (mode) =>
  `<!doctype html><html><body><script src="${origin}/sw-probe/script-${mode}"></script><img id="probe-image" src="${origin}/sw-probe/image-${mode}" onload="(()=>{let readable=true;try{let c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(this,0,0);c.getContext('2d').getImageData(0,0,1,1)}catch{readable=false}parent.postMessage({type:'resource-result',kind:'image',mode:'${mode}',readable},'*')})()" onerror="parent.postMessage({type:'resource-result',kind:'image-error',mode:'${mode}'},'*')"><script>const report=(value)=>parent.postMessage({type:'resource-result',mode:'${mode}',...value},'*');try{report({kind:'controller',value:!!navigator.serviceWorker.controller})}catch(e){report({kind:'controller',value:e.name})}fetch('${origin}/sw-probe/fetch-${mode}').then(async r=>report({kind:'fetch',value:await r.text(),responseType:r.type})).catch(e=>report({kind:'fetch',value:e.message}));fetch('${origin}/sw-probe/opaque-${mode}',{mode:'no-cors'}).then(async r=>report({kind:'no-cors',value:await r.text(),responseType:r.type})).catch(e=>report({kind:'no-cors',value:e.message}));</script></body></html>`;
const server = http.createServer((request, reply) => {
  reply.setHeader("Cache-Control", "no-store");
  if (request.url === "/probe-sw.js") {
    reply.setHeader("Content-Type", "application/javascript");
    reply.end(sw);
    return;
  }
  if (request.url === "/opaque-frame") {
    reply.setHeader("Content-Type", "text/html");
    reply.setHeader(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http:; connect-src http:; img-src http:",
    );
    reply.end(html("header"));
    return;
  }
  if (request.url.startsWith("/sw-probe/")) {
    networkFallbacks.push(request.url);
    reply.statusCode = 418;
    reply.setHeader("Access-Control-Allow-Origin", "*");
    reply.end("NETWORK_FALLBACK");
    return;
  }
  reply.setHeader("Content-Type", "text/html");
  reply.end("<!doctype html><title>Scoped SW opaque resource probe</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/probe-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  const controlled = await page.evaluate(
    () => !!navigator.serviceWorker.controller,
  );
  const srcdoc = html("srcdoc");
  const result = await page.evaluate(
    async ({ srcdoc }) => {
      const results = [],
        worker = [];
      navigator.serviceWorker.addEventListener("message", (event) =>
        worker.push(event.data),
      );
      addEventListener("message", (event) => {
        if (event.data?.type === "resource-result") results.push(event.data);
      });
      const header = document.createElement("iframe");
      header.sandbox = "allow-scripts";
      header.src = "/opaque-frame";
      document.body.append(header);
      const inline = document.createElement("iframe");
      inline.sandbox = "allow-scripts";
      inline.srcdoc = srcdoc;
      document.body.append(inline);
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return {
        results,
        worker,
        headerOpaque: header.contentDocument === null,
        srcdocOpaque: inline.contentDocument === null,
      };
    },
    { srcdoc },
  );
  console.log(
    JSON.stringify({ controlled, ...result, networkFallbacks }, null, 2),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
