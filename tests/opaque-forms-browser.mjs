/** Actual public UI/default runtime and real node transport; synthetic website
 * content only. Never opens credentials or performs a real sign-in. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
const path = "tests/.opaque-forms-generated-" + process.pid + ".mjs";
let source = await fs.readFile("tests/frontend-ui-real-browser.mjs", "utf8");
function section(start, end, replacement) {
  const first = source.indexOf(start),
    last = source.indexOf(end, first);
  assert.ok(
    first >= 0 && last > first,
    "actual UI fixture anchor changed: " + start,
  );
  source = source.slice(0, first) + replacement + source.slice(last);
}
const html = `<!doctype html><html><head><base href="/logical-base/"><base href="/ignored/"><title>Form fixture</title><style>body{background-image:url(pixel)}</style><script type="module">import {value} from './module.js';window.baseModule=value;</script></head><body>
<form id="get" action="receive?old=drop#sent"><input name="q" value="one two&amp;"><input type="checkbox" name="checked" value="yes" checked><input name="disabled" value="omit" disabled><button name="send" value="get">GET Save</button></form>
<form id="post" method="post" action="receive"><textarea name="note">a\nb</textarea><input name="choice" value="x&amp;y"><button name="send" value="post">POST Save</button></form>
<form id="plain" method="post" enctype="text/plain" action="receive"><input name="choice" value="x&amp;y"><button name="send" value="plain">Plain Save</button></form>
<form id="multipart" method="post" enctype="multipart/form-data" action="receive"><input type="file" name="upload"><input name="choice" value="x&amp;y"><button name="send" value="multipart">Multipart Save</button></form>
<form id="cancel" action="receive"><input name="cancel" value="true"><button>Cancel Save</button></form>
<form id="invalid" action="receive"><input name="required" required><button>Invalid Save</button></form>
<form id="escape" method="post" action="FRONTEND_PLACEHOLDER/api/admin/logout"><input name="forged" value="true"><button>Frontend Denied</button></form>
<script>window.uiFixture={};window.formEvents=[];for(const f of document.forms){f.addEventListener('submit',e=>{formEvents.push('submit:'+f.id);if(f.id==='cancel')e.preventDefault()});f.addEventListener('formdata',()=>formEvents.push('formdata:'+f.id));f.addEventListener('error',()=>formEvents.push('error:'+f.id));}window.baseSnapshot={base:document.baseURI,element:document.querySelector('base').href,location:location.href};try{document.querySelector('base').href='/mutated/';window.baseMutation='allowed'}catch(e){window.baseMutation=e.name}</script>
</body></html>`;
section(
  "const websiteHTML =",
  "const evidence =",
  "const websiteHTML = " + JSON.stringify(html) + ";\n",
);
section(
  "  website = http.createServer",
  "  await new Promise((resolve) => website.listen",
  `  website = http.createServer(async (req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const record={path:req.url,method:req.method,body:Buffer.concat(chunks).toString(),contentType:req.headers['content-type']||'',origin:req.headers.origin||'',referer:req.headers.referer||'',cookie:req.headers.cookie||''};
    websiteCalls.push(record);res.setHeader('connection','close');
    if(req.url.includes('receive')||req.method==='POST'){
      res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><h1>Form received</h1><script>window.receipt='+JSON.stringify(record).replaceAll('<','\\u003c')+';window.uiFixture={};</'+'script></body></html>');
    }else if(req.url.endsWith('/module.js')){res.setHeader('content-type','application/javascript');res.end('export const value="correct-base"');}
    else if(req.url.endsWith('/pixel')){res.setHeader('content-type','image/png');res.end(png);}
    else {if(req.url==='/set-cookies')res.setHeader('set-cookie',['strict=fixture; SameSite=Strict; Path=/','lax=fixture; SameSite=Lax; Path=/']);res.setHeader('content-type','text/html');if(req.url==='/form-denied')res.setHeader('content-security-policy',"form-action 'none'");if(req.url==='/base-denied')res.setHeader('content-security-policy',"base-uri 'none'");res.end(websiteHTML.replaceAll('FRONTEND_PLACEHOLDER',frontend));}
  });\n`,
);
if (process.env.ATLAS_FORMS_BASELINE) {
  const before = await fs.readFile(
    "evidence/base-form-navigation-20261016/before/runtime/original-document-plan.ts",
    "utf8",
  );
  const anchor = 'loader: { ".css": "empty" },';
  assert.equal(source.split(anchor).length, 2);
  source = source.replace(
    anchor,
    anchor +
      `plugins:[{name:'preserved-base-form-plan',setup(builder){builder.onLoad({filter:/original-document-plan\\.ts$/},()=>({contents:${JSON.stringify(before)},loader:'ts',resolveDir:resolve('runtime')}))}}],`,
  );
}
section(
  "  const page = await context.newPage();",
  "} catch (error) {\n  console.error(",
  `
  const page=await context.newPage();watch(page);await page.goto(frontend);
  const search=page.getByRole('combobox',{name:'Search the web',exact:true});await search.fill(websiteOrigin+'/forms');await search.press('Enter');
  if(process.env.ATLAS_FORMS_BASELINE){await page.locator('.runtime-error').waitFor();const result=await page.locator('.runtime-error').innerText();assert.match(result,/original_plan_unsupported_element/);console.log(JSON.stringify({result:'BASELINE original_plan_unsupported_element',input:'GET /forms containing base and forms',observed:result}));throw new Error('BASELINE_EXPECTED_BASE_FORM_REJECTION');}
  let frame=await documentFrame(page);
  await frame.waitForFunction(()=>window.baseModule==='correct-base');
  assert.deepEqual(await frame.evaluate(()=>baseSnapshot),{base:websiteOrigin+'/logical-base/',element:websiteOrigin+'/logical-base/',location:websiteOrigin+'/forms'});
  assert.equal(await frame.evaluate(()=>baseMutation),'NotSupportedError');
  assert.ok(websiteCalls.some(c=>c.path==='/logical-base/pixel'));assert.ok(websiteCalls.some(c=>c.path==='/logical-base/module.js'));
  async function open(path='/forms'){
    const previous=frame.url();const address=page.getByRole('combobox',{name:'Address bar',exact:true});await address.fill(path.startsWith('http')?path:websiteOrigin+path);await address.press('Enter');
    await page.waitForFunction(old=>{const f=document.querySelector('[data-frontend-runtime="2"] iframe');return f&&f.src!==old},previous);frame=await documentFrame(page);return frame;
  }
  async function submit(name){const previous=frame.url();await frame.getByRole('button',{name,exact:true}).click();await page.waitForFunction(old=>{const f=document.querySelector('[data-frontend-runtime="2"] iframe');return f&&f.src!==old},previous);frame=await documentFrame(page);await frame.waitForFunction(()=>window.receipt);return frame.evaluate(()=>receipt);}
  const get=await submit('GET Save');assert.equal(get.method,'GET');assert.equal(get.path,'/logical-base/receive?q=one+two%26&checked=yes&send=get');assert.equal(get.body,'');
  await open();const post=await submit('POST Save');assert.equal(post.method,'POST');assert.equal(post.body,'note=a%0D%0Ab&choice=x%26y&send=post');assert.equal(post.contentType,'application/x-www-form-urlencoded');assert.equal(post.origin,websiteOrigin);assert.equal(post.referer,websiteOrigin+'/forms');
  await open();const plain=await submit('Plain Save');assert.equal(plain.contentType,'text/plain');assert.equal(plain.body,'choice=x&y\\r\\nsend=plain\\r\\n');
  await open();await frame.locator('input[type=file]').setInputFiles({name:'sample.txt',mimeType:'text/plain',buffer:Buffer.from('deterministic file bytes')});const multipart=await submit('Multipart Save');assert.match(multipart.contentType,/^multipart\\/form-data; boundary=/);assert.ok(multipart.body.includes('name="upload"; filename="sample.txt"'));assert.ok(multipart.body.includes('deterministic file bytes'));
  await open();await frame.evaluate(()=>{const f=document.querySelector('#get');f.setAttribute('action','');f.querySelector('button').setAttribute('formmethod','POST')});const selfPost=await submit('GET Save');assert.equal(selfPost.method,'POST');assert.equal(selfPost.path,'/forms');assert.equal(selfPost.body,'q=one+two%26&checked=yes&send=get');
  await open('http://localhost:4199/set-cookies');
  await open();await frame.evaluate(()=>document.querySelector('#post').setAttribute('action','http://localhost:4199/receive'));const crossPost=await submit('POST Save');assert.equal(crossPost.cookie,'');assert.equal(crossPost.origin,websiteOrigin);assert.equal(crossPost.referer,websiteOrigin+'/');
  await open();await frame.evaluate(()=>document.querySelector('#get').setAttribute('action','http://localhost:4199/receive'));const crossGet=await submit('GET Save');assert.equal(crossGet.cookie,'lax=fixture');assert.ok(!crossGet.cookie.includes('strict='));
  await open();const beforeCancel=websiteCalls.length,sourceURL=frame.url();await frame.getByRole('button',{name:'Cancel Save',exact:true}).click();await frame.waitForFunction(()=>formEvents.includes('submit:cancel'));await page.waitForTimeout(25);assert.equal(frame.url(),sourceURL);assert.equal(websiteCalls.length,beforeCancel);
  await frame.getByRole('button',{name:'Invalid Save',exact:true}).click();await page.waitForTimeout(25);assert.equal(websiteCalls.length,beforeCancel);assert.equal(await frame.evaluate(()=>formEvents.includes('submit:invalid')),false);
  await frame.getByRole('button',{name:'Frontend Denied',exact:true}).click();await frame.waitForFunction(()=>formEvents.includes('error:escape'));assert.equal(requests.filter(r=>r.path==='/api/admin/logout').length,0);
  await open('/form-denied');const deniedCount=websiteCalls.length;await frame.getByRole('button',{name:'POST Save',exact:true}).click();await frame.waitForFunction(()=>formEvents.includes('error:post'));assert.equal(websiteCalls.length,deniedCount);
  await open('/base-denied');assert.equal(await frame.evaluate(()=>document.baseURI),websiteOrigin+'/base-denied');
  assert.equal(await nativeOrigin(page,frame),'null');assert.equal(new URL(frame.url()).origin,frontend);
  assert.equal(await page.locator('.runtime-error').count(),0);
  console.log(JSON.stringify({result:'actual_default_runtime_forms_verified',assetCount:Object.keys(manifest.files).length,logicalBase:true,relativeModuleAndCSS:true,GET:get,POST:post,textPlain:true,multipart:true,sameURLSubmitterOverride:true,crossSitePOSTCookieDenied:true,crossSiteGETLaxOnly:true,cancel:true,validation:true,frontendDenied:true,formActionDenied:true,baseURIDenied:true,nativeOpaque:true,errors,scope:'Actual React/default runtime/real two paired local nodes/real HttpEngine; deterministic website; no sign-in or public-site claim'},null,2));
`,
);
try {
  await fs.writeFile(path, source);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await fs.rm(path, { force: true });
}
