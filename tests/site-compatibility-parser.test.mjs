import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import ts from'typescript';import{runInNewContext}from'node:vm';
const source=readFileSync(process.env.ATLAS_SITE_GUARD_SOURCE||new URL('../runtime/site-compatibility.ts',import.meta.url),'utf8');
function fixture(state='loading'){
 const events=new Map(),wEvents=new Map(),observations=[];let disconnects=0,titles=0;
 const doc={readyState:state,title:'Fixture',head:{},documentElement:{},body:null,addEventListener:(t,h)=>events.set(t,h),removeEventListener:(t,h)=>{if(events.get(t)===h)events.delete(t)}};
 const win={document:doc,addEventListener:(t,h)=>wEvents.set(t,h),removeEventListener:(t,h)=>{if(wEvents.get(t)===h)wEvents.delete(t)},MutationObserver:class{constructor(fn){this.fn=fn}observe(target,options){observations.push({target,options})}disconnect(){disconnects++}}};
 const exports={};runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>({ruleFor:()=>null}),WeakMap,Map,Set,URL,Date,setTimeout,clearTimeout});
 const guard=exports.installDocumentGuard(win,{id:'fixture',pageUrl:()=> 'https://example.test/',enabled:()=>false,sampleRisk:false,report(){},onTitle(){titles++}});
 return{doc,win,guard,events,wEvents,observations,get disconnects(){return disconnects},get titles(){return titles}};
}
test('presentation observer leaves parser-created nodes untouched until DOMContentLoaded',()=>{const f=fixture();try{assert.equal(f.observations.length,0);assert.equal(f.titles,0);f.doc.readyState='interactive';f.events.get('DOMContentLoaded')();assert.equal(f.observations.length,1);assert.equal(f.titles,1);assert.equal(f.observations[0].target,f.doc.head)}finally{f.guard.dispose()}});
test('already parsed documents keep normal metadata observation and disposal removes listeners',()=>{const f=fixture('complete');assert.equal(f.observations.length,1);f.guard.dispose();assert.equal(f.events.has('DOMContentLoaded'),false);assert.equal(f.wEvents.has('pagehide'),false);assert.ok(f.disconnects>=2)});
test('preload preference updates and delayed retries never attach a parser-phase observer',()=>{const f=fixture();try{for(let i=0;i<3;i++)f.guard.update(false);assert.equal(f.observations.length,0);f.doc.readyState='complete';f.events.get('DOMContentLoaded')();assert.equal(f.observations.length,1)}finally{f.guard.dispose()}});
