import { serveSeamlessFixture } from './hub-lab-seamless-fixture.mjs';
/** Deterministic website fixtures. The launcher exposes these only in its test process. */
export function fixtureWave() {
  const rate = 8000,
    frames = 2400,
    bytes = frames * 2;
  const wave = Buffer.alloc(44 + bytes);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + bytes, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++)
    wave.writeInt16LE(
      Math.round(Math.sin((i * 440 * Math.PI * 2) / rate) * 1800),
      44 + i * 2,
    );
  return wave;
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas local save fixture</title>
<style>body{font:18px system-ui;background:#132019;color:#e4efdd;padding:24px;margin:0}main{max-width:900px}button,input{font:inherit;margin:6px;padding:10px;max-width:100%;box-sizing:border-box}button{border:1px solid #a7c496;border-radius:8px;background:#badf9a;color:#172215;cursor:pointer}section{border-top:1px solid #45604e;margin-top:24px;padding-top:12px}output{display:block;min-height:1.5em;overflow-wrap:anywhere}iframe{width:100%;height:90px;border:1px solid #45604e}label{display:block}audio{max-width:100%}@media(max-width:390px){body{padding:12px}input{width:100%;margin-left:0}}</style>
<main><h1>Local browsing fixture</h1><p>Deterministic saves and browser features. This page makes no external requests.</p>
<label>Draft <input id="draft" value="Unsaved form state"></label><button id="count">Count: 0</button><button id="save">Save count</button><output id="saved" aria-live="polite"></output>
<section><h2>IndexedDB</h2><button id="idb-save">Save record</button><button id="idb-read">Read record</button><button id="idb-abort">Abort record</button><output id="idb-result" aria-live="polite">No record read</output></section>
<section><h2>Cookies</h2><button id="cookie-save">Save cookie</button><button id="cookie-read">Read cookie</button><output id="cookie-result" aria-live="polite">No cookie read</output></section>
<section><h2>Modules and workers</h2><output id="module-result">Module pending</output><button id="worker">Run worker</button><output id="worker-result"></output><button id="module-worker">Run module worker</button><output id="module-worker-result"></output></section>
<section><h2>Frames and popups</h2><iframe title="Nested fixture" src="./child"></iframe><output id="frame-result">Frame pending</output><button id="popup">Open popup</button><output id="popup-result"></output></section>
<section><h2>Network and media</h2><button id="fetch">Fetch fixture</button><output id="fetch-result"></output><audio id="audio" controls preload="metadata" src="./tone.wav"></audio><button id="media">Play test tone</button><output id="media-result"></output></section></main>
<script>
const byId=id=>document.getElementById(id);let count=Number(localStorage.getItem('atlas-lab-count')||0);const counter=byId('count');counter.textContent='Count: '+count;counter.onclick=()=>counter.textContent='Count: '+(++count);byId('save').onclick=()=>{try{localStorage.setItem('atlas-lab-count',String(count));byId('saved').textContent='Saved '+count}catch(e){byId('saved').textContent='Save failed: '+e.name}};
const fail=(id,e)=>{byId(id).textContent='Error: '+(e?.name||'UnknownError')};
const dbReady=new Promise((resolve,reject)=>{const request=indexedDB.open('atlas-lab-fixture',1);request.onupgradeneeded=()=>{const store=request.result.createObjectStore('records',{keyPath:'id',autoIncrement:true});store.createIndex('kind','kind')};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});dbReady.catch(e=>fail('idb-result',e));
byId('idb-save').onclick=async()=>{try{const db=await dbReady;const tx=db.transaction('records','readwrite');const request=tx.objectStore('records').add({kind:'save',count,draft:byId('draft').value,blob:new Blob(['Atlas blob '+count],{type:'text/plain'}),bytes:new Uint8Array([1,2,3,count%256])});let key;request.onsuccess=()=>key=request.result;tx.oncomplete=()=>{byId('idb-result').textContent='Saved record '+key+' count '+count};tx.onerror=()=>fail('idb-result',tx.error);tx.onabort=()=>fail('idb-result',tx.error||{name:'AbortError'})}catch(e){fail('idb-result',e)}};
byId('idb-read').onclick=async()=>{try{const db=await dbReady;const tx=db.transaction('records','readonly');const request=tx.objectStore('records').openCursor(null,'prev');request.onsuccess=async()=>{const value=request.result?.value;if(!value){byId('idb-result').textContent='No records';return}try{const blob=await value.blob.text();byId('idb-result').textContent='Record '+value.id+' count '+value.count+' blob '+blob+' bytes '+Array.from(value.bytes).join(',')}catch(e){fail('idb-result',e)}};request.onerror=()=>fail('idb-result',request.error)}catch(e){fail('idb-result',e)}};
byId('idb-abort').onclick=async()=>{try{const db=await dbReady;const tx=db.transaction('records','readwrite');tx.objectStore('records').add({kind:'aborted',count:-1});tx.onabort=()=>byId('idb-result').textContent='Record aborted';tx.abort()}catch(e){fail('idb-result',e)}};
byId('cookie-save').onclick=()=>{try{document.cookie='atlas-lab-cookie='+count+'; Path=/; SameSite=Lax';byId('cookie-result').textContent='Cookie saved '+count}catch(e){fail('cookie-result',e)}};byId('cookie-read').onclick=()=>{try{const value=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('atlas-lab-cookie='));byId('cookie-result').textContent=value?'Cookie '+value.split('=')[1]:'No cookie'}catch(e){fail('cookie-result',e)}};
byId('worker').onclick=()=>{try{const worker=new Worker('./worker.js');worker.onmessage=e=>{byId('worker-result').textContent=e.data.result;worker.terminate()};worker.onerror=()=>byId('worker-result').textContent='Worker error';worker.postMessage({count})}catch(e){fail('worker-result',e)}};
byId('module-worker').onclick=()=>{try{const worker=new Worker('./module-worker.js',{type:'module'});worker.onmessage=e=>{byId('module-worker-result').textContent=e.data.result;worker.terminate()};worker.onerror=()=>byId('module-worker-result').textContent='Module worker error';worker.postMessage({count})}catch(e){fail('module-worker-result',e)}};
addEventListener('message',e=>{if(e.data?.fixture==='nested-ready')byId('frame-result').textContent='Nested frame ready';if(e.data?.fixture==='popup-ready')byId('popup-result').textContent='Popup ready'});byId('popup').onclick=()=>{const popup=open('./popup','atlas-lab-popup','width=420,height=320');if(!popup)byId('popup-result').textContent='Popup blocked'};
byId('fetch').onclick=async()=>{try{const response=await fetch('./api');const value=await response.json();byId('fetch-result').textContent=value.result}catch(e){fail('fetch-result',e)}};
byId('media').onclick=async()=>{try{await byId('audio').play();byId('media-result').textContent='Media playing'}catch(e){fail('media-result',e)}};byId('audio').onended=()=>byId('media-result').textContent='Media ended';
</script><script type="module">import {result} from './module.js';document.querySelector('#module-result').textContent=result;</script></html>`;

const controllerCompat = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Normal controller compatibility</title><body>
<h1>Controller compatibility fixture</h1><template id="compat-template"><span id="template-value">Template ready</span></template>
<math id="compat-math"><mi>x</mi><mo>=</mo><mn>1</mn></math>
<iframe title="Srcdoc fixture" srcdoc="<!doctype html><html><body>Srcdoc ready</body></html>"></iframe>
<button id="history-push">Push history</button><button id="history-replace">Replace history</button><output id="history-result">History ready</output>
<script>document.querySelector('#history-push').onclick=()=>{history.pushState({fixture:'push'},'', '?history=push');document.querySelector('#history-result').textContent='History push complete'};document.querySelector('#history-replace').onclick=()=>{history.replaceState({fixture:'replace'},'', '?history=replace');document.querySelector('#history-result').textContent='History replace complete'};</script></body></html>`;

const controllerProfileWorker = `const database=new Promise((resolve,reject)=>{const request=indexedDB.open('atlas-controller-worker-review',1);request.onupgradeneeded=()=>request.result.createObjectStore('proof');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
async function handle(message){const db=await database;if(message.op==='write')await new Promise((resolve,reject)=>{const tx=db.transaction('proof','readwrite');tx.objectStore('proof').put({value:message.value,blob:new Blob(['Worker blob '+message.value],{type:'text/plain'})},'marker');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new DOMException('Write aborted','AbortError'));tx.onerror=()=>reject(tx.error)});else if(message.op!=='read')throw new TypeError('Unknown fixture operation');const record=await new Promise((resolve,reject)=>{const tx=db.transaction('proof','readonly'),request=tx.objectStore('proof').get('marker');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});return{value:record?.value??null,blobText:record?.blob?await record.blob.text():null}}
const listen=port=>{port.onmessage=async event=>{try{port.postMessage(await handle(event.data))}catch(error){port.postMessage({error:{name:error.name,message:error.message}})}};port.start?.()};
if(typeof self.postMessage==='function')listen(self);else self.onconnect=event=>{for(const port of event.ports)listen(port)};`;

export function serveLabFixture(request, response) {
  const url = new URL(request.url, "http://127.0.0.1:4299");
  response.setHeader("Cache-Control", "no-store");
  const send = (type, body) => {
    response.setHeader("Content-Type", type);
    response.end(body);
  };
  if (url.pathname === '/seamless-storage' || url.pathname.startsWith('/seamless-storage/')) return serveSeamlessFixture(request, response);
  switch (url.pathname) {
    case "/controller-compat":
      return send("text/html; charset=utf-8", controllerCompat);
    case "/controller-meta":
      return send("text/html; charset=utf-8", '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/controller-meta-done"><title>Meta refresh fixture</title><body>Meta refresh pending</body></html>');
    case "/controller-meta-done":
      return send("text/html; charset=utf-8", '<!doctype html><html lang="en"><meta charset="utf-8"><title>Meta refresh complete</title><body><h1>Meta refresh complete</h1></body></html>');
    case "/controller-profile-worker.js":
      return send("text/javascript; charset=utf-8", controllerProfileWorker);
    case "/health":
      return send("text/plain; charset=utf-8", "LOCAL_FIXTURE_READY");
    case "/module.js":
      return send(
        "text/javascript; charset=utf-8",
        "export const result='Module ready';",
      );
    case "/worker.js":
      return send(
        "text/javascript; charset=utf-8",
        "onmessage=e=>postMessage({result:'Worker ready '+e.data.count});",
      );
    case "/module-worker.js":
      return send(
        "text/javascript; charset=utf-8",
        "import {result} from './module.js';onmessage=e=>postMessage({result:result+' worker '+e.data.count});",
      );
    case "/api":
      return send(
        "application/json; charset=utf-8",
        JSON.stringify({ result: "Fetch ready" }),
      );
    case "/child":
      return send(
        "text/html; charset=utf-8",
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Nested fixture</title><body>Nested fixture<script>parent.postMessage({fixture:"nested-ready"},"*")</script></body></html>',
      );
    case "/popup":
      return send(
        "text/html; charset=utf-8",
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Popup fixture</title><body><h1>Popup fixture</h1><p>This local popup loaded.</p><script>opener?.postMessage({fixture:"popup-ready"},"*")</script></body></html>',
      );
    case "/tone.wav":
      return send("audio/wav", fixtureWave());
    case "/storage":
      return send(
        "text/html; charset=utf-8",
        html
          .replace(
            '<iframe title="Nested fixture" src="./child"></iframe>',
            "<p>Nested-frame loading is excluded on this storage-only route.</p>",
          )
          .replace("Frame pending", "Frame probe excluded")
          .replace(
            "<h1>Local browsing fixture</h1>",
            "<h1>Local storage fixture</h1>",
          ),
      );
    case "/frames":
    case "/":
      return send("text/html; charset=utf-8", html);
    default:
      response.statusCode = 404;
      return send("text/plain; charset=utf-8", "Fixture not found");
  }
}
