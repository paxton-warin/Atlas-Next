/** Fresh synthetic local account; existing lab services and real public HTTP.
 * No user's Chrome profile, cookies or conversation text is read or exported. */
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {certificateSPKI,reviewOptions} from './hub-continuity-review.mjs';
const E=resolve('evidence/client-lag-followup-20261022');await mkdir(E,{recursive:true});
const lab=JSON.parse(execFileSync(process.execPath,['scripts/hub-lab.mjs','status'],{encoding:'utf8'}));
const SOURCE=lab.atlas;
for(const x of lab.processes)process.kill(x.pid,0);
const state=JSON.parse(await readFile(join(lab.directory,'state.json')));
const require=createRequire(resolve('../Atlas-Link-Dispenser/apps/server/package.json'));const{Pool}=require('pg');
const pool=new Pool({connectionString:state.databaseUrl});
if(new URL(state.databaseUrl).pathname!=='/atlas_hub_lab_test')throw Error('Expected existing isolated lab database');
const label=process.env.ATLAS_PERF_LABEL||'dom-probe-r5';
const email='client-public-'+label+'@atlas-lab.example';
await pool.query("INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),'Dedicated synthetic client performance benchmark') ON CONFLICT(normalized_email) DO NOTHING",[email]);
const user=(await pool.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[email])).rows[0];
if(user.role!=='user'||user.status!=='active')throw Error('Unexpected synthetic role');
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,SOURCE]);await pool.end();
const options=reviewOptions({executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:false});
const browser=await chromium.launch(options);const results=[];let watchdog;
const build=resolve(process.env.ATLAS_PERF_BUILD||'evidence/client-lag-20261021/modified/web-build');
try{
 const c=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1});
 await c.addInitScript(()=>{if(top!==window)return;localStorage.setItem('atlas.onboarded','true');localStorage.setItem('atlas.sidebarCollapsed','true');localStorage.setItem('atlas.settings',JSON.stringify({tabs:'sidebar',restore:true,mode:'dark',theme:'moss',motion:true}));window.perfLongTasks=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())perfLongTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})}catch{}});
 // Serve exact deployed r4 presentation, retaining the real lab APIs and node.
 await c.route(SOURCE+'/**',async r=>{const u=new URL(r.request().url());if(u.pathname==='/'||u.pathname.startsWith('/assets/')||u.pathname.startsWith('/fonts')||u.pathname==='/favicon.svg'){
  try{const file=join(build,u.pathname==='/'?'index.html':u.pathname);return await r.fulfill({path:file})}catch{}
 }await r.continue();});
 const latency=Number(process.env.ATLAS_RPC_LATENCY||0);
 if(latency)await c.route(SOURCE+'/browse/cookies/result/**',async r=>{await new Promise(resolve=>setTimeout(resolve,latency));await r.continue()});
 const hub=await c.newPage();await hub.goto(lab.hub);await hub.getByLabel('Email address',{exact:true}).fill(email);await hub.getByRole('button',{name:'Continue',exact:true}).click();const link=hub.getByRole('link',{name:'Open your verification file'});await link.waitFor();const file=await c.newPage();await file.goto(await link.getAttribute('href'));const text=await file.locator('body').innerText();await file.close();const code=text.match(/Verification code: (\d{6,8})/)?.[1];if(!code)throw Error('Missing local synthetic verification');await hub.getByRole('textbox',{name:/digit verification code/}).fill(code);await hub.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 const p=await c.newPage();p.setDefaultTimeout(20000);await p.goto(SOURCE);await p.locator('.atlas').or(p.getByRole('button',{name:'Sign in',exact:true})).first().waitFor({timeout:60000});if(await p.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.locator('.atlas').waitFor({timeout:60000});if(await p.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Use defaults',exact:true}).click();
 await p.goto(SOURCE);await p.locator('.atlas.sidebar-adaptive').waitFor({timeout:30000});

 const session=await c.newCDPSession(p);await session.send('Performance.enable');await session.send('Profiler.enable');
 const codes={},snapshots=[];let crashed=false;
 p.on('crash',()=>crashed=true);
 p.on('console',m=>{if(m.type()!=='error')return;for(const code of m.text().match(/QuotaExceededError|InvalidStateError|Cookie control backpressure|Cookie network operation failed|PROFILE_[A-Z_]+|storage_document_registration_failed/g)||[])codes[code]=(codes[code]||0)+1});
 const box=p.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill('https://chatgpt.com/');await box.press('Enter');
 console.log('CHATGPT_OPEN_REQUESTED');
 const editor='#prompt-textarea:visible,[contenteditable=true][role=textbox]:visible,textarea[placeholder*=Ask]:visible,input[placeholder*=Ask]:visible';
 let site;for(let i=0;i<360;i++){if(await p.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Continue here',exact:true}).click();for(const f of p.frames().slice(1)){if(await f.locator(editor).count().catch(()=>false)){site=f;break}}if(site)break;await p.waitForTimeout(500)}if(!site){await p.screenshot({path:join(E,'chatgpt-composer-failure.png')});console.log('CHATGPT_FRAME_STATES',JSON.stringify(await Promise.all(p.frames().slice(1).map(f=>f.evaluate(()=>({title:document.title,editors:[...document.querySelectorAll('input,textarea,[contenteditable]')].map(e=>({tag:e.tagName,id:e.id,role:e.getAttribute('role'),placeholder:e.getAttribute('placeholder')}))})).catch(()=>null)))));throw Error('ChatGPT composer did not load')}
 const composer=site.locator(editor).first();await composer.waitFor({state:'visible',timeout:30000});await p.waitForTimeout(4000);
 const identity=await site.evaluate(()=>{const element=document.createElement('div'),before={style:element.style===element.style,attributes:element.attributes===element.attributes};for(const[prototype,key]of[[HTMLElement.prototype,'style'],[Element.prototype,'attributes']]){const d=Object.getOwnPropertyDescriptor(prototype,key);if(!d?.get||!d.configurable)continue;const values=new WeakMap();Object.defineProperty(prototype,key,{...d,get(){if(values.has(this))return values.get(this);const value=d.get.call(this);values.set(this,value);return value}})}return{before,after:{style:element.style===element.style,attributes:element.attributes===element.attributes}}});console.log('DOM_IDENTITY_EXPERIMENT',JSON.stringify(identity));
 console.log('CHATGPT_COMPOSER_READY');await p.screenshot({path:join(E,'chatgpt-guest-ready.png')});
 await session.send('Emulation.setCPUThrottlingRate',{rate:4});
 await session.send('Profiler.start');watchdog=setTimeout(async()=>{console.log('CHATGPT_WATCHDOG_HANG');await writeFile(join(E,'CHATGPT_DOM_PROBE_HANG.json'),JSON.stringify({result:'HANG',experiment:'Stable DOM SameObject wrappers',identity},null,2));const capture=session.send('Profiler.stop').then(({profile})=>writeFile(join(E,'private-diagnostics/dom-probe-hang.cpuprofile'),JSON.stringify(profile),{mode:0o600})).catch(()=>{});await session.send('Runtime.terminateExecution').catch(()=>{});await Promise.race([capture,new Promise(r=>setTimeout(r,3000))]);await browser.close()},150000);
 const prompt='Write an approximately 1000-word tutorial on binary search, with eight numbered sections, worked examples, a comparison table, pseudocode, and a few mathematical equations.';
 await composer.fill(prompt);await composer.press('Enter');console.log('CHATGPT_PROMPT_SENT');
 const assistants=site.locator('[data-message-author-role="assistant"]');
 let answerChars=0;for(let i=0;i<120;i++){answerChars=await assistants.evaluateAll(es=>es.reduce((n,e)=>n+(e.textContent?.length||0),0)).catch(()=>0);if(answerChars>100)break;await p.waitForTimeout(500)}
 console.log('CHATGPT_RESPONSE_START',JSON.stringify({answerChars}));await p.screenshot({path:join(E,'chatgpt-dom-probe-after-input.png')});
 for(const rate of [4,6]){
  await session.send('Emulation.setCPUThrottlingRate',{rate});await p.evaluate(()=>perfLongTasks.splice(0));
  const hover=[];for(let i=0;i<12;i++){await p.mouse.move(700,100);await p.waitForTimeout(350);const start=Date.now();await p.mouse.move(28,110);await p.locator('.sidebar-peeking').waitFor({timeout:12000});hover.push(Date.now()-start)}await p.mouse.move(700,100);await p.waitForTimeout(350);
  const typing=[];await composer.click();await composer.fill('');for(const letter of 'Unsent synthetic responsiveness draft'){const start=Date.now();await p.keyboard.type(letter);typing.push(Date.now()-start)}
  const scrolling=[];for(let i=0;i<8;i++){const start=Date.now();await p.mouse.move(900,480);await p.mouse.wheel(0,i%2?-500:500);await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));scrolling.push(Date.now()-start)}
  const state=await assistants.evaluateAll(es=>({messages:es.length,characters:es.reduce((n,e)=>n+(e.textContent?.length||0),0)}));const tasks=await p.evaluate(()=>perfLongTasks.splice(0));const record={rate,hover,typing,scrolling,assistant:state,crashed,codes:{...codes},longTasks:tasks,modelReplyReceived:state.characters>100};snapshots.push(record);await p.screenshot({path:join(E,'chatgpt-conversation-'+rate+'x.png')});await writeFile(join(E,'CHATGPT_DOM_PROBE.json'),JSON.stringify({result:state.characters>100?'REPLY_RECEIVED_AND_INTERACTIONS_MEASURED':'NO_MODEL_REPLY',build:'deployed r5 exact candidate',mode:'Visible native Chrome; fresh synthetic Hub profile restored through real local Hub; actual public ChatGPT guest conversation, no website login',snapshots},null,2));console.log('CHATGPT_SAMPLE',JSON.stringify(record));
 }
 const{profile}=await session.send('Profiler.stop');await writeFile(join(E,'dom-probe.cpuprofile'),JSON.stringify(profile));
 console.log('CHATGPT_TEST_DONE');await c.close();
}finally{clearTimeout(watchdog);await browser.close()}
