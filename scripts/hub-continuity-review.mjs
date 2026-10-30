#!/usr/bin/env node
/** Local-only human continuity review. No production connection or account reset.
 * A new persistent browser is required: opening another window in an already
 * running Chrome process does not apply new certificate arguments. */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const SOURCE='https://f95cee006232c41d09f7720a4ff4fc744fake405.atlas.localhost:4280';
export const TARGET='https://fcddb74cd1c254d4d9b2f24c562f75569fake410.atlas.localhost:4280';
export const FIXTURE='http://fixture.localhost:4299/storage';
export const COOKIE_CLICKER='https://orteil.dashnet.org/cookieclicker/';
export function reviewMode(value='--prepare'){
 if(!['--prepare','--prepare-cookie-clicker','--verify-only'].includes(value))throw Error('Use --prepare, --prepare-cookie-clicker, or --verify-only.');
 return {mode:value,temporary:value==='--verify-only',cookieClicker:value==='--prepare-cookie-clicker'};
}
export function localOrigin(value,port=4280){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.port!==String(port)||!(u.hostname==='localhost'||u.hostname.endsWith('.atlas.localhost'))||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Expected a local Lab origin.');
 return u.origin;
}
export function certificateSPKI(certificate){
 const publicKey=execFileSync('openssl',['x509','-in',certificate,'-pubkey','-noout']);
 const der=execFileSync('openssl',['pkey','-pubin','-outform','der'],{input:publicKey});
 return execFileSync('openssl',['dgst','-sha256','-binary'],{input:der}).toString('base64');
}
export function reviewOptions({executable,spki,headless=false}){
 if(!/^[A-Za-z0-9+/]{43}=$/.test(spki))throw Error('Expected the current Lab certificate public-key hash.');
 return {executablePath:executable,headless,ignoreHTTPSErrors:false,viewport:{width:1440,height:1000},
  args:['--host-resolver-rules=MAP *.localhost 127.0.0.1','--ignore-certificate-errors-spki-list='+spki]};
}
async function activate(page){
 return page.evaluate(async()=>{
  await navigator.serviceWorker.register('/worker.js',{scope:'/'});
  const registration=await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Worker activation timed out')),15000))]);
  const until=Date.now()+10000;while(registration.active?.state!=='activated'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  return {scope:registration.scope,script:registration.active?.scriptURL,state:registration.active?.state};
 });
}
async function main(){
 const {mode,temporary,cookieClicker}=reviewMode(process.argv[2]);
 const lab=JSON.parse(execFileSync(process.execPath,['scripts/hub-lab.mjs','status'],{cwd:root,encoding:'utf8'}));
 if(lab.localRuntime!=='same-origin-profile')throw Error('Start the existing same-origin-profile Lab first.');
 localOrigin(lab.hub,4300);localOrigin(lab.atlas);localOrigin(SOURCE);localOrigin(TARGET);
 const out=resolve(root,cookieClicker?'evidence/real-node-review-20261021':'evidence/continuity-review-20261021');await mkdir(out,{recursive:true});
 const executable=process.env.CHROME_PATH||join(process.env.HOME,'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
 const certificate=join(lab.directory,'cert.pem'),spki=certificateSPKI(certificate);
 const profile=temporary?await mkdtemp(join(tmpdir(),'atlas-worker-certificate-check-')):join(lab.directory,cookieClicker?'review-cookie-clicker-spki-20261021':'review-continuity-spki-20261021');
 await mkdir(profile,{recursive:true,mode:0o700});await chmod(profile,0o700);
 const options=reviewOptions({executable,spki,headless:temporary});
 const context=await chromium.launchPersistentContext(profile,options);
 const receipt={mode,browser:context.browser()?.version(),source:SOURCE,target:TARGET,website:cookieClicker?COOKIE_CLICKER:FIXTURE,
  certificateSPKI:spki,ignoreHTTPSErrors:false,globalCertificateBypass:false,systemTrustChanged:false,
  newProfileDirectory:temporary?'temporary (removed after verification)':profile,
  existingBrowsersClosed:false,productionChanged:false,checks:[],errors:[]};
 context.on('page',p=>{p.setDefaultTimeout(45000);p.on('pageerror',error=>receipt.errors.push(error.message.replace(/https?:\/\/\S+/g,'[URL]')));});
 const record=(name,value)=>{receipt.checks.push({name,...value});};
 const save=()=>writeFile(join(out,temporary?'CERTIFICATE_MODIFIED.json':'PREPARED.json'),JSON.stringify(receipt,null,2)+'\n');
 let completed=false;
 try{
  const guide=temporary?null:await context.newPage();
  const guidePath=resolve(root,'evidence/continuity-review-20261021/START_HERE.html');if(guide&&existsSync(guidePath))await guide.goto(pathToFileURL(guidePath).href);
  const hub=await context.newPage();await hub.goto(lab.hub,{waitUntil:'domcontentloaded'});
  await hub.getByLabel('Email address',{exact:true}).or(hub.getByRole('button',{name:'Sign out',exact:true})).first().waitFor();
  if(await hub.getByLabel('Email address',{exact:true}).isVisible().catch(()=>false)){
   await hub.getByLabel('Email address',{exact:true}).fill('student@atlas-lab.example');
   await hub.getByRole('button',{name:'Continue',exact:true}).click();
   const link=hub.getByRole('link',{name:'Open your verification file'});await link.waitFor();const href=await link.getAttribute('href'),url=new URL(href);
   localOrigin(url.origin,4300);if(!url.pathname.startsWith('/__lab/verification/'))throw Error('Expected displayed local verification file.');
   // Read the displayed verification file in the same certificate-scoped
   // browser. APIRequestContext TLS does not use Chromium's certificate flags.
   const file=await context.newPage();await file.goto(href);const text=await file.locator('body').innerText();await file.close();
   const code=text.match(/Verification code: (\d{6,8})/)?.[1];if(!code)throw Error('Verification code missing from displayed Lab file.');
   await hub.getByRole('textbox',{name:/digit verification code/}).fill(code);
   await hub.getByRole('button',{name:'Sign out',exact:true}).waitFor();
  }
  const session=await hub.evaluate(async()=>{const r=await fetch('/api/session');return{ok:r.ok,data:await r.json()};});
  if(!session.ok||session.data.user?.email!=='student@atlas-lab.example')throw Error('Review browser must use the seeded student account.');
  const opens=hub.getByRole('link',{name:'Open',exact:true});await opens.first().waitFor();
  const assigned=await opens.evaluateAll(elements=>elements.filter(e=>e.getBoundingClientRect().height).map(e=>new URL(e.href).origin));
  if(!assigned.includes(SOURCE)||!assigned.includes(TARGET))throw Error('Both review aliases must already be assigned; no allocation will be generated.');
  record('Existing assigned A/B links verified',{distinctOrigins:SOURCE!==TARGET,newAllocations:0});
  async function open(target){
   const page=await context.newPage();await page.goto(target,{waitUntil:'domcontentloaded'});
   await page.locator('.atlas').or(page.getByRole('button',{name:'Sign in',exact:true})).first().waitFor();
   if(await page.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.locator('.atlas').waitFor({timeout:60000});
   if(await page.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'Use defaults',exact:true}).click();
   return page;
  }
  if(temporary){
   for(const target of [SOURCE,TARGET]){
    const page=await open(target);
    const worker=await activate(page);
    if(worker.state!=='activated'||worker.scope!==target+'/'||worker.script!==target+'/worker.js')throw Error('Worker did not activate on the expected origin: '+JSON.stringify(worker));
    record('Actual root service worker activated',{origin:target,...worker});await page.close();
   }
   receipt.result='PASS';await save();console.log('SSL_WORKER=PASS; ORIGINS=2; ACTIVE=2; GLOBAL_TLS_BYPASS=NO; SYSTEM_TRUST_UNCHANGED=YES');completed=true;return;
  }
  const source=await open(SOURCE);
  const address=source.getByRole('combobox',{name:'Address bar',exact:true}).or(source.getByRole('combobox',{name:'Search the web',exact:true})).first();
  await address.fill(receipt.website);await address.press('Enter');
  if(cookieClicker){
   const until=Date.now()+120000;let websiteState='LOADING',websiteText='';
   while(Date.now()<until){
    if(await source.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await source.getByRole('button',{name:'Continue here',exact:true}).click();
    for(const frame of source.frames().slice(1)){
     const state=await frame.evaluate(()=>({game:!!document.querySelector('#bigCookie')&&!!(globalThis.Game?.ready),text:document.body?.innerText?.slice(0,1800)||''})).catch(()=>null);
     if(state?.game){websiteState='GAME_READY';websiteText=state.text;break;}
     if(state&&/Verify you are human|Performing security verification|Checking your browser|Just a moment/i.test(state.text)){websiteState='SITE_VERIFICATION_REQUIRED';websiteText=state.text;break;}
    }
    if(websiteState!=='LOADING')break;
    await sleep(500);
   }
   const worker=await activate(source);if(worker.state!=='activated')throw Error('Source worker did not activate.');
   const target=await open(TARGET),targetWorker=await activate(target);if(targetWorker.state!=='activated')throw Error('Target worker did not activate.');
   record('Real website opened inside Atlas',{websiteState,websiteText,manualGameActions:0,worker:worker.state});
   record('Destination signed in without requesting website navigation',{worker:targetWorker.state,fixtureNavigationRequested:false});
   await source.evaluate(()=>{document.title='A — Cookie Clicker · Atlas';});await target.evaluate(()=>{document.title='B — Restore here · Atlas';});
   await source.screenshot({path:join(out,'prepared-cookie-clicker.png')});await target.screenshot({path:join(out,'prepared-cookie-target.png')});
   for(const page of context.pages())if(page!==guide&&page!==hub&&page!==source&&page!==target&&page.url()==='about:blank')await page.close();
   receipt.result=websiteState==='GAME_READY'?'READY_FOR_USER':websiteState==='SITE_VERIFICATION_REQUIRED'?'AWAITING_SITE_VERIFICATION':'WEBSITE_LOADING';
   await save();await source.bringToFront();completed=true;
   console.log('REVIEW=OPEN; WEBSITE=COOKIE_CLICKER; STATE='+websiteState+'; WORKERS=2/2; MANUAL_GAME_ACTIONS=0; PRODUCTION_UNCHANGED');
   console.log('A='+SOURCE);console.log('B='+TARGET);console.log('GUIDE='+guidePath);
   await new Promise(resolve=>context.once('close',resolve));return;
  }
  const site=source.frameLocator('iframe[title="Atlas browsing runtime"]').first().frameLocator('iframe[title="Proxied website"]:not([hidden])').first();
  const until=Date.now()+150000;let continued=false;
  while(Date.now()<until){
   if(await source.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false)){
    await source.getByRole('button',{name:'Continue here',exact:true}).click();continued=true;
   }
   if(await site.locator('#count').isVisible().catch(()=>false))break;
   if(await source.locator('.runtime-error').isVisible().catch(()=>false)){
    const text=await source.locator('.runtime-error').innerText();if(!/Continue here/.test(text))throw Error(text);
   }
   await sleep(200);
  }
  await site.locator('#count').waitFor({timeout:5000});
  const count=await site.locator('#count').innerText(),worker=await activate(source);
  if(worker.state!=='activated')throw Error('Source worker did not activate.');
  record('Source loaded through actual Atlas with active worker',{count,...worker,ordinaryContinueHere:continued,fixtureSavesPerformed:0});
  const target=await open(TARGET);const targetWorker=await activate(target);
  if(targetWorker.state!=='activated')throw Error('Target worker did not activate.');
  record('Target signed in and worker ready without taking website ownership',{...targetWorker,fixtureNavigationRequested:false});
  await source.evaluate(()=>{document.title='A — Save here · Atlas continuity';});
  await target.evaluate(()=>{document.title='B — Restore here · Atlas continuity';});
  await hub.evaluate(()=>{document.title='Account · Atlas continuity';});
  await source.screenshot({path:join(out,'prepared-source.png')});await target.screenshot({path:join(out,'prepared-target.png')});
  for(const page of context.pages())if(page!==guide&&page!==hub&&page!==source&&page!==target&&page.url()==='about:blank')await page.close();
  receipt.result='READY_FOR_USER';receipt.expectedStartCount=count;receipt.tabs=['Instructions','Account','A — Save here','B — Restore here'];
  await save();await source.bringToFront();completed=true;
  console.log('REVIEW=READY; WORKERS=2/2; FIXTURE_SAVE_WRITES=0; EXISTING_BROWSERS_UNTOUCHED; PRODUCTION_UNCHANGED');
  console.log('A='+SOURCE);console.log('B='+TARGET);console.log('GUIDE='+guidePath);
  await new Promise(resolve=>context.once('close',resolve));
 }catch(error){receipt.result='FAIL';receipt.failure=error.message;await save();throw error;}
 finally{if(temporary||!completed)await context.close().catch(()=>{});if(temporary)await rm(profile,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
