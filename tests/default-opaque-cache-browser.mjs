/** Cache port integration through the actual seven-asset default runtime, not a
 * manually installed facade. Website transport is deterministic, not public-site
 * acceptance. The whole frontend reloads only after the cache commit resolves. */
import fs from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(), evidence=join(root,'evidence/cache-default-integration-20261016');
await fs.mkdir(evidence,{recursive:true});
const base=await fs.readFile(join(root,'tests/frontend-browser-browser.mjs'),'utf8');
const start=base.indexOf('  const png ='),end=base.lastIndexOf('\n} finally {');
if(start<0||end<start)throw Error('Default browser fixture setup changed');
let source=base.slice(0,start).replace(/(from\s+["'])\.\.\/([^"']+)/g,(_m,p,path)=>p+pathToFileURL(join(root,path)).href);
source+=`
  const boot=async()=>{
    const {createFrontendBrowser}=await import('/fixture.js');
    const html='<!doctype html><title>Cache port</title><body><script>(async()=>{try{const c=await caches.open("default-integration"),r=await c.match("/save"),before=r?await r.text():null;await c.put("/save",new Response(String(Number(before||0)+1)));const committed=await c.match("/save"),copy=Response.prototype.clone.call(committed);window.cacheDefaultResult={before,after:await copy.text(),type:copy.type};document.body.textContent="Cache committed"}catch(e){window.cacheDefaultResult={error:e.name,message:e.message}}})();</'+'script>';
    const bytes=new TextEncoder().encode(html);
    window.defaultCacheBrowser=await createFrontendBrowser({container:document.querySelector('main'),timeoutMs:30000,components:{fetch:()=>async request=>({url:request.url,status:200,statusText:'OK',headers:[['content-type','text/html']],body:bytes.slice().buffer})}});
    await defaultCacheBrowser.start('https://cache-default.example/');
  };
  await page.evaluate(boot);
  const frame=()=>page.frames().find(f=>f.url().startsWith(frontend+'/browse/frame/'));
  await frame().waitForFunction(()=>window.cacheDefaultResult,null,{timeout:15000});
  const first=await frame().evaluate(()=>window.cacheDefaultResult);
  assert.deepEqual(first,{before:null,after:'1',type:'default'});
  await page.reload();await page.evaluate(boot);
  await frame().waitForFunction(()=>window.cacheDefaultResult,null,{timeout:15000});
  const second=await frame().evaluate(()=>window.cacheDefaultResult);
  assert.deepEqual(second,{before:'1',after:'2',type:'default'});
  const receipt={defaultAssets:Object.keys(manifest.files).length,first,wholeFrontendReload:second,opaqueFrameURL:frame().url().startsWith(frontend+'/browse/frame/'),scope:'Actual default opaque Cache port+broker+RuntimeKit override+response clone; deterministic website transport'};
  await fs.writeFile(${JSON.stringify(join(evidence,'DEFAULT-BROWSER.json'))},JSON.stringify(receipt,null,2)+'\\n');console.log(JSON.stringify(receipt));
  await page.evaluate(()=>defaultCacheBrowser.dispose());
`+base.slice(end);
const temporary=join(evidence,'default-cache-'+process.pid+'.mjs');await fs.writeFile(temporary,source);
try{await import(pathToFileURL(temporary).href);}finally{await fs.rm(temporary,{force:true});}
