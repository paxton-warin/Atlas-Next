import test from 'node:test';
import assert from 'node:assert/strict';
import {createScramjetProfilePlugin, neutralizeScramjetCookies, getScramjetProfileBridge, scramjetProfileLoadReady, SCRAMJET_PROFILE_REGISTRY, PROFILE_DOCUMENT_HEADER} from '../runtime/scramjet-profile.ts';
import {createSandboxDocumentCookie} from '../runtime/sandbox-document-cookie.ts';
import {sealCookieResult, COOKIE_RESULT_PROTOCOL} from '../runtime/sandbox-cookie-result.ts';

const url='https://website.test/start';
const tick=()=>new Promise(r=>setImmediate(r));
test('normal host ignores the initial aboutblank load and publishes HTML ready only after synchronous profile installation',()=>{
 assert.equal(scramjetProfileLoadReady('about:blank','text/html',false),false);
 assert.equal(scramjetProfileLoadReady('about:blank#initial','text/html',true),false);
 assert.equal(scramjetProfileLoadReady('https://frontend.test/service/frame/website','text/html',false),false);
 assert.equal(scramjetProfileLoadReady('https://frontend.test/service/frame/website','text/html',true),true);
 assert.equal(scramjetProfileLoadReady('https://frontend.test/service/frame/image','image/png',false),true);
});
function fixture(extra={}){
 const calls=[],prepared=[];
 class ManagedPlugin{constructor(name){this.name=name;}install(frame){this.frame=frame;}tap(hook,callback){hook.push(callback);}}
 const globals={$runtimekitController:{ManagedPlugin}},host={crypto:globalThis.crypto};
 const hooks={intercept:[],request:[],preresponse:[],response:[]};const frame={fetchHandler:{hooks:{fetch:hooks}},hooks:{init:{pre:[],post:[]}}};
 const bridge={profileId:'11111111-1111-4111-8111-111111111111',profileContextId:'context',browserSessionId:'browser',frameId:'outer-frame',topLevelURL:()=>url,
 async prepareOrigin(value,options){calls.push(['origin',value,options]);},async getRequestHeader(context){calls.push(['cookie-header',context]);return context.credentials==='omit'?'':'profile=correct';},
 async storeResponseCookies(lines,context){calls.push(['set-cookie',lines,context]);},
 async prepareDocument(input){calls.push(['prepare-document',input]);await tick();const value={...input,profileId:bridge.profileId,install(win,client){calls.push(['install',win.document,client]);win.localStorage={getItem:()=> 'hydrated'};},dispose(){calls.push(['dispose',input.documentId]);}};prepared.push(value);return value;},...extra};
 const errors=[];const plugin=createScramjetProfilePlugin(globals,bridge,{host,frameId:'tab',onError:e=>errors.push(e)});plugin.install(frame);
 const context={request:{method:'GET',initialHeaders:new Headers()},parsed:{url:new URL(url),destination:'iframe',isIframe:false,clientUrl:new URL(url),fetchCredentials:'include'}};
 const response=status=>({response:{status,rawHeaders:[['content-type','text/html'],['set-cookie','fresh=1; HttpOnly'],[PROFILE_DOCUMENT_HEADER,'upstream-forgery']],headers:new Headers({'content-type':'text/html'})}});
 const dispatch=async(hook,context,props={})=>Promise.all(hook.map(fn=>fn(context,props)));
 const document=()=>{const events=new Map();const win={document:{},addEventListener(type,fn){events.set(type,fn);},removeEventListener(type){events.delete(type);}};win.parent=win;return{win,events};};
 return{calls,prepared,bridge,plugin,hooks,frame,context,response,dispatch,document,errors};
}
test('normal engine awaits profile preparation before response delivery, installs synchronously before first script and retains document identity',async()=>{
 const f=fixture();await f.dispatch(f.hooks.intercept,f.context);const request={init:{headers:[['Cookie','legacy=wrong'],['Accept','text/html']]}};
 for(const fn of f.hooks.request)assert.equal(fn(f.context,request),undefined);
 assert.deepEqual(request.init.headers,[['Accept','text/html'],['Cookie','profile=correct']]);
 const response=f.response(200);await f.dispatch(f.hooks.preresponse,f.context,response);assert.equal(f.prepared.length,1);
 assert.equal(response.response.rawHeaders.some(([name])=>name.toLowerCase()==='set-cookie'),false);
 const token=response.response.rawHeaders.find(([name])=>name===PROFILE_DOCUMENT_HEADER)[1];assert.equal(token,f.prepared[0].documentId);assert.match(token,/^doc_[a-f0-9]{32}$/);
 assert.deepEqual(f.calls.map(c=>c[0]),['origin','cookie-header','set-cookie','prepare-document']);
 const{win,events}=f.document();const client={url:new URL(url),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:token})};
 for(const fn of f.frame.hooks.init.pre)assert.equal(fn({window:win,client}),undefined);
 for(const fn of f.frame.hooks.init.post)assert.equal(fn({window:win,client}),undefined);
 assert.equal(win.localStorage.getItem('first-script'),'hydrated');assert.equal(f.calls.at(-1)[0],'install');
 assert.equal(f.calls.filter(c=>c[0]==='dispose').length,0);events.get('pagehide')({persisted:false});assert.equal(f.calls.at(-1)[0],'dispose');f.plugin.dispose();
});
test('normal nonredirect HTML error documents still receive prepared profile views; redirects do not',async()=>{
 for(const status of[200,404,429,503,302]){
  const f=fixture();await f.dispatch(f.hooks.intercept,f.context);await f.dispatch(f.hooks.preresponse,f.context,f.response(status));assert.equal(f.prepared.length,status===302?0:1);f.plugin.dispose();
 }
});
test('the awaited intercept finishes cookie selection before concurrent request/cache callbacks run',async()=>{
 let release;const wait=new Promise(r=>release=r);const f=fixture({getRequestHeader:async()=>{await wait;return'profile=late';}});
 const preparing=f.dispatch(f.hooks.intercept,f.context);await tick();let dispatched=false;
 const workflow=preparing.then(()=>{const props={init:{headers:[]}};f.hooks.request.forEach(fn=>fn(f.context,props));dispatched=true;assert.deepEqual(props.init.headers,[['Cookie','profile=late']]);});
 await tick();assert.equal(dispatched,false);release();await workflow;f.plugin.dispose();
});
test('inherited about:blank/srcdoc contexts use an already hydrated parent without async initialization or origin rejection',async()=>{
 const f=fixture();await f.dispatch(f.hooks.intercept,f.context);const response=f.response(200);await f.dispatch(f.hooks.preresponse,f.context,response);const token=f.prepared[0].documentId;
 const parent=f.document(),client={url:new URL(url),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:token})};
 f.frame.hooks.init.pre.forEach(fn=>fn({window:parent.win,client}));f.frame.hooks.init.post.forEach(fn=>fn({window:parent.win,client}));
 for(const inheritedURL of['about:blank','about:srcdoc']){
  const child=f.document();child.win.parent=parent.win;const childClient={url:new URL(inheritedURL),initHeaders:new Headers()};
  f.frame.hooks.init.pre.forEach(fn=>assert.equal(fn({window:child.win,client:childClient}),undefined));f.frame.hooks.init.post.forEach(fn=>assert.equal(fn({window:child.win,client:childClient}),undefined));
  assert.equal(child.win.localStorage.getItem('saved'),'hydrated');child.events.get('pagehide')({persisted:false});assert.equal(f.calls.filter(c=>c[0]==='dispose').length,0);
 }
 parent.events.get('pagehide')({persisted:false});assert.equal(f.calls.filter(c=>c[0]==='dispose').length,1);f.plugin.dispose();
});
test('profile requests preserve explicit omit credentials and commit failure stops response delivery',async()=>{
 const f=fixture({storeResponseCookies:async()=>{throw Error('profile commit failed');}});f.context.parsed.fetchCredentials='omit';await f.dispatch(f.hooks.intercept,f.context);const p={init:{headers:[['Cookie','legacy=bad']]}};f.hooks.request.forEach(fn=>fn(f.context,p));assert.deepEqual(p.init.headers,[]);
 await assert.rejects(f.dispatch(f.hooks.preresponse,f.context,f.response(200)),/profile commit failed/);assert.equal(f.prepared.length,0);assert.equal(f.errors.length,1);f.plugin.dispose();
});
test('profile mode neutralizes only the current host controller persistent cookie authority before construction',async()=>{
 let reads=0,writes=0;class Controller{loadSavedCookies(){reads++;}persistCookies(){writes++;}propagateCookieSync(){writes++;}applyCookieSyncEntries(){writes++;}}class CookieJar{load(){reads++;}setCookies(){writes++;}getCookies(){return'legacy=wrong';}dump(){return'{"legacy":true}';}}
 neutralizeScramjetCookies({$runtimekitController:{Controller},$runtimekit:{CookieJar}});const controller=new Controller(),jar=new CookieJar();await controller.loadSavedCookies();await controller.persistCookies();await controller.propagateCookieSync();controller.applyCookieSyncEntries();jar.load('{}');jar.setCookies('wrong=1');assert.equal(jar.getCookies(),'');assert.equal(jar.dump(),'{}');assert.equal(reads,0);assert.equal(writes,0);
});
test('normal profile bridge resolves the actual host WindowProxy from the parent registry',()=>{
 const host={parent:{},opener:null},bridge={profileId:'fixture'};host.parent[SCRAMJET_PROFILE_REGISTRY]={get:value=>value===host?bridge:undefined};assert.equal(getScramjetProfileBridge(host),bridge);assert.equal(getScramjetProfileBridge({parent:{},opener:null}),undefined);
});

test('prepared cookie transport installs only into the child and tracks its live logical path',async()=>{
 const key=new Uint8Array(32).fill(7),documentId='prepared_cookie_unit_document',channel=new MessageChannel(),messages=[];
 let operation='get',sequence=0,currentURL='https://website.test/start';
 class ACKXHR{open(){}setRequestHeader(){}send(body){sequence=JSON.parse(body).sequence;}get status(){return 200;}get responseText(){return JSON.stringify({ok:true,packet:sealCookieResult(key,{documentId,sequence,operation,view:'profile=committed',viewVersion:sequence,expiresAt:null})});}}
 class HostDocument{get cookie(){return'frontend=untouched';}}
 class ChildDocument{get cookie(){return'native=unused';}}
 const owner={location:{origin:'https://frontend.test',href:'https://frontend.test/'},MessageEvent,MessagePort,EventTarget,Uint8Array,XMLHttpRequest:ACKXHR,Document:HostDocument,document:new HostDocument(),setTimeout,clearTimeout};
 const child={Document:ChildDocument,document:new ChildDocument(),cookieStore:{native:true}};
 channel.port1.onmessage=event=>messages.push(event.data);
 const ready=createSandboxDocumentCookie({documentId,endpoint:'https://frontend.test/browse/cookies/result/'+'b'.repeat(43),port:channel.port2,window:owner});
 channel.port1.postMessage({protocol:COOKIE_RESULT_PROTOCOL,type:'ready',documentId,documentURL:currentURL,key});
 const cookies=await ready;
 try{
  cookies.install(child,()=>currentURL);assert.equal(child.document.cookie,'profile=committed');assert.equal(owner.document.cookie,'frontend=untouched');assert.equal('cookieStore'in child,false);
  currentURL='https://website.test/account/settings';assert.equal(child.document.cookie,'profile=committed');
  operation='set';child.document.cookie='saved=next';
  for(let i=0;i<100&&messages.filter(m=>m.type==='get'||m.type==='set').length<3;i++)await new Promise(r=>setTimeout(r,1));
  assert.deepEqual(messages.filter(m=>m.type==='get'||m.type==='set').map(m=>m.url),['https://website.test/start','https://website.test/account/settings','https://website.test/account/settings']);
  assert.throws(()=>Object.getOwnPropertyDescriptor(ChildDocument.prototype,'cookie').get.call(new ChildDocument()),TypeError);
 }finally{cookies.dispose();channel.port1.close();}
});

test('managed blank popup inherits the opener token across normal controller frames until its final view closes',async()=>{
 const root=fixture(),popup=fixture();
 await root.dispatch(root.hooks.intercept,root.context);await root.dispatch(root.hooks.preresponse,root.context,root.response(200));
 const token=root.prepared[0].documentId,parent=root.document(),client={url:new URL(url),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:token})};
 root.frame.hooks.init.pre.forEach(fn=>fn({window:parent.win,client}));root.frame.hooks.init.post.forEach(fn=>fn({window:parent.win,client}));
 const blank=popup.document(),childClient={url:new URL('about:blank'),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:token})};
 popup.frame.hooks.init.pre.forEach(fn=>fn({window:blank.win,client:childClient}));popup.frame.hooks.init.post.forEach(fn=>fn({window:blank.win,client:childClient}));
 assert.equal(blank.win.localStorage.getItem('saved'),'hydrated');root.plugin.dispose();assert.equal(root.calls.filter(c=>c[0]==='dispose').length,0);
 popup.plugin.dispose();assert.equal(root.calls.filter(c=>c[0]==='dispose').length,1);
});

test('initial normal document requests never use aboutblank as a logical cookie document URL',async()=>{
 const f=fixture();f.context.parsed.clientUrl=new URL('about:blank');f.context.parsed.referrerSourceUrl=new URL('about:blank');
 await f.dispatch(f.hooks.intercept,f.context);const context=f.calls.find(([name])=>name==='cookie-header')[1];assert.equal(context.documentURL,url);f.plugin.dispose();
});

test('normal trusted host asset requests use the website cookie context, not frontend account origin',async()=>{
 const f=fixture();f.context.parsed.clientUrl=new URL('https://frontend.test/browse/runtime/');f.context.parsed.referrerSourceUrl=new URL('https://frontend.test/~/some-frame');
 // Unit fixture supplies only fields used by the hook; the normal host has its real Location.
 const globals={$runtimekitController:{ManagedPlugin:class{install(){}tap(hook,fn){hook.push(fn);}}}};
 const hooks={intercept:[],request:[],preresponse:[],response:[]},frame={fetchHandler:{hooks:{fetch:hooks}},hooks:{init:{pre:[],post:[]}}};
 const plugin=createScramjetProfilePlugin(globals,f.bridge,{host:{crypto:globalThis.crypto,location:{origin:'https://frontend.test'}},frameId:'root'});plugin.install(frame);
 await Promise.all(hooks.intercept.map(fn=>fn(f.context,{})));
 assert.equal(f.calls.find(([name])=>name==='cookie-header')[1].documentURL,url);plugin.dispose();f.plugin.dispose();
});

test('a failed ordinary subresource remains a failed request, not a whole-page policy denial',async()=>{
 const f=fixture({getRequestHeader:async()=>{throw Error('cookie owner temporarily unavailable');}});f.context.parsed.destination='image';
 await assert.rejects(f.dispatch(f.hooks.intercept,f.context),/cookie owner temporarily unavailable/);assert.equal(f.errors.length,0);f.plugin.dispose();
});

test('blank popup cookie context normalizes document, top-level and site-for-cookies before its first HTTP navigation',async()=>{
 const f=fixture({topLevelURL:()=> 'about:blank'});f.context.parsed.clientUrl=new URL('about:blank');f.context.parsed.referrerSourceUrl=new URL('about:blank');
 await f.dispatch(f.hooks.intercept,f.context);const context=f.calls.find(([name])=>name==='cookie-header')[1];
 assert.equal(context.documentURL,url);assert.equal(context.topLevelURL,url);assert.equal(context.siteForCookiesURL,url);f.plugin.dispose();
});

test('a failed nested document initialization cannot cover an already healthy primary website with a whole-page error',async()=>{
 const f=fixture();await f.dispatch(f.hooks.intercept,f.context);await f.dispatch(f.hooks.preresponse,f.context,f.response(200));
 const parent=f.document(),token=f.prepared[0].documentId,main={url:new URL(url),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:token})};
 f.frame.hooks.init.pre.forEach(fn=>fn({window:parent.win,client:main}));f.frame.hooks.init.post.forEach(fn=>fn({window:parent.win,client:main}));
 const child=f.document();child.win.parent=parent.win;
 const mismatch={url:new URL('https://third-party.test/ad'),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:token})};
 assert.throws(()=>f.frame.hooks.init.pre.forEach(fn=>fn({window:child.win,client:mismatch})),/origin changed/);
 assert.equal(f.errors.length,0,'nested initialization remains rejected without marking the healthy primary document failed');
 const missing={url:new URL('https://third-party.test/ad'),initHeaders:new Headers()};
 assert.throws(()=>f.frame.hooks.init.pre.forEach(fn=>fn({window:child.win,client:missing})),/not hydrated/);
 assert.equal(f.errors.length,0);assert.equal(parent.win.localStorage.getItem('save'),'hydrated');f.plugin.dispose();
});
test('primary document initialization failures still fail the visible primary website',async()=>{
 const f=fixture();await f.dispatch(f.hooks.intercept,f.context);await f.dispatch(f.hooks.preresponse,f.context,f.response(200));
 const primary=f.document(),client={url:new URL('https://different.test/'),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:f.prepared[0].documentId})};
 assert.throws(()=>f.frame.hooks.init.pre.forEach(fn=>fn({window:primary.win,client})),/origin changed/);
 assert.equal(f.errors.length,1);f.plugin.dispose();
});


test('embedded document hydration keeps writer checks but cannot offer the main page a background-site takeover',async()=>{
 const f=fixture();f.context.parsed.isIframe=true;f.context.parsed.url=new URL('https://ads.example/frame');
 await f.dispatch(f.hooks.intercept,f.context);
 assert.deepEqual(f.calls.find(c=>c[0]==='origin')[2],{interactive:false});
 await f.dispatch(f.hooks.preresponse,f.context,f.response(200));
 assert.equal(f.calls.find(c=>c[0]==='prepare-document')[1].interactive,false);f.plugin.dispose();
});
test('foreground document hydration retains the normal interactive ownership decision',async()=>{
 const f=fixture();await f.dispatch(f.hooks.intercept,f.context);
 assert.deepEqual(f.calls.find(c=>c[0]==='origin')[2],{interactive:true});
 await f.dispatch(f.hooks.preresponse,f.context,f.response(200));
 assert.equal(f.calls.find(c=>c[0]==='prepare-document')[1].interactive,true);f.plugin.dispose();
});

test('a nested frame navigation retaining parent-frame metadata stays background even without the iframe flag',async()=>{
 const f=fixture({prepareOrigin:async(value,options)=>{f.calls.push(['origin',value,options]);throw Error('Select Continue here to open this website.')}});
 f.context.parsed.isIframe=false;f.context.parsed.meta={parentFrameName:'view-main',topFrameName:'view-main'};f.context.parsed.url=new URL('https://ads.example/redirect');
 await assert.rejects(f.dispatch(f.hooks.intercept,f.context),/Continue here/);
 assert.deepEqual(f.calls.find(c=>c[0]==='origin')[2],{interactive:false});
 assert.equal(f.errors.length,0,'the nested request fails locally rather than hiding the game');f.plugin.dispose();
});

test('rewritten nested parent getters cannot turn a child failure into the controller-owned primary frame failure',async()=>{
 const f=fixture();await f.dispatch(f.hooks.intercept,f.context);await f.dispatch(f.hooks.preresponse,f.context,f.response(200));
 const primary=f.document();f.frame.element={contentWindow:primary.win};
 const child=f.document();child.win.parent=child.win;
 const client={url:new URL('https://ads.example/'),initHeaders:new Headers({[PROFILE_DOCUMENT_HEADER]:f.prepared[0].documentId})};
 assert.throws(()=>f.frame.hooks.init.pre.forEach(fn=>fn({window:child.win,client})),/origin changed/);
 assert.equal(f.errors.length,0);f.plugin.dispose();
});

test('a metadata-free ad iframe cannot replace the live primary website with a writer-busy error',async()=>{
 const f=fixture({prepareOrigin:async(value,options)=>{f.calls.push(['origin',value,options]);throw Error('Select Continue here to open this website.')}});
 f.frame.element={src:'https://frontend.test/~/main'};
 f.context.parsed={url:new URL('https://www.facebook.com/tr/'),destination:'iframe',isIframe:false,meta:{}};
 f.context.request.rawUrl=new URL('https://frontend.test/~/ad');
 f.context.request.rawReferrer='https://frontend.test/~/main';
 await assert.rejects(f.dispatch(f.hooks.intercept,f.context),/Continue here/);
 assert.deepEqual(f.calls.find(c=>c[0]==='origin')[2],{interactive:false});
 assert.equal(f.errors.length,0,'the actual failing ad remains denied without a whole-game error');f.plugin.dispose();
});

test('a metadata-free controller-assigned root still reports its real foreground refusal',async()=>{
 const f=fixture({prepareOrigin:async(value,options)=>{f.calls.push(['origin',value,options]);throw Error('Select Continue here to open this website.')}});
 f.frame.element={src:'https://frontend.test/~/main'};
 f.context.parsed={url:new URL('https://next-site.test/'),destination:'iframe',isIframe:false,meta:{}};
 f.context.request.rawUrl=new URL('https://frontend.test/~/main');
 await assert.rejects(f.dispatch(f.hooks.intercept,f.context),/Continue here/);
 assert.deepEqual(f.calls.find(c=>c[0]==='origin')[2],{interactive:true});
 assert.equal(f.errors.length,1);f.plugin.dispose();
});

test('a metadata-free request for the trusted current top-level URL remains interactive',async()=>{
 const f=fixture();f.frame.element={src:'https://frontend.test/~/initial'};
 f.context.parsed={url:new URL(url),destination:'iframe',isIframe:false,meta:{}};
 f.context.request.rawUrl=new URL('https://frontend.test/~/redirected');
 await f.dispatch(f.hooks.intercept,f.context);
 assert.deepEqual(f.calls.find(c=>c[0]==='origin')[2],{interactive:true});f.plugin.dispose();
});
