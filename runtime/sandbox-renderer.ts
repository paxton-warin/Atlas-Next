/** Fixed reviewed-renderer authority. All website bytes travel through the
 * already-selected node; Main receives only bounded script hashes. */
import { createRendererHelperBroker } from './renderer-helper-broker.ts';
import { rendererTarget, moduleAllowedByPolicy, type RendererFetch } from './opaque-renderer.ts';
import type { bindSandboxNetwork } from './sandbox-network.ts';
import type { OriginalDocumentPolicy } from './original-document-policy.ts';
type Fetch = Parameters<typeof bindSandboxNetwork>[0]['fetch'];
const fail=(code:string)=>Object.assign(new Error(code),{code});
export function createReviewedRendererFetch(options:{window:Window&typeof globalThis;documentId:string;documentURL:string;policy:OriginalDocumentPolicy;fetch:Fetch;signal:AbortSignal;active:()=>boolean}):RendererFetch {
  let policies:string[]=[], rendererURL='';
  return async (input,credentials='include',kind='document')=>{
    let url=new URL(input), redirects=0, total=0;
    for(;;){
      if(!options.active()||options.signal.aborted)throw fail('RENDERER_PARENT_STALE');
      if(kind==='document') {
        if(!rendererTarget(url.href,options.documentURL))throw fail('RENDERER_DESTINATION_DENIED');
        options.policy.checkURL({url:url.href,kind:'frame',redirectCount:redirects});
      } else {
        if(url.origin!=='https://cdn.platform.openai.com'||!/^\/assets\/dil\/runner-[A-Za-z0-9_-]{8,64}\.js$/.test(url.pathname)||url.username||url.password||url.search||url.hash||!policies.length||policies.some(p=>!moduleAllowedByPolicy(p,url,new URL(rendererURL))))throw fail('RENDERER_MODULE_POLICY_DENIED');
      }
      const response=await options.fetch({url:url.href,method:'GET',headers:[],mode:kind==='module'?'cors':'no-cors',credentials,redirect:'manual',destination:kind==='module'?'script':'iframe',isModule:kind==='module'},Object.freeze({documentId:options.documentId,documentURL:options.documentURL,origin:new URL(options.documentURL).origin,signal:options.signal,preflight:false,requestOrigin:kind==='module'?'null':new URL(options.documentURL).origin,responseTaint:kind==='module'?'cors':'basic',redirectCount:redirects,referrerURL:kind==='module'?rendererURL:options.documentURL}));
      if(!options.active()||options.signal.aborted)throw fail('RENDERER_PARENT_STALE');
      if(!response||response.url!==url.href||response.redirected||!(response.body instanceof ArrayBuffer)||!Array.isArray(response.headers)||response.headers.length>128||(total+=response.body.byteLength)>(kind==='document'?256000:1024000))throw fail('RENDERER_RESPONSE_INVALID');
      let bytes=0;
      for(const pair of response.headers)if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string'||/[\0\r\n]/.test(v))||! /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0])||/^set-cookie2?$/i.test(pair[0])||(bytes+=pair[0].length+pair[1].length)>65536)throw fail('RENDERER_HEADERS_INVALID');
      const values=(name:string)=>response.headers.filter(([k])=>k.toLowerCase()===name).map(([,v])=>v);
      if(kind==='module') {
        const origins=values('access-control-allow-origin'), allowCredentials=values('access-control-allow-credentials');
        if(origins.length!==1||!(origins[0]==='null'||credentials==='omit'&&origins[0]==='*')||credentials==='include'&&(allowCredentials.length!==1||allowCredentials[0]!=='true'))throw fail('RENDERER_MODULE_CORS_DENIED');
      }
      const locations=values('location');
      if([301,302,303,307,308].includes(response.status)&&locations.length){if(++redirects>10||locations.length!==1)throw fail('RENDERER_REDIRECT_DENIED');url=new URL(locations[0],url);continue;}
      const types=values('content-type'),type=types[0]?.split(';')[0].trim().toLowerCase();
      if(types.length!==1||response.status!==200||!type||!/^(?:text\/html|(?:text|application)\/(?:java|ecma)script)$/.test(type))throw fail('RENDERER_MIME_DENIED');
      if(/;\s*charset\s*=/i.test(types[0])&&!/;\s*charset\s*=\s*"?(?:utf-?8|us-ascii)"?(?:;|$)/i.test(types[0]))throw fail('RENDERER_ENCODING_DENIED');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(response.body), responsePolicies=values('content-security-policy').flatMap(p=>p.split(',').map(v=>v.trim()).filter(Boolean));
      if(responsePolicies.length>32)throw fail('RENDERER_POLICY_LIMIT');
      if(kind==='document'){
        if(values('x-frame-options').length||responsePolicies.some(p=>/(?:^|;)\s*(?:sandbox|frame-ancestors|require-trusted-types-for|navigate-to)\b/i.test(p)))throw fail('RENDERER_RESPONSE_POLICY_UNSUPPORTED');
        rendererURL=url.href;
        const tree=new options.window.DOMParser().parseFromString(text,'text/html');
        policies=[...responsePolicies,...Array.from(tree.querySelectorAll('meta[http-equiv]')).filter(e=>e.getAttribute('http-equiv')?.toLowerCase()==='content-security-policy').map(e=>e.getAttribute('content')??'')];
      }
      return {status:response.status,type,text,policies:responsePolicies,allowOrigin:values('access-control-allow-origin').length===1?values('access-control-allow-origin')[0]:undefined,allowCredentials:values('access-control-allow-credentials').length===1?values('access-control-allow-credentials')[0]:undefined};
    }
  };
}
export function createSandboxRenderer(options:{window:Window&typeof globalThis;parentWindow:Window;documentId:string;website:string;policy:OriginalDocumentPolicy;active:()=>boolean;fetch:Fetch;reserveHelper:(input:{parentDocumentId:string;scriptHashes:readonly string[]})=>Promise<{helperURL:string;childId:string;secret:string}>;post:(message:object)=>void}){
  const abort=new AbortController();
  const broker=createRendererHelperBroker({window:options.window,parentWindow:options.parentWindow,parentDocumentId:options.documentId,website:options.website,activeParent:options.active,authorizeFrame:url=>options.policy.checkURL({url,kind:'frame'}),reserveHelper:scriptHashes=>options.reserveHelper({parentDocumentId:options.documentId,scriptHashes}),fetchResource:async()=>{throw fail("RENDERER_RESERVATION_CONTEXT_REQUIRED")},fetchResourceFactory:()=>createReviewedRendererFetch({window:options.window,documentId:options.documentId,documentURL:options.website,policy:options.policy,fetch:options.fetch,signal:abort.signal,active:options.active})});
  let live=true,next=0;
  const reservations=new Map<number,()=>void>();
  const send=(requestId:number,value:object)=>{if(live&&options.active())options.post({protocol:2,documentId:options.documentId,type:'renderer-result',requestId,...value})};
  return {receive(m:any,ports:number){
    if(!live||m.type!=='renderer-reserve')return false;
    if(ports||Object.keys(m).some(k=>!['protocol','documentId','type','requestId','url','slot'].includes(k))||m.requestId!==next+1||typeof m.url!=='string'||m.url.length>4096||!Number.isInteger(m.slot))return true;
    const requestId=++next;
    void broker.reserve({url:m.url,slot:m.slot}).then(reservation=>{
      if(!live||!options.active()){reservation.cancel();return;}
      reservations.set(requestId,reservation.cancel);
      send(requestId,{phase:'reserved',helperURL:reservation.helperURL});
      void reservation.ready.then(result=>send(requestId,{phase:'ready',resources:result.resources}),()=>send(requestId,{phase:'error'})).finally(()=>reservations.delete(requestId));
    },()=>send(requestId,{phase:'error'}));
    return true;
  },dispose(){if(!live)return;live=false;abort.abort();broker.dispose();for(const cancel of reservations.values())cancel();reservations.clear();}};
}
