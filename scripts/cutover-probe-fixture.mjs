/** Fixed synthetic website and bounded echo, exposed only by an isolated test
 * gateway. This fixture has no Atlas credentials/profile APIs or proxy target. */
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
export const CUTOVER_PROBE_PREFIX = '/atlas-runtime-probe-v1/';
export const CUTOVER_PROBE_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Atlas runtime verification</title><style>body{margin:0;padding:24px;background:#122019;color:#ecf2e9;font:16px system-ui}main{max-width:680px;margin:auto}label,input,button,output{display:block}input,button{box-sizing:border-box;min-height:44px;font:inherit;padding:10px 14px;margin:12px 0;width:100%;border-radius:10px;border:1px solid #87ad70}button{background:#b5dc97;color:#142014}output{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;border:1px solid #476049;border-radius:14px}</style><main><h1>Atlas runtime verification</h1><p>This synthetic website checks ordinary localStorage and a bounded WebSocket echo. It does not access Atlas profile APIs.</p><label for="value">Verification value</label><input id="value" maxlength="4096"><button id="write">Save locally</button><button id="read">Read saved value</button><button id="echo">Run WebSocket echo</button><output id="result">Starting</output></main><script>
const run=new URL(location.href).searchParams.get('run');if(!/^[A-Za-z0-9_-]{16,96}$/.test(run||''))throw Error('A unique verification run is required');
const key='atlas.runtime.probe.v1:'+run,by=id=>document.getElementById(id);let result={run,saved:localStorage.getItem(key),echo:null,error:null};const render=()=>by('result').textContent=JSON.stringify(result,null,2);render();
by('write').onclick=()=>{try{const value=by('value').value;if(new TextEncoder().encode(value).length>4096)throw Error('Value too large');localStorage.setItem(key,value);result={...result,saved:localStorage.getItem(key),error:null};}catch(e){result.error=e.message}render()};
by('read').onclick=()=>{try{result={...result,saved:localStorage.getItem(key),error:null}}catch(e){result.error=e.message}render()};
by('echo').onclick=()=>{const value=by('value').value,url=new URL('${CUTOVER_PROBE_PREFIX}echo',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';let complete=false;result={...result,echo:null,error:null,echoURL:url.href};render();const ws=new WebSocket(url),timeout=setTimeout(()=>{if(!complete){result.error='Echo timed out';render();ws.close()}},15000);ws.onopen=()=>ws.send(value);ws.onmessage=e=>{complete=true;clearTimeout(timeout);result={...result,echo:String(e.data),echoBytes:new TextEncoder().encode(String(e.data)).length,error:null};render();ws.close(1000,'verification complete')};ws.onerror=()=>{result.error='WebSocket failed';render()};ws.onclose=()=>{clearTimeout(timeout);if(!complete&&!result.error){result.error='WebSocket closed before reply';render()}}};
</script></html>`;
export const CUTOVER_PROBE_HTML_SHA256 = createHash('sha256').update(CUTOVER_PROBE_HTML).digest('hex');
export function installCutoverProbeFixture(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  wss.on('connection', ws => { let count = 0; ws.on('message', (data, binary) => { if (++count > 4) return ws.close(1008, 'bounded verification'); ws.send(data, { binary }); }); });
  const http = (req, res) => {
    const u = new URL(req.url, 'https://fixture.invalid');
    if (req.method !== 'GET' || u.pathname !== CUTOVER_PROBE_PREFIX) return false;
    if (!/^[A-Za-z0-9_-]{16,96}$/.test(u.searchParams.get('run') || '') || [...u.searchParams.keys()].some(k => k !== 'run')) { res.writeHead(400).end('Unique verification run required.'); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Atlas-Probe-Content-SHA256': CUTOVER_PROBE_HTML_SHA256 }); res.end(CUTOVER_PROBE_HTML); return true;
  };
  const upgrade = (req, socket, head) => {
    const u = new URL(req.url, 'https://fixture.invalid');
    if (u.pathname !== CUTOVER_PROBE_PREFIX + 'echo' || u.search) return false;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); return true;
  };
  const listener = (req, socket, head) => { if (!upgrade(req, socket, head)) socket.destroy(); };
  if (server) server.on('upgrade', listener);
  return { http, upgrade, async close() { if (server) server.off('upgrade', listener); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); } };
}
