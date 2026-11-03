/** Numeric native worker heap/backing-store metrics only; no variable values. */
export async function workerMemory(browserCDP) {
  const targets=(await browserCDP.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker'||t.type==='service_worker');
  const results=[];
  for(const target of targets){
    let sessionId,listener;const pending=new Map();let next=0;
    try{
      ({sessionId}=await browserCDP.send('Target.attachToTarget',{targetId:target.targetId,flatten:false}));
      listener=event=>{if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message);const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(Error(message.error.message)):waiter.resolve(message.result)};
      browserCDP.on('Target.receivedMessageFromTarget',listener);
      const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('Worker metrics deadline'))},3000);pending.set(id,{resolve,reject,timer});browserCDP.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject)});
      const heap=await command('Runtime.getHeapUsage');
      results.push({type:target.type,asset:new URL(target.url).pathname.split('/').pop(),...heap});
    }catch(error){results.push({type:target.type,asset:target.url.startsWith('blob:')?'blob-worker':target.url.split('/').pop()?.split('?')[0],error:error.message})}
    finally{if(listener)browserCDP.off('Target.receivedMessageFromTarget',listener);if(sessionId)await browserCDP.send('Target.detachFromTarget',{sessionId}).catch(()=>{});for(const x of pending.values())clearTimeout(x.timer)}
  }
  return results;
}
