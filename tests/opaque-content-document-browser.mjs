/** Actual built Main/default runtime plus native Chrome opaque iframe comparator.
 * Website payload only is deterministic. No production registration/activation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const root=resolve(),evidence=join(root,'evidence/opaque-content-document-20261016');
await fs.mkdir(evidence,{recursive:true});
let source=await fs.readFile('tests/frontend-browser-browser.mjs','utf8');
source=source.replace(/(from\s+["'])\.\.\/([^"']+)/g,(_m,prefix,path)=>prefix+pathToFileURL(join(root,path)).href);
const replace=(before,after)=>{assert.equal(source.split(before).length,2,'Fixture seam changed: '+before.slice(0,80));source=source.replace(before,after)};
replace("export {createFrontendBrowser} from './frontend-browser.ts';",`export {createFrontendBrowser} from './frontend-browser.ts';export {captureOpaqueContentDocumentParity} from ${JSON.stringify(join(root,"runtime/opaque-runtime-adapter.ts"))};`);
replace('  app.get("/favicon.ico", (_req, reply) => reply.code(204).send());',`
  let deniedAPIHits=0;
  app.get('/api/opaque-parity-deny-probe',(_req,reply)=>{deniedAPIHits++;return reply.send({privateFrontendSentinel:true})});
  app.get('/native-content-document',(_req,reply)=>reply.removeHeader('X-Frame-Options').header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'").type('text/html').send(\`<!doctype html><body><script>
    const frame=document.createElement('iframe');document.body.append(frame);
    let contentDocument,windowDocument;try{contentDocument=frame.contentDocument===null?'null':'readable'}catch(e){contentDocument=e.name}
    try{void frame.contentWindow.document;windowDocument='readable'}catch(e){windowDocument=e.name}
    parent.postMessage({type:'native-content-document-parity',contentDocument,windowDocument},'*');
  <\\/script>\`));
  app.get("/favicon.ico", (_req, reply) => reply.code(204).send());`);
replace('  const png =',`  const nativeParity=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.src='/native-content-document';
    const timer=setTimeout(()=>reject(Error('native comparator timeout')),5000);
    const receive=event=>{if(event.source===frame.contentWindow&&event.data?.type==='native-content-document-parity'){clearTimeout(timer);removeEventListener('message',receive);frame.remove();resolve(event.data)}};
    addEventListener('message',receive);document.body.append(frame);
  }));
  assert.deepEqual(nativeParity,{type:'native-content-document-parity',contentDocument:'null',windowDocument:'SecurityError'});
  const nativeNonNull=await page.evaluate(async()=>{
    const {captureOpaqueContentDocumentParity}=await import('/fixture.js'),outer=document.createElement('iframe');document.body.append(outer);
    try{const realm=outer.contentWindow,inner=realm.document.createElement('iframe');realm.document.body.append(inner);
      const before=Object.getOwnPropertyDescriptor(realm.HTMLIFrameElement.prototype,'contentDocument'),nativeReadable=before.get.call(inner)!==null;
      const install=captureOpaqueContentDocumentParity(realm);let delegated=0,constructorReads=0;
      for(const name of ['HTMLIFrameElement','HTMLFrameElement','HTMLObjectElement','HTMLEmbedElement']){const proto=realm[name]?.prototype;if(!proto)continue;const d=Object.getOwnPropertyDescriptor(proto,'contentDocument');if(!d?.get)continue;Object.defineProperty(proto,'contentDocument',{...d,get(){delegated++;throw new DOMException('Unqualified subcontext','NotSupportedError')}})}
      const installed=install();let nonNull,brand;try{void inner.contentDocument;nonNull='readable'}catch(e){nonNull=e.name}
      const after=Object.getOwnPropertyDescriptor(realm.HTMLIFrameElement.prototype,'contentDocument');try{after.get.call({get constructor(){constructorReads++;throw Error('spoof')}});brand='accepted'}catch(e){brand=e.name}
      return{nativeReadable,nonNull,delegated,brand,constructorReads,installed,flagsPreserved:before.enumerable===after.enumerable&&before.configurable===after.configurable&&before.set===after.set};
    }finally{outer.remove()}
  });
  assert.equal(nativeNonNull.nativeReadable,true);assert.equal(nativeNonNull.nonNull,'NotSupportedError');assert.equal(nativeNonNull.delegated,1);assert.equal(nativeNonNull.brand,'TypeError');assert.equal(nativeNonNull.constructorReads,0);assert.equal(nativeNonNull.flagsPreserved,true);
  const png =`);
replace('<script>\n  (async()=>{let parentFrontendLeak=false;',`<script>
  (()=>{const frame=document.createElement('iframe');document.body.append(frame);let contentDocument,windowDocument,brand;
    try{contentDocument=frame.contentDocument===null?'null':'readable'}catch(error){contentDocument=error.name}
    try{void frame.contentWindow.document;windowDocument='readable'}catch(error){windowDocument=error.name}
    try{Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentDocument').get.call({});brand='accepted'}catch(error){brand=error.name}
    const getter=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentDocument').get,rawApply=Reflect.apply,rawDescriptor=Object.getOwnPropertyDescriptor,rawDefine=Object.defineProperty;let poisoned;
    try{Reflect.apply=()=>{throw Error('poisoned apply')};Object.getOwnPropertyDescriptor=()=>{throw Error('poisoned descriptor')};Object.defineProperty=()=>{throw Error('poisoned define')};poisoned=getter.call(frame)===null?'null':'readable'}catch(e){poisoned=e.name}finally{Reflect.apply=rawApply;Object.getOwnPropertyDescriptor=rawDescriptor;Object.defineProperty=rawDefine}
    frame.remove();window.contentDocumentParity={contentDocument,windowDocument,brand,poisoned};})();
  (async()=>{let parentFrontendLeak=false;`);
replace('  const result = await frame.evaluate(() => window.jointResult);',`  const parity=await frame.evaluate(()=>window.contentDocumentParity);
  console.log(JSON.stringify({nativeParity,nativeNonNull,candidate:parity,scope:'actual built opaque runtime with deterministic website fetch'}));
  assert.deepEqual(parity,{contentDocument:'null',windowDocument:'SecurityError',brand:'TypeError',poisoned:'null'});
  const result = await frame.evaluate(() => window.jointResult);`);
replace('  assert.equal(boundary.result.value, "SecurityError");',`  assert.equal(boundary.result.value, "SecurityError");
  const nativeDenials=await cdp.send('Runtime.evaluate',{contextId:executionContextId,awaitPromise:true,returnByValue:true,expression:
    '(async()=>{const r={};for(const [key,fn]of Object.entries({parent:()=>parent.document.body,storage:()=>localStorage.length,cookies:()=>document.cookie,idb:()=>indexedDB.open("frontend-leak"),worker:()=>new Worker('+JSON.stringify(frontend+'/fixture.js')+')})){try{fn();r[key]="readable"}catch(e){r[key]=e.name}}try{await fetch('+JSON.stringify(frontend+'/api/opaque-parity-deny-probe')+',{credentials:"include"});r.api="readable"}catch(e){r.api=e.name}return r})()'});
  assert.deepEqual(nativeDenials.result.value,{parent:'SecurityError',storage:'SecurityError',cookies:'SecurityError',idb:'SecurityError',worker:'SecurityError',api:'TypeError'});
  assert.equal(deniedAPIHits,0);
  console.log(JSON.stringify({nativeDenials:nativeDenials.result.value,frontendAPIHits:deniedAPIHits,opaqueBoundaryUnchanged:true}));
  await fs.writeFile(${JSON.stringify(join(evidence,'BROWSER.json'))},JSON.stringify({nativeParity,nativeNonNull,candidate:parity,nativeDenials:nativeDenials.result.value,frontendAPIHits:deniedAPIHits,actualBuiltMain:true,websiteTransport:'deterministic',qualified:false},null,2)+'\\n');`);
replace('"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',JSON.stringify(join(evidence,'FRONTEND-BROWSER.json')));
let copied;
if(process.env.ATLAS_CONTENT_DOCUMENT_BASELINE==='1'||process.env.ATLAS_CONTENT_DOCUMENT_SOURCE_COPY){
 copied=await fs.mkdtemp(join(tmpdir(),'atlas-content-document-copy-'));await fs.mkdir(join(copied,'runtime'));
 for(const file of await fs.readdir(join(root,'runtime')))if(file.endsWith('.ts'))await fs.copyFile(join(root,'runtime',file),join(copied,'runtime',file));
 await fs.copyFile(process.env.ATLAS_CONTENT_DOCUMENT_SOURCE_COPY?join(resolve(process.env.ATLAS_CONTENT_DOCUMENT_SOURCE_COPY),'runtime/opaque-runtime-adapter.ts'):join(evidence,'BASELINE_opaque-runtime-adapter.ts'),join(copied,'runtime/opaque-runtime-adapter.ts'));
 for(const name of ['scripts','node_modules','web'])await fs.symlink(join(root,name),join(copied,name),'dir');await fs.symlink(join(root,'runtime/public'),join(copied,'runtime/public'),'dir');
 replace('manifest = await buildOpaqueRuntime({ outdir: assetDir });',`manifest=await(async()=>{const cwd=process.cwd();process.chdir(${JSON.stringify(copied)});try{return await buildOpaqueRuntime({outdir:assetDir})}finally{process.chdir(cwd)}})();`);
 replace('resolveDir: resolve("runtime"),',`resolveDir:${JSON.stringify(join(copied,'runtime'))},`);
}
const probe=join(evidence,'probe-'+process.pid+'.mjs');await fs.writeFile(probe,source);
try{await import(pathToFileURL(probe).href)}finally{await fs.rm(probe,{force:true});if(copied)await fs.rm(copied,{recursive:true,force:true})}
