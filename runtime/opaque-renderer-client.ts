/** Private original-document renderer control; no credentials/source/secret are
 * exposed to website scripts or to the public opaque-window message channel. */
export function createOpaqueRendererClient(options:{window:Window&typeof globalThis;documentId:string;frontend:string;live:()=>boolean;send:(message:object)=>void}){
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;readyResolve:(v:any)=>void;readyReject:(e:Error)=>void;timer:number}>();
  const setTimeout=options.window.setTimeout.bind(options.window),clearTimeout=options.window.clearTimeout.bind(options.window);
  let next=0,live=true;
  return {reserve(url:URL,element:HTMLIFrameElement){
    if(!live||!options.live())return Promise.reject(Error('RENDERER_PARENT_STALE'));
    const child=element.contentWindow;let slot=-1;
    for(let i=0;i<options.window.length&&i<8;i++)if(options.window.frames[i]===child){slot=i;break;}
    if(slot<0)return Promise.reject(Error('RENDERER_WINDOW_DENIED'));
    const requestId=++next;
    return new Promise<{helperURL:string;ready:Promise<{resources:number}>;cancel:()=>void}>((resolve,reject)=>{
      let readyResolve!:(v:any)=>void,readyReject!:(e:Error)=>void;
      const ready=new Promise<{resources:number}>((a,b)=>{readyResolve=a;readyReject=b});void ready.catch(()=>{});
      const record={resolve:(v:any)=>resolve({...v,ready,cancel:()=>{const e=Error('RENDERER_CANCELLED');reject(e);readyReject(e);clearTimeout(record.timer);pending.delete(requestId)}}),reject,readyResolve,readyReject,timer:0};
      pending.set(requestId,record);record.timer=setTimeout(()=>{pending.delete(requestId);const error=Error('RENDERER_DOCUMENT_TIMEOUT');reject(error);readyReject(error)},30000);
      options.send({protocol:2,documentId:options.documentId,type:'renderer-reserve',requestId,url:url.href,slot});
    });
  },receive(m:any){if(!live||!options.live()||m.type!=='renderer-result')return false;const record=pending.get(m.requestId);if(!record)return true;
    if(m.phase==='reserved'){
      try{const u=new URL(m.helperURL);if(u.origin!==options.frontend||u.pathname.indexOf('/browse/renderer/v1/'+options.documentId+'/')!==0||u.search||u.hash||u.username||u.password)throw Error();record.resolve({helperURL:u.href})}catch{record.reject(Error('RENDERER_HELPER_ADDRESS_DENIED'));pending.delete(m.requestId);clearTimeout(record.timer)}
    }else if(m.phase==='ready'||m.phase==='error'){pending.delete(m.requestId);clearTimeout(record.timer);if(m.phase==='ready'&&Number.isInteger(m.resources))record.readyResolve({resources:m.resources});else{const e=Error('RENDERER_CONTENT_FAILED');record.reject(e);record.readyReject(e)}}return true;
  },dispose(){if(!live)return;live=false;for(const r of pending.values()){clearTimeout(r.timer);const e=Error('RENDERER_PARENT_STALE');r.reject(e);r.readyReject(e)}pending.clear()}};
}
