import {test} from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import{readFileSync}from'node:fs';
const source=ts.transpileModule(readFileSync('web/src/hub-client-state.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const session=(id)=>({enabled:true,authenticated:true,csrf:'fixture-csrf',grant:{profileId:id,sessionId:id,contextId:id}});
test('an account switch discards an in-flight profile response, including a successful old-account commit',async()=>{globalThis.window=new EventTarget();globalThis.CustomEvent=class extends Event{constructor(type,input){super(type);this.detail=input.detail;}};const m=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));let resolve;globalThis.fetch=()=>new Promise(r=>resolve=r);m.setHubSession(session('A'));const pending=m.hubProfileRequest('/stream','POST',{namespace:{kind:'atlas'}});m.setHubSession(session('B'));resolve({ok:true,json:async()=>({acknowledged:true,private:'account A'})});await assert.rejects(pending,{code:'PROFILE_CONTEXT_CHANGED'});});
test('sign-out discards an old response, but a CSRF refresh for the same identity remains valid',async()=>{const m=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));let resolve;globalThis.fetch=()=>new Promise(r=>resolve=r);m.setHubSession(session('A'));const first=m.hubProfileRequest();m.setHubSession(null);resolve({ok:true,json:async()=>({values:['old']})});await assert.rejects(first,{code:'PROFILE_CONTEXT_CHANGED'});m.setHubSession(session('B'));const second=m.hubProfileRequest();m.setHubSession({...session('B'),csrf:'refreshed'});resolve({ok:true,json:async()=>({revision:2})});assert.deepEqual(await second,{revision:2});});

test('serialized worker JSON Blobs preserve CSRF and same-account guards without shell stringify',async()=>{
 const m=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//worker-blob-test').toString('base64'));
 m.setHubSession(session('A'));const body=new Blob(['{"hash":"synthetic","data":"AA=="}'],{type:'application/json'});let captured;
 globalThis.fetch=async(url,options)=>{captured={url,options};return{ok:true,json:async()=>({acknowledged:true})}};
 const original=JSON.stringify;JSON.stringify=()=>{throw Error('SHELL_STRINGIFY')};
 try{assert.deepEqual(await m.hubProfileRequest('/chunks','POST',body),{acknowledged:true})}finally{JSON.stringify=original}
 assert.equal(captured.options.body,body);assert.equal(captured.options.headers['x-atlas-hub-csrf'],'fixture-csrf');assert.equal(captured.options.credentials,'same-origin');
 m.setHubSession(null);await assert.rejects(m.hubProfileRequest('/chunks','POST',body),/Authenticate/);
});
