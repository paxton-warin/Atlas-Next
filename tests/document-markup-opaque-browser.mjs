/** Actual built opaque document static SVG / non-stylesheet link regression.
 * Only website responses are deterministic; all controller/owners/native gateway
 * and the selected Main relay probe use their real default implementations. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(), evidence=join(root,'evidence/document-markup-20261016');await fs.mkdir(evidence,{recursive:true});
let source=await fs.readFile('tests/frontend-browser-browser.mjs','utf8');
source=source.replace(/(from\s+["'])\.\.\/([^"']+)/g,(_m,start,path)=>start+pathToFileURL(join(root,path)).href);
function replace(from,to){assert.equal(source.split(from).length,2,'markup fixture source changed: '+from.slice(0,80));source=source.replace(from,to)}
const svg='<svg xmlns="http://www.w3.org/2000/svg" id="qualified-graphic" width="32" height="32" viewBox="0 0 32 32"><defs><linearGradient id="qualified-paint"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="qualified-clip"><rect width="32" height="32"/></clipPath><path id="qualified-shape" d="M0 0H32V32H0Z"/></defs><g clip-path="url(#qualified-clip)"><use href="#qualified-shape" fill="url(#qualified-paint)"/></g></svg>';
replace('</head><body><img id="picture"','<link rel="preconnect" href="https://hints-denied.example"><link rel="preload" as="script" href="https://hints-denied.example/never.js"><link rel="canonical" href="https://site.example/page"><link rel="icon" href="https://assets.example/icon.png"></head><body>'+svg+'<img id="picture"');
replace('} else if (request.url === "https://assets.example/image") {','} else if (request.url === "https://assets.example/image" || request.url === "https://assets.example/icon.png") {');
replace('  const result = await frame.evaluate(() => window.jointResult);',`
  const markupResult=await frame.evaluate(()=>{const svg=document.querySelector('#qualified-graphic'),box=svg.querySelector('use').getBBox();return{width:box.width,height:box.height,hintsRemoved:!document.querySelector('link[rel=preconnect],link[rel=preload]'),iconPresent:!!document.querySelector('link[rel=icon]')}});
  // Minimal qualification page lacks Atlas CSS; remove its UA iframe border
  // before comparing exact local pixels (the actual app also uses border:0).
  await page.evaluate(()=>{frontendBrowser.document.frame.style.border='0'});
  const svgScreenshot=await frame.locator('#qualified-graphic').screenshot();
  await fs.writeFile('/Users/paxton/Repositories/Atlas-Next/evidence/document-markup-20261016/SVG-ACTUAL.png',svgScreenshot);
  const svgPixels=await page.evaluate(async base64=>{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src='data:image/png;base64,'+base64});const c=document.createElement('canvas');c.width=c.height=32;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return{left:[...ctx.getImageData(1,16,1,1).data],right:[...ctx.getImageData(30,16,1,1).data]}},svgScreenshot.toString('base64'));
  assert.deepEqual(markupResult,{width:32,height:32,hintsRemoved:true,iconPresent:true});
  assert.ok(svgPixels.left[0]>230&&svgPixels.left[2]<25,JSON.stringify(svgPixels));assert.ok(svgPixels.right[2]>230&&svgPixels.right[0]<25,JSON.stringify(svgPixels));
  assert.equal((await page.evaluate(()=>jointCalls)).some(call=>call.url.includes('hints-denied.example')),false);
  console.log(JSON.stringify({opaqueDocumentMarkup:markupResult,actualInlineSVGPixels:svgPixels,noHintTransport:true}));
  const result = await frame.evaluate(() => window.jointResult);`);
replace('  const urls = physical.result.value;',`
  const nativeSVG=await cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:"document.querySelector('#qualified-graphic use').getAttribute('href')",returnByValue:true});
  assert.equal(nativeSVG.result.value,'#qualified-shape');
  const urls = physical.result.value;`);
replace('"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',JSON.stringify(join(evidence,process.env.ATLAS_MARKUP_BASELINE==='1'?'OPAQUE-BASELINE.json':'OPAQUE-MODIFIED.json')));
if(process.env.ATLAS_MARKUP_BASELINE==='1')replace('  const bundle = await build({',`  const bundle = await build({ plugins:[{name:'preserved-markup-plan',setup(builder){builder.onLoad({filter:/\\/runtime\\/original-document-plan\\.ts$/},async()=>({contents:await fs.readFile(${JSON.stringify(join(evidence,'before/original-document-plan.ts'))},'utf8'),loader:'ts',resolveDir:resolve('runtime')}))}}],`);
const probe=join(evidence,'opaque-probe-'+process.pid+'.mjs');await fs.writeFile(probe,source);try{await import(pathToFileURL(probe).href)}finally{await fs.rm(probe,{force:true})}
