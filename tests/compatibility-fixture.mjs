import { readFileSync } from "node:fs";
export function compatibilityFixture(req, res, url) {
  if (url.pathname === "/compatibility-icons.svg") {
    res.setHeader("content-type", "image/svg+xml");
    res.end(
      '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="fixture-icon" viewBox="0 0 24 24"><rect width="24" height="24" fill="#48a"/></symbol></svg>',
    );
    return true;
  }
  if (url.pathname === "/compatibility-icons") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><title>SVG icon fixture</title><h1>SVG icon fixture</h1><svg width="24" height="24"><use id="parsed-icon" href="/compatibility-icons.svg#fixture-icon"/></svg><svg width="24" height="24"><use id="dynamic-icon"/></svg><svg width="24" height="24"><use id="property-icon"/></svg><svg width="24" height="24"><use id="xlink-icon"/></svg><svg width="24" height="24"><defs><symbol id="local-symbol"><rect width="24" height="24"/></symbol></defs><use id="local-icon" href="#local-symbol"/></svg><script>document.querySelector("#dynamic-icon").setAttribute("href","/compatibility-icons.svg#fixture-icon");document.querySelector("#property-icon").href.baseVal="/compatibility-icons.svg#fixture-icon";document.querySelector("#xlink-icon").setAttributeNS("http://www.w3.org/1999/xlink","xlink:href","/compatibility-icons.svg#fixture-icon")</script>',
    );
    return true;
  }
  if (url.pathname === "/compatibility-root-imports") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Root module fixture</title><h1>Root module fixture</h1><output id="root-classic">waiting</output><output id="root-module">waiting</output><output id="root-function">waiting</output><output id="root-inline">waiting</output><script>
      const path='/compatibility-modules/value.js';
      import(path).then(m=>document.querySelector('#root-classic').textContent=m.value).catch(()=>document.querySelector('#root-classic').textContent='failed');
      Function('path','return import(path)')(path).then(m=>document.querySelector('#root-function').textContent=m.value).catch(()=>document.querySelector('#root-function').textContent='failed');
      const inline=document.createElement('script');inline.type='module';inline.textContent="import('/compatibility-modules/value.js').then(m=>document.querySelector('#root-inline').textContent=m.value)";document.head.append(inline);
      </script><script type="module" src="/compatibility-root-loader.js"></script>`);
    return true;
  }
  if (url.pathname === "/compatibility-root-loader.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(
      `export const __rspack_esm_id=1;export const __rspack_esm_ids=[1];export const __webpack_modules__={fixture:()=>{const route={module:innerWidth<1100?'/compatibility-modules/narrow.js':'/compatibility-modules/wide.js'};import(route.module).then(m=>document.querySelector('#root-module').textContent=m.value).catch(()=>document.querySelector('#root-module').textContent='failed')}};__webpack_modules__.fixture()`,
    );
    return true;
  }
  if (url.pathname === "/compatibility-request-echo") {
    const chunks = [];
    req.on("data", (part) => chunks.push(part));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          header: req.headers["x-fixture"] || "",
          cookie:
            req.headers.cookie?.includes("credentials_fixture=retained") ||
            false,
        }),
      );
    });
    return true;
  }
  if (url.pathname === "/compatibility-request-credentials") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("set-cookie", "credentials_fixture=retained; Path=/");
    res.end(`<!doctype html><title>Request credentials fixture</title><h1>Request credentials fixture</h1><output id="request-omit">waiting</output><output id="request-include">waiting</output><output id="clone-omit">waiting</output><output id="request-post">waiting</output><output id="request-used">waiting</output><output id="request-getter">waiting</output><script>
      (async()=>{
        const endpoint='/compatibility-cookie-echo?set=0';
        document.querySelector('#request-omit').textContent=await(await fetch(new Request(endpoint,{credentials:'include'}),{credentials:'omit'})).text();
        document.querySelector('#request-include').textContent=await(await fetch(new Request(endpoint,{credentials:'omit'}),{credentials:'include'})).text();
        document.querySelector('#clone-omit').textContent=await(await fetch(new Request(new Request(endpoint,{credentials:'include'}),{credentials:'omit'}))).text();
        const input=new Request('/compatibility-request-echo',{method:'POST',body:'fixture-payload',headers:{'X-Fixture':'retained'},credentials:'include'});
        document.querySelector('#request-post').textContent=JSON.stringify(await(await fetch(input,{credentials:'omit'})).json());
        let returned=false;try{const again=fetch(input,{credentials:'omit'});returned=again instanceof Promise;await again;document.querySelector('#request-used').textContent='unexpected success'}catch{document.querySelector('#request-used').textContent=returned?'promise rejection':'sync throw'}
        let reads=0;const options={get credentials(){reads++;return 'omit'}};const observed=await(await fetch(new Request(endpoint),options)).text();document.querySelector('#request-getter').textContent=reads+':'+observed;
      })().catch(()=>document.querySelector('#request-used').textContent='fixture error');
    </script>`);
    return true;
  }
  if (url.pathname === "/compatibility-cookie-echo") {
    res.setHeader("content-type", "text/plain");
    if (url.searchParams.get("set") !== "0")
      res.setHeader("set-cookie", "omit_response=should-not-store; Path=/");
    res.end(
      req.headers.cookie?.includes("credentials_fixture=retained")
        ? "cookie present"
        : "no cookie",
    );
    return true;
  }
  if (url.pathname === "/compatibility-credentials") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("set-cookie", "credentials_fixture=retained; Path=/");
    res.end(
      `<!doctype html><h1>Credentials fixture</h1><output id="include">waiting</output><output id="omit">waiting</output><output id="stored">waiting</output><script>(async()=>{document.querySelector('#include').textContent=await(await fetch('/compatibility-cookie-echo?set=0',{credentials:'include'})).text();const text=await(await fetch('/compatibility-cookie-echo',{credentials:'omit'})).text();document.querySelector('#omit').textContent=text;document.querySelector('#stored').textContent=document.cookie.includes('omit_response=')?'stored':'not stored'})()</script>`,
    );
    return true;
  }
  if (url.pathname === "/compatibility-opaque-parent") {
    const order = url.searchParams.get("order");
    const source = `/compatibility-opaque-child${url.searchParams.get("real") === "1" ? "?real=1" : ""}`;
    const setup =
      order === "src-first"
        ? `frame.src=${JSON.stringify(source)};frame.sandbox.add('allow-scripts');`
        : order === "attr-first"
          ? `frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('src',${JSON.stringify(source)});`
          : order === "attr-last"
            ? `frame.setAttribute('src',${JSON.stringify(source)});frame.setAttribute('sandbox','allow-scripts');`
            : order === "value"
              ? `frame.src=${JSON.stringify(source)};frame.sandbox.value='allow-scripts';`
              : `frame.sandbox.add('allow-scripts');frame.src=${JSON.stringify(source)};`;
    res.setHeader("content-type", "text/html; charset=utf-8");
    const parsed = order === "parsed";
    res.end(`<!doctype html><title>Opaque renderer parent</title><h1>Opaque renderer parent</h1><output id="opaque-result">waiting</output><output id="opaque-port">waiting</output><output id="opaque-peer">waiting</output>${parsed ? `<iframe title="Opaque renderer fixture" sandbox="allow-scripts" src="${source}"></iframe>` : ""}<script>
    ${parsed ? `const frame=document.querySelector('iframe');` : `const frame=document.createElement('iframe');frame.title='Opaque renderer fixture';${setup}document.body.append(frame);`}
    addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;if(event.data==='opaque fixture ready'||event.data?.__oaiDilFrame===true&&event.data.kind==='ready'){document.querySelector('#opaque-result').textContent='ready:'+event.origin;if(event.ports[0]){const port=event.ports[0];port.onmessage=e=>document.querySelector('#opaque-port').textContent='port:'+e.data;port.postMessage('host-ready');port.start();const peer=new MessageChannel();peer.port1.onmessage=e=>document.querySelector('#opaque-peer').textContent='peer:'+e.data;peer.port1.start();port.postMessage('transfer-peer',[peer.port2]);peer.port1.postMessage('peer-ready')}}});
    </script>`);
    return true;
  }
  if (url.pathname === "/compatibility-opaque-child") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.searchParams.get("real") === "1") {
      const html = readFileSync(
        "evidence/goal-compatibility-20261013/renderer-public.html",
        "utf8",
      ).replace(
        'src="/assets/dil/',
        'src="https://cdn.platform.openai.com/assets/dil/',
      );
      res.end(html);
    } else
      res.end(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><title>Opaque renderer child</title><h1>Opaque renderer child</h1><script type="module" src="/compatibility-opaque-module.js"></script>`,
      );
    return true;
  }
  if (url.pathname === "/compatibility-opaque-module.js") {
    res.setHeader("content-type", "application/javascript");
    res.setHeader("access-control-allow-origin", "*");
    res.end(`const channel=new MessageChannel();channel.port1.onmessage=e=>{if(e.data==='transfer-peer'&&e.ports[0]){e.ports[0].onmessage=message=>e.ports[0].postMessage(typeof message.data==='string'?'reply:'+message.data:'unexpected envelope');e.ports[0].start()}else channel.port1.postMessage(typeof e.data==='string'?'reply:'+e.data:'unexpected envelope')};channel.port1.start();
    const worker=new Worker(URL.createObjectURL(new Blob(["onmessage=()=>postMessage('worker ready')"],{type:'text/javascript'})));worker.onmessage=()=>{parent.postMessage('opaque fixture ready','*',[channel.port2]);worker.terminate()};worker.postMessage('start');`);
    return true;
  }
  if (url.pathname === "/compatibility-stream") {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-store");
    res.write('data: {"piece":"fixture "}\n\n');
    const timer = setTimeout(
      () => res.end('data: {"piece":"reply"}\n\ndata: [DONE]\n\n'),
      50,
    );
    res.on("close", () => clearTimeout(timer));
    return true;
  }
  if (url.pathname === "/compatibility-media.mp4") {
    const bytes = Buffer.from("0123456789");
    res.setHeader("content-type", "video/mp4");
    res.setHeader("accept-ranges", "bytes");
    if (req.headers.range === "bytes=2-5") {
      res.statusCode = 206;
      res.setHeader("content-range", "bytes 2-5/10");
      res.end(bytes.subarray(2, 6));
    } else res.end(bytes);
    return true;
  }
  if (url.pathname === "/compatibility-renderer") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><title>Renderer fixture</title><h1>Nested renderer</h1><output id="reply">waiting</output><output id="range">waiting</output><script>
    (async()=>{const response=await fetch('/compatibility-stream');const reader=response.body.getReader();let text='';for(;;){const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value)}document.querySelector('#reply').textContent=text.includes('[DONE]')?'stream complete':'stream incomplete';const range=await fetch('/compatibility-media.mp4',{headers:{Range:'bytes=2-5'}});document.querySelector('#range').textContent=range.status+':'+await range.text()})()
    </script>`);
    return true;
  }
  if (url.pathname === "/compatibility-renderer-parent") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><title>Ordinary page</title><h1>Renderer parent</h1><iframe title="Nested renderer fixture" src="/compatibility-renderer"></iframe>',
    );
    return true;
  }
  if (
    [
      "/compatibility-modules/value.js",
      "/compatibility-modules/narrow.js",
      "/compatibility-modules/wide.js",
    ].includes(url.pathname)
  ) {
    res.setHeader("content-type", "application/javascript");
    res.end('export const value="prefix modules ready"');
    return true;
  }
  if (url.pathname === "/compatibility-importmap") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><title>Module fixture</title><h1>Module fixture</h1><output id="module-result">waiting</output><output id="dynamic-result">waiting</output><script type="importmap">{"imports":{"fixture/":"/compatibility-modules/"}}</script><script type="module">import {value} from 'fixture/value.js';document.querySelector('#module-result').textContent=value;import('fixture/value.js').then(module=>document.querySelector('#dynamic-result').textContent=module.value)</script>`,
    );
    return true;
  }
  if (url.pathname === "/compatibility-worker.js") {
    res.setHeader("content-type", "application/javascript");
    res.end('onmessage=()=>postMessage("worker ready")');
    return true;
  }
  if (url.pathname !== "/compatibility-fixture") return false;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(`<!doctype html><title>Fixture game title</title><meta name="description" content="Game description unchanged by default"><h1>Game fixture</h1><p>Game controls and gameplay instructions stay visible.</p><input id="draft" aria-label="Game draft"><canvas id="game" width="40" height="40"></canvas><button id="move">Move</button><output id="score">0</output><button id="dynamic">Change metadata</button><button id="full">Fullscreen</button><button id="wasm">Run WASM</button><output id="wasm-result"></output><button id="worker">Run worker</button><output id="worker-result"></output><script>
 let score=0;move.onclick=()=>{document.querySelector('#score').textContent=String(++score)};dynamic.onclick=()=>{document.title='Dynamic game title';document.querySelector('meta[name=description]').content='Dynamic description'};full.onclick=()=>document.documentElement.requestFullscreen();document.querySelector('#game').getContext('2d').fillRect(0,0,20,20);
 document.querySelector('#wasm').onclick=async()=>{await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));document.querySelector('#wasm-result').textContent='WASM ready'};
 document.querySelector('#worker').onclick=()=>{const worker=new Worker('/compatibility-worker.js');worker.onmessage=e=>{document.querySelector('#worker-result').textContent=e.data;worker.terminate()};worker.postMessage('start')};
 document.cookie='compat_fixture=retained; Path=/';localStorage.setItem('game-progress','retained');
 </script>`);
  return true;
}
