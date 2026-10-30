import { createHash } from 'node:crypto';
import { createAtlasRequestCancellation } from './runtime-request-cancellation-source.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const REQUEST_CORE_INPUTS = new Set([
  '9c5798c30098d753d85dbdcf8286452ac0184aac774831b89de99eeea509ff37',
  '8af727441170c86385c71fa1ee08640dbe9012482f32b62301fc16f97f9b3bf5',
  '243fb4ee3beff746f9dd571297c9dcad6fc2a006f81880f322a28e5209b72d4f',
]);
export const REQUEST_ARTIFACT_INPUTS = {
  'controller.api.js': '0f9284e538ed2ecd595e00f5c083e77c679a46efd4f67c9cbc5190c2f03e8944',
  'controller.worker.js': '881907449549d2f4bda9e59d05e447ef01da9a1c790b7792800fb32074fac1dd',
  'controller.inject.js': '0d156e6e749202f6887f046ed28b452f78db63b9246356370a20a3e415905fb2',
};
export const REQUEST_CANCELLATION_OUTPUTS = {
  "controller.api.js": "1fa574b6a18fc4bfbcd2c3ddaf64990801a63f033c775e8d0589e4c20377cb7d",
  "controller.worker.js": "dc67cf04f3d956e86d8b72540a1a2e703d8c931a89533e013e9dd58111a5bbab",
  "controller.inject.js": "d3c7f68da59acbc7d806e1a6602dc42983faf836d8f55568919749638acb4d99"
};
export const REQUEST_CORE_OUTPUTS = {
  "9c5798c30098d753d85dbdcf8286452ac0184aac774831b89de99eeea509ff37": "cf2f5e3465b27f2a11872a497c9395656480a434f1ffc4c3f8696a8b22d4ba49",
  "8af727441170c86385c71fa1ee08640dbe9012482f32b62301fc16f97f9b3bf5": "ceb12d65e394bfbe8000dc9e2afb035526217af055bc1fbc3a7e89c7f2057784",
  "243fb4ee3beff746f9dd571297c9dcad6fc2a006f81880f322a28e5209b72d4f": "e777b2866bb822ae7eadbc890d4a2c56ed6231f67444c855141de3187a841095"
};
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Request cancellation build seam changed');
  return source.replace(before, after);
}
export function adaptRequestCancellationCore(bytes) {
  const input = sha(bytes);
  if (!REQUEST_CORE_INPUTS.has(input)) throw new Error('Request cancellation requires qualified core');
  let source = bytes.toString();
  const before = 'e.Proxy("fetch",{apply(t){if(e.box.instanceof(t.args[0],"Request")){let r=t.args[1];if(null==r)return;try{let i=e.natives.construct("Request",t.args[0],r);t.args[0]=e.natives.construct("Request",e.transformUrl(i.url,o(i)),i),t.args[1]=void 0}catch(e){t.return((0,n.Og)(e))}return}let r=(0,n.Qf)(t.args[0]);t.args[0]=e.transformUrl(r,o(t.args[1]))}})';
  const after = 'e.Proxy("fetch",{apply(t){if(e.box.instanceof(t.args[0],"Request")){let r=t.args[1];if(null==r){e.init.atlasCancelFetch?.(t);return}try{let i=e.natives.construct("Request",t.args[0],r);t.args[0]=e.natives.construct("Request",e.transformUrl(i.url,o(i)),i),t.args[1]=void 0;e.init.atlasCancelFetch?.(t)}catch(e){t.return((0,n.Og)(e))}return}let r=(0,n.Qf)(t.args[0]);t.args[0]=e.transformUrl(r,o(t.args[1]));e.init.atlasCancelFetch?.(t)}})';
  source = replaceOnce(source, before, after);
  source = replaceOnce(source, 'body:t.body,headers:n.toRawHeaders(),method:t.method,redirect:"manual"', 'body:t.body,headers:n.toRawHeaders(),method:t.method,redirect:"manual",signal:t.signal');
  source = replaceOnce(source, 's=t?.redirect||"follow",c=new URL(e);', 's=t?.redirect||"follow",atlasSignal=t?.signal,c=new URL(e);');
  source = replaceOnce(source, 'this.transport.request(c,o,i,n,void 0)', 'this.transport.request(c,o,i,n,atlasSignal)');
  source = replaceOnce(source, 'y=await g(e,t,h,w);await f(e,t,h,y.rawHeaders)', 'y=await g(e,t,h,w);if(y.body&&(0,a.N6)(y))await y.body.cancel().catch(()=>{});await f(e,t,h,y.rawHeaders)');
  source = replaceOnce(source, 'if(r>e&&null!==t){c=new URL(t,c);continue}throw TypeError("Failed to fetch")}case"error":throw TypeError("Failed to fetch");case"manual":return A', 'if(A.body)await A.body.cancel().catch(()=>{});if(r>e&&null!==t){c=new URL(t,c);continue}throw TypeError("Failed to fetch")}case"error":if(A.body)await A.body.cancel().catch(()=>{});throw TypeError("Failed to fetch");case"manual":return A');
  const output=Buffer.from(source);
  if(sha(output)!==REQUEST_CORE_OUTPUTS[input])throw new Error("Request cancellation core output hash mismatch");
  return output;
}
export function adaptRequestCancellationArtifact(kind, bytes) {
  if (!REQUEST_ARTIFACT_INPUTS[kind] || sha(bytes) !== REQUEST_ARTIFACT_INPUTS[kind])
    throw new Error('Request cancellation requires qualified controller artifact');
  let source = bytes.toString();
  source = replaceOnce(source, 'var $runtimekitController;(()=>{', 'var $runtimekitController;(()=>{const atlasCancellation=(' + createAtlasRequestCancellation.toString() + ')();');
  source = kind === 'controller.inject.js'
    ? replaceOnce(source, 'let e=t.$method,o=t.$args;this.methods[e](o).then(', 'let e=t.$method,o=t.$args,atlasRpcId=this.id;this.methods[e](o).then(')
    : replaceOnce(source, 'let e=t.$method,r=t.$args;this.methods[e](r).then(', 'let e=t.$method,r=t.$args,atlasRpcId=this.id;this.methods[e](r).then(');
  if(source.split('[this.id]:{$type:"response"').length!==3)throw new Error('Request RPC response namespace seam changed');
  source=source.replaceAll('[this.id]:{$type:"response"','[atlasRpcId]:{$type:"response"');
  source = replaceOnce(source, '.catch(e=>{console.error(e),this.sendRaw', '.catch(e=>{if(e?.name!=="AbortError")console.error(e);this.sendRaw');
  if (kind === 'controller.api.js') {
    source = replaceOnce(source, 'this.guardServiceWorkerRevive=!1},5e3)},request:async e=>{', 'this.guardServiceWorkerRevive=!1},5e3);return[{atlasCancellation:1}]},request:async e=>{');
    source = replaceOnce(source, 'if(!r)throw Error("No frame found for request");try{', 'if(!r)throw Error("No frame found for request");return atlasCancellation.controllerRequest(this,e,r,async()=>{try{');
    source = replaceOnce(source, 'clientId:e.clientId});return[{body:i.body', 'clientId:e.clientId,signal:e.atlasSignal});return[{body:i.body');
    source = replaceOnce(source, 'catch(o){let t={setResponse:void 0,suppressError:!1};', 'catch(o){if(e.atlasSignal?.aborted)throw o;let t={setResponse:void 0,suppressError:!1};');
    source = replaceOnce(source, 'throw o}},initRemoteTransport:async', 'throw o}})},initRemoteTransport:async');
    source = replaceOnce(source, 'setupMessagePort(){if(this.port)', 'abortFrameRequests(prefix){atlasCancellation.abortRequests(this,prefix)}disposeRequestChannel(){atlasCancellation.abortRequests(this);atlasCancellation.resetRPC(this.rpc);this.serviceWorkerController.postMessage({$controller$dispose:{id:this.id,generation:this.atlasChannelGeneration}});this.port?.close()}get requestCancellationStats(){return{active:atlasCancellation.controllerCount(this)}}setupMessagePort(){atlasCancellation.abortRequests(this);atlasCancellation.resetRPC(this.rpc);this.atlasChannelGeneration=atlasCancellation.channelGeneration();this.rpc.id="tabchannel-"+this.id+"-"+this.atlasChannelGeneration;if(this.port)');
    source = replaceOnce(source, '$controller$init:{prefix:this.prefix,id:this.id}', '$controller$init:{prefix:this.prefix,id:this.id,generation:this.atlasChannelGeneration}');
  } else if (kind === 'controller.worker.js') {
    source = replaceOnce(source, 'this.rpc.call("ready",void 0)}}let i=[];', 'this.atlasReady=this.rpc.call("ready",void 0).then(value=>{if(value?.atlasCancellation!==1)throw new TypeError("Request cancellation protocol mismatch")});this.atlasReady.catch(()=>{})}}let i=[];addEventListener("message",event=>{void atlasCancellation.register(event,i).catch(()=>{});atlasCancellation.disposeReference(event,i)});');
    source = replaceOnce(source, 'constructor(r,o,s){this.prefix=r,this.id=o,this.rpc=', 'constructor(r,o,s,atlasGeneration,atlasSourceClient){this.atlasPort=s;this.atlasGeneration=atlasGeneration;this.atlasSourceClient=atlasSourceClient;this.prefix=r,this.id=o,this.rpc=');
    source = replaceOnce(source, '"tabchannel-"+o,(e,t)=>{s.postMessage(e,t)}', '"tabchannel-"+o+"-"+atlasGeneration,(e,t)=>{s.postMessage(e,t)}');
    source = replaceOnce(source, 'let t=e.data.$controller$init,r=i.findIndex', 'if(!atlasCancellation.acceptControllerInit(e,i))return;let t=e.data.$controller$init,r=i.findIndex');
    source = replaceOnce(source, 'i.push(new s(t.prefix,t.id,e.ports[0]))', 'i.push(new s(t.prefix,t.id,e.ports[0],t.generation,e.source.id))');
    const start = source.indexOf('async function a(e){');
    const end = source.indexOf('addEventListener("message",e=>{if(!e.data||', start);
    if (start < 0 || end < 0) throw new Error('Request SW routing seam changed');
    source = source.slice(0,start) + `async function a(event){try{const url=new URL(event.request.url),tab=i.find(tab=>url.pathname.startsWith(tab.prefix));if(!tab)return Response.error();const client=await clients.get(event.clientId);return await atlasCancellation.route(event,tab,client)}catch(error){if(error?.name==='AbortError')return Response.error();console.error('Service Worker error:',error);return new Response('Internal Service Worker Error: '+error.message,{status:500})}}` + source.slice(end);
    source = replaceOnce(source, '-1!==r&&i.splice(r,1),i.push(new s(', '-1!==r&&(atlasCancellation.cleanupReference(i[r]),i.splice(r,1)),i.push(new s(');
  } else if (kind === 'controller.inject.js') {
    source = replaceOnce(source, 'this.client=new i.km(this.global,', 'const atlasForClient=atlasCancellation.fork(this.global);this.client=new i.km(this.global,');
    source = replaceOnce(source, 'initHeaders:this.init.initHeaders,history:this.init.history});', 'initHeaders:this.init.initHeaders,history:this.init.history,atlasCancelFetch:ctx=>atlasForClient.clientFetch(ctx,this.init.prefix.href)});');
  }
  const output = Buffer.from(source), expected = REQUEST_CANCELLATION_OUTPUTS[kind];
  if (sha(output) !== expected) throw new Error('Request cancellation output hash mismatch');
  return output;
}
