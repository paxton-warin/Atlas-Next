/** Diagnostics on this run's own synthetic cookie worker. Counts request types
 * only; never records cookie lines, jars, credentials or message payloads. */
export async function cookieWorkerActivity(browserCDP) {
 const {targetInfos}=await browserCDP.send('Target.getTargets');const target=targetInfos.find(t=>t.type==='worker'&&/\/cookies-[a-f0-9]+\.js/.test(t.url));if(!target)throw Error('Synthetic cookie worker not found');
 const{sessionId}=await browserCDP.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});let next=0;const pending=new Map();
 const listener=e=>{if(e.sessionId!==sessionId)return;const m=JSON.parse(e.message),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)};browserCDP.on('Target.receivedMessageFromTarget',listener);
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('Worker diagnostic deadline')),10000);pending.set(id,{resolve,reject,timer});browserCDP.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject)});
 try{
  const prototype=await call('Runtime.evaluate',{expression:'MessagePort.prototype'}),ports=await call('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId});
  await call('Runtime.callFunctionOn',{objectId:ports.objects.objectId,functionDeclaration:`function(){globalThis.__atlasCookieObservation={counts:{},listeners:[]};for(const port of this){const receive=e=>{const type=e.data?.type;if(type==='get'||type==='set')__atlasCookieObservation.counts[type]=(__atlasCookieObservation.counts[type]||0)+1};port.addEventListener('message',receive);__atlasCookieObservation.listeners.push([port,receive]);}return this.length}`,returnByValue:true});
  await new Promise(r=>setTimeout(r,1500));
  const result=await call('Runtime.evaluate',{expression:`(()=>{const d=__atlasCookieObservation;for(const[p,f]of d.listeners)p.removeEventListener('message',f);delete globalThis.__atlasCookieObservation;return{ports:d.listeners.length,counts:d.counts}})()`,returnByValue:true});return result.result.value;
 }finally{browserCDP.off('Target.receivedMessageFromTarget',listener);await browserCDP.send('Target.detachFromTarget',{sessionId}).catch(()=>{});for(const p of pending.values())clearTimeout(p.timer)}
}
