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
const label=process.env.ATLAS_PERF_LABEL||'send-probe-r5';
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


 const session=await c.newCDPSession(p);await session.send('Performance.enable');await session.send('Profiler.enable');const errors=[];
 const clean=s=>s.replace(/(?:https?|blob|data):\S+/g,'[URL]').slice(0,250);
 p.on('console',m=>{if(['error','warning'].includes(m.type())&&errors.length<60){const e={type:m.type(),message:clean(m.text())};errors.push(e);console.log('SITE_DIAGNOSTIC',JSON.stringify(e))}});
 p.on('pageerror',e=>{const x={type:'pageerror',name:e.name,message:clean(e.message)};errors.push(x);console.log('SITE_DIAGNOSTIC',JSON.stringify(x))});
 const box=p.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill('https://chatgpt.com/');await box.press('Enter');
 const editor='#prompt-textarea:visible,[contenteditable=true][role=textbox]:visible,textarea[placeholder*=Ask]:visible,input[placeholder*=Ask]:visible';
 let site;for(let i=0;i<360;i++){if(await p.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Continue here',exact:true}).click();for(const f of p.frames().slice(1)){if(await f.locator(editor).count().catch(()=>false)){site=f;break}}if(site)break;await p.waitForTimeout(500)}if(!site)throw Error('Guest composer not loaded');const composer=site.locator(editor).first();await p.waitForTimeout(3000);
 console.log('PROXY_COMPOSER_READY');await p.screenshot({path:join(E,'proxy-send-ready.png')});await session.send('Emulation.setCPUThrottlingRate',{rate:4});await session.send('Profiler.start');
 watchdog=setTimeout(async()=>{console.log('PROXY_SEND_WATCHDOG_HANG');await writeFile(join(E,'PROXY_SEND_PROBE.json'),JSON.stringify({result:'HANG',errors},null,2));const capture=session.send('Profiler.stop').then(({profile})=>writeFile(join(E,'private-diagnostics/proxy-send-hang.cpuprofile'),JSON.stringify(profile),{mode:0o600})).catch(()=>{});await session.send('Runtime.terminateExecution').catch(()=>{});await Promise.race([capture,new Promise(r=>setTimeout(r,3000))]);await browser.close()},75000);
 await composer.fill('Explain binary search in two sentences.');console.log('PROXY_FILLED');await site.getByRole('button',{name:'Send message',exact:true}).click();console.log('PROXY_SEND_CLICKED');
 await p.waitForTimeout(12000);const state=await site.evaluate(()=>({title:document.title,characters:document.body.innerText.length,paragraphs:document.querySelectorAll('p').length,editors:document.querySelectorAll('textarea').length}));console.log('PROXY_AFTER_SEND',JSON.stringify(state));await p.screenshot({path:join(E,'proxy-send-reply.png')});await composer.click();await composer.fill('Unsent responsiveness draft');console.log('PROXY_DRAFT_TYPED');const{profile}=await session.send('Profiler.stop');await writeFile(join(E,'private-diagnostics/proxy-send.cpuprofile'),JSON.stringify(profile),{mode:0o600});await writeFile(join(E,'PROXY_SEND_PROBE.json'),JSON.stringify({result:'INTERACTIONS_RESPONDED',state,errors},null,2));
 await c.close();
}finally{clearTimeout(watchdog);await browser.close()}
