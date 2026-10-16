/** Real native DOM plan/SVG/resource-hint qualification. A separate built
 * controller proof qualifies the same markup inside the actual opaque runtime. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import Fastify from 'fastify';
import {chromium} from '@playwright/test';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
const baseline=process.env.ATLAS_MARKUP_BASELINE==='1';
const bundle=(await build({stdin:{contents:"export {createOriginalDocumentPlan} from './runtime/original-document-plan.ts'; export {createOriginalDocumentPolicy} from './runtime/original-document-policy.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',logLevel:'silent',plugins:baseline?[{name:'preserved-markup-plan',setup(builder){builder.onLoad({filter:/\/runtime\/original-document-plan\.ts$/},async()=>({contents:await fs.readFile('evidence/document-markup-20261016/before/original-document-plan.ts','utf8'),loader:'ts',resolveDir:process.cwd()+'/runtime'}))}}]:[]})).outputFiles[0].text;
const app=Fastify({logger:false});let browser;
app.get('/',(_q,p)=>p.type('text/html').send('<!doctype html><title>Document markup qualification</title><main></main>'));
app.get('/plan.js',(_q,p)=>p.type('application/javascript').send(bundle));
app.get('/favicon.ico',(_q,p)=>p.code(204).send());
try{
 await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+app.server.address().port);
 const result=await page.evaluate(async()=>{
  const {createOriginalDocumentPlan,createOriginalDocumentPolicy}=await import('/plan.js');
  const url='https://site.test/page',policy=createOriginalDocumentPolicy({documentURL:url,contentPolicies:["default-src 'none';script-src 'none';style-src 'none';img-src 'self';media-src 'self'"]});
  const plan=createOriginalDocumentPlan({documentURL:url,policy});
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs><linearGradient id="paint"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="clip"><rect width="32" height="32"/></clipPath><path id="shape" d="M0 0H32V32H0Z"/></defs><g clip-path="url(#clip)"><use href="#shape" fill="url(#paint)"/></g></svg>';
  let prepared;try{prepared=await plan.prepare('<head><link rel="preconnect" href="https://peer.test"><link rel="preload" as="script" href="https://peer.test/never.js"><link rel="canonical" href="/canonical"><link rel="icon" href="/icon.png"></head><body>'+svg+'</body>')}catch(error){return{failure:error.code}}
  const parsed=new DOMParser().parseFromString(prepared.html,'text/html');
  const host=document.querySelector('main');host.replaceChildren(...parsed.body.childNodes);
  const graphic=host.querySelector('svg'),use=host.querySelector('use');
  const bbox=use.getBBox(),rect=graphic.getBoundingClientRect();
  const serialized=new XMLSerializer().serializeToString(graphic),image=new Image();
  const objectURL=URL.createObjectURL(new Blob([serialized],{type:'image/svg+xml'}));
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=objectURL});
  const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const left=[...ctx.getImageData(1,16,1,1).data],right=[...ctx.getImageData(30,16,1,1).data];URL.revokeObjectURL(objectURL);
  const negative=[];
  for(const markup of [
   '<svg><script>window.leak=true</script></svg>',
   '<svg><foreignObject><div>foreign</div></foreignObject></svg>',
   '<svg><animate attributeName="href" to="https://peer.test/a"/></svg>',
   '<svg><image href="https://peer.test/a"/></svg>',
   '<svg onload="window.leak=true"><path d="M0 0"/></svg>',
   '<svg><use href="https://peer.test/a#x"/></svg>',
   '<svg><path fill="url(https://peer.test/a)"/></svg>',
   '<svg><path fill="u\\72l(https://peer.test/a)"/></svg>',
   '<svg><path style="fill:url(#x)"/></svg>',
   '<svg><path xml:base="https://peer.test"/></svg>',
  ]){try{await plan.prepare(markup);negative.push('MISSED')}catch(error){negative.push(error.code)}}
  const media=await plan.prepare('<picture><source media="(min-width:1px)" srcset="/large.png 2x, /small.png 1x"><img src="/fallback.png" sizes="32px"></picture><video controls src="/movie.mp4" poster="/poster.png"><source src="/movie.webm" type="video/webm"></video><audio src="/tone.wav"></audio>');
  const mediaDoc=new DOMParser().parseFromString(media.html,'text/html');
  const denied=await createOriginalDocumentPlan({documentURL:url,policy:createOriginalDocumentPolicy({documentURL:url,contentPolicies:["default-src 'none'"]})}).prepare('<video src="/movie" poster="/poster"><source src="/alternate"></video><img srcset="/image 1x"><link rel="icon" href="/icon">');
  const deniedDoc=new DOMParser().parseFromString(denied.html,'text/html');
  const malformed=[];for(const value of ['<source src="/x">','<div srcset="/x 1x"></div>','<img poster="/x">','<link rel="unsupported" href="/x">']){try{await plan.prepare(value);malformed.push('MISSED')}catch(error){malformed.push(error.code)}}
  return{svg:{elements:host.querySelectorAll('svg,svg *').length,bbox:{width:bbox.width,height:bbox.height},rect:{width:rect.width,height:rect.height},left,right,fragment:use.getAttribute('href')},hintsRemoved:!parsed.querySelector('link[rel=preconnect],link[rel=preload]'),canonical:parsed.querySelector('link[rel=canonical]')?.getAttribute('href'),icon:parsed.querySelector('link[rel=icon]')?.getAttribute('href'),negative,malformed,media:{kinds:media.decisions.map(d=>d.kind),video:mediaDoc.querySelector('video').getAttribute('src'),poster:mediaDoc.querySelector('video').getAttribute('poster'),srcset:mediaDoc.querySelector('source').getAttribute('srcset')},denied:{activeURLs:deniedDoc.querySelectorAll('[src],[srcset],[poster],link[href]').length,allDenied:denied.decisions.every(d=>!d.allowed)}};
 });
 console.log(JSON.stringify(result));
 assert.equal(result.failure,undefined);
 assert.equal(result.svg.bbox.width,32);assert.equal(result.svg.bbox.height,32);assert.equal(result.svg.rect.width,32);assert.equal(result.svg.fragment,'#shape');
 assert.ok(result.svg.left[0]>230&&result.svg.left[2]<25);assert.ok(result.svg.right[2]>230&&result.svg.right[0]<25);
 assert.equal(result.hintsRemoved,true);assert.equal(result.canonical,'https://site.test/canonical');assert.equal(result.icon,'https://site.test/icon.png');
 assert.equal(result.negative.length,10);assert.ok(result.negative.every(code=>typeof code==='string'&&code.startsWith('original_plan_svg_')));
 assert.equal(result.malformed.length,4);assert.ok(result.malformed.every(code=>typeof code==='string'&&code.startsWith('original_plan_')));
 assert.equal(result.media.video,'https://site.test/movie.mp4');assert.equal(result.media.poster,'https://site.test/poster.png');assert.equal(result.media.kinds.filter(kind=>kind==='media').length,3);
 assert.equal(result.denied.activeURLs,0);assert.equal(result.denied.allDenied,true);
 await fs.mkdir('evidence/document-markup-20261016',{recursive:true});await fs.writeFile('evidence/document-markup-20261016/NATIVE-BROWSER.json',JSON.stringify(result,null,2)+'\n');
}finally{await browser?.close();await app.close()}
