import assert from "node:assert/strict";
/** Fresh synthetic local account; existing lab services and real public HTTP.
 * No user's Chrome profile, cookies or conversation text is read or exported. */
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {certificateSPKI,reviewOptions} from './hub-continuity-review.mjs';
const E=resolve('evidence/client-lag-20261021');await mkdir(E,{recursive:true});
const lab=JSON.parse(execFileSync(process.execPath,['scripts/hub-lab.mjs','status'],{encoding:'utf8'}));
const SOURCE=lab.atlas, TARGET='https://fcddb74cd1c254d4d9b2f24c562f75569fake410.atlas.localhost:4280';
for(const x of lab.processes)process.kill(x.pid,0);
const state=JSON.parse(await readFile(join(lab.directory,'state.json')));
const require=createRequire(resolve('../Atlas-Link-Dispenser/apps/server/package.json'));const{Pool}=require('pg');
const pool=new Pool({connectionString:state.databaseUrl});
if(new URL(state.databaseUrl).pathname!=='/atlas_hub_lab_test')throw Error('Expected existing isolated lab database');
const email='client-continuity-r5f@atlas-lab.example';
await pool.query("INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),'Dedicated synthetic client performance benchmark') ON CONFLICT(normalized_email) DO NOTHING",[email]);
const user=(await pool.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[email])).rows[0];
if(user.role!=='user'||user.status!=='active')throw Error('Unexpected synthetic role');
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,SOURCE]);
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,TARGET]);await pool.end();
const options=reviewOptions({executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:true});
const {build:bundleProof}=createRequire(import.meta.resolve('vite'))('esbuild');
const proof=(await bundleProof({stdin:{contents:"export {nativeProfileQueue} from './runtime/profile-sync.ts'; export {decodePortableValue} from './runtime/hub-contracts.ts'",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const browser=await chromium.launch(options);const results=[];
const build=resolve(process.env.ATLAS_PERF_BUILD||'evidence/client-lag-20261021/modified/web-build');
try{
 const c=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1});
 await c.addInitScript(()=>{if(top!==window)return;localStorage.setItem('atlas.onboarded','true');localStorage.setItem('atlas.sidebarCollapsed','true');localStorage.setItem('atlas.settings',JSON.stringify({tabs:'sidebar',restore:true,mode:'dark',theme:'moss',motion:true}));window.perfLongTasks=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())perfLongTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})}catch{}});
 // Serve exact deployed r4 presentation, retaining the real lab APIs and node.
 await c.route(u=>[SOURCE,TARGET].includes(u.origin),async r=>{const u=new URL(r.request().url());if(u.pathname==='/'||u.pathname.startsWith('/assets/')||u.pathname.startsWith('/fonts')||u.pathname==='/favicon.svg'){
  try{const file=join(build,u.pathname==='/'?'index.html':u.pathname);return await r.fulfill({path:file})}catch{}
 }await r.continue();});
 await c.route('**/__performance-proof.js',r=>r.fulfill({contentType:'application/javascript',body:proof}));
 const hub=await c.newPage();await hub.goto(lab.hub);await hub.getByLabel('Email address',{exact:true}).fill(email);await hub.getByRole('button',{name:'Continue',exact:true}).click();const link=hub.getByRole('link',{name:'Open your verification file'});await link.waitFor();const file=await c.newPage();await file.goto(await link.getAttribute('href'));const text=await file.locator('body').innerText();await file.close();const code=text.match(/Verification code: (\d{6,8})/)?.[1];if(!code)throw Error('Missing local synthetic verification');await hub.getByRole('textbox',{name:/digit verification code/}).fill(code);await hub.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 let profileId;let acknowledgements=0;c.on('response',async r=>{const path=new URL(r.url()).pathname;if(path==='/api/hub/profile'&&r.request().method()==='GET'&&r.ok()){const m=await r.json().catch(()=>({}));if(m.profileId)profileId=m.profileId}if(path==='/api/hub/profile/commits'&&r.ok()){const ack=await r.json().catch(()=>({}));if(ack.acknowledged===true)acknowledgements++}});
 async function site(page){
  for(let i=0;i<600;i++){
   if(await page.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'Continue here',exact:true}).click();
   const handle=await page.locator('[data-frontend-runtime] > div:not([hidden]) > iframe').elementHandle({timeout:300}).catch(()=>null);
   const host=await handle?.contentFrame();
   for(const f of host?.childFrames()||[])if(await f.locator('#count').count().catch(()=>false))return f;
   await page.waitForTimeout(250);
  }throw Error('Fixture did not load');
 }
 async function navigate(page,url){const box=page.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill(url);await box.press('Enter');return site(page)}
 async function synced(page){
  assert.ok(profileId,'Actual authenticated profile manifest supplied profileId');
  await page.waitForFunction(async id=>{const{nativeProfileQueue}=await import('/__performance-proof.js');return (await nativeProfileQueue(indexedDB,id).list()).length===0},profileId,{timeout:45000});
  // Existing legacy-recovery notices intentionally replace the Synced label;
  // positive accepted changes plus the actual durable outbox are authoritative.
  assert.ok(acknowledgements>0,'Actual Hub changes acknowledged');
 }
 const b=await c.newPage();await b.goto(TARGET);await b.locator('.atlas').or(b.getByRole('button',{name:'Sign in',exact:true})).first().waitFor({timeout:60000});if(await b.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await b.getByRole('button',{name:'Sign in',exact:true}).click();await b.locator('.atlas').waitFor({timeout:60000});if(await b.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await b.getByRole('button',{name:'Use defaults',exact:true}).click();await b.goto(TARGET);await b.locator('.atlas.sidebar-adaptive').waitFor();
 console.log('CLOUD_IDB',JSON.stringify(await b.evaluate(async()=>{const {csrf}=await(await fetch('/api/hub/state')).json();const r=await fetch('/api/hub/profile/stream',{method:'POST',headers:{'content-type':'application/json','x-atlas-hub-csrf':csrf},body:JSON.stringify({namespace:{kind:'idb',origin:'http://fixture.localhost:4299',name:'atlas-lab-fixture'}})});const v=await r.json();const{decodePortableValue}=await import('/__performance-proof.js');return {HTTP:r.status,revision:v.revision,journal:v.journal?.map(j=>({revision:j.revision,payload:decodePortableValue(j.payload)}))}})));
 const restored=await navigate(b,'http://fixture.localhost:4299/storage?lease=probe');await restored.locator('#idb-read').click();await b.waitForTimeout(3000);console.log('DIRECT_IDB',await restored.evaluate(()=>new Promise(resolve=>{const deadline=setTimeout(()=>resolve({error:'DEADLINE'}),5000),r=indexedDB.open('atlas-lab-fixture',1);r.onerror=()=>{clearTimeout(deadline);resolve({error:r.error?.name})};r.onsuccess=()=>{clearTimeout(deadline);const db=r.result;const names=Array.from(db.objectStoreNames);if(!names.includes('records'))return resolve({names});const tx=db.transaction('records'),q=tx.objectStore('records').getAll();q.onsuccess=async()=>{resolve({names,records:await Promise.all(q.result.map(async x=>({count:x.count,bytes:Array.from(x.bytes),blob:await x.blob.text()})))});db.close()};q.onerror=()=>resolve({error:q.error?.name})}})));console.log('RESTORE_STATE',JSON.stringify({count:await restored.locator('#count').innerText(),idb:await restored.locator('#idb-result').innerText(),databases:await restored.evaluate(()=>indexedDB.databases())}));await b.screenshot({path:join(E,'continuity-restored-diagnostic.png')});await writeFile(join(E,'CONTINUITY_DIAGNOSTIC.json'),JSON.stringify({count:await restored.locator('#count').innerText(),idb:await restored.locator('#idb-result').innerText(),databases:await restored.evaluate(()=>indexedDB.databases())},null,2));if(!process.env.ATLAS_PERF_BUILD){await b.getByRole('button',{name:'New tab',exact:true}).first().click();await b.getByLabel('Atlas version 1.0',{exact:true}).waitFor();await b.screenshot({path:join(E,'new-tab-version-1.0.png')});}await c.close();}finally{await browser.close()}
