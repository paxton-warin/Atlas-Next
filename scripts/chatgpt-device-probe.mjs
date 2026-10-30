/** Fresh synthetic local account; existing lab services and real public HTTP.
 * No user's Chrome profile, cookies or conversation text is read or exported. */
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {certificateSPKI,reviewOptions} from './hub-continuity-review.mjs';
const E=resolve('evidence/chatgpt-halt-20261022');await mkdir(E,{recursive:true});
const lab=JSON.parse(execFileSync(process.execPath,['scripts/hub-lab.mjs','status'],{encoding:'utf8'}));
const SOURCE=lab.atlas;
for(const x of lab.processes)process.kill(x.pid,0);
const state=JSON.parse(await readFile(join(lab.directory,'state.json')));
const require=createRequire(resolve('../Atlas-Link-Dispenser/apps/server/package.json'));const{Pool}=require('pg');
const pool=new Pool({connectionString:state.databaseUrl});
if(new URL(state.databaseUrl).pathname!=='/atlas_hub_lab_test')throw Error('Expected existing isolated lab database');
const label=process.env.ATLAS_PERF_LABEL||'halt-baseline-'+Date.now();
const email='client-public-'+label+'@atlas-lab.example';
await pool.query("INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),'Dedicated synthetic client performance benchmark') ON CONFLICT(normalized_email) DO NOTHING",[email]);
const user=(await pool.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[email])).rows[0];
if(user.role!=='user'||user.status!=='active')throw Error('Unexpected synthetic role');
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,SOURCE]);await pool.end();
const options=reviewOptions({executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:false});
if(process.env.ATLAS_HEAP_CAP)options.args.push('--js-flags=--max-old-space-size='+Number(process.env.ATLAS_HEAP_CAP));const browser=await chromium.launch(options);const results=[];let watchdog;
const build=resolve(process.env.ATLAS_PERF_BUILD||'evidence/client-lag-followup-20261022/release/web');
try{
 const c=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1,userAgent:process.env.ATLAS_CHROMEOS?'Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36':undefined});
 await c.addInitScript(()=>{if(top!==window)return;localStorage.setItem('atlas.onboarded','true');localStorage.setItem('atlas.sidebarCollapsed','true');localStorage.setItem('atlas.settings',JSON.stringify({tabs:'sidebar',restore:true,mode:'dark',theme:'moss',motion:true}));window.perfLongTasks=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())perfLongTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})}catch{}});
 // Serve exact deployed r4 presentation, retaining the real lab APIs and node.
 await c.route(SOURCE+'/**',async r=>{const u=new URL(r.request().url());if(u.pathname==='/'||u.pathname.startsWith('/assets/')||u.pathname.startsWith('/fonts')||u.pathname==='/favicon.svg'){
  try{const file=join(build,u.pathname==='/'?'index.html':u.pathname);return await r.fulfill({path:file})}catch{}
 }await r.continue();});
 const latency=Number(process.env.ATLAS_RPC_LATENCY||0);
 if(latency)await c.route(SOURCE+'/browse/cookies/result/**',async r=>{await new Promise(resolve=>setTimeout(resolve,latency));await r.continue()});
 const hub=await c.newPage();await hub.goto(lab.hub);await hub.getByLabel('Email address',{exact:true}).fill(email);await hub.getByRole('button',{name:'Continue',exact:true}).click();const link=hub.getByRole('link',{name:'Open your verification file'});await link.waitFor();const file=await c.newPage();await file.goto(await link.getAttribute('href'));const text=await file.locator('body').innerText();await file.close();const code=text.match(/Verification code: (\d{6,8})/)?.[1];if(!code)throw Error('Missing local synthetic verification');await hub.getByRole('textbox',{name:/digit verification code/}).fill(code);await hub.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 const p=await c.newPage();p.on('response',async r=>{if(new URL(r.url()).pathname.includes('/controller/session')&&r.ok()){const v=await r.json().catch(()=>({}));if(v.node)console.log('NODE',v.node.name)}});p.setDefaultTimeout(20000);await p.goto(SOURCE);await p.locator('.atlas').or(p.getByRole('button',{name:'Sign in',exact:true})).first().waitFor({timeout:60000});if(await p.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.locator('.atlas').waitFor({timeout:60000});if(await p.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Use defaults',exact:true}).click();
 await p.goto(SOURCE);await p.locator('.atlas.sidebar-adaptive').waitFor({timeout:30000});


 const session=await c.newCDPSession(p);await session.send('Performance.enable');const errors=[];
 const clean=s=>s.replace(/(?:https?|blob|data):\S+/g,'[URL]').slice(0,1500);
 p.on('console',m=>{if(['error','warning'].includes(m.type())&&errors.length<300){const e={type:m.type(),message:clean(m.text())};errors.push(e);console.log('SITE_DIAGNOSTIC',JSON.stringify(e))}});
 p.on('pageerror',e=>{const x={type:'pageerror',name:e.name,message:clean(e.message)};errors.push(x);console.log('SITE_DIAGNOSTIC',JSON.stringify(x))});
 const responses={};p.on('response',r=>{if(r.status()>=400){const url=new URL(r.url());const path=url.pathname.startsWith('/~/')?'proxy-resource':/^\/[a-f0-9-]{36}$/.test(url.pathname)?'unrewritten-uuid':url.pathname;const k=r.status()+':'+path;responses[k]=(responses[k]||0)+1}}); const box=p.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill('https://chatgpt.com/');await box.press('Enter');
 const editor='#prompt-textarea:visible,[contenteditable=true][role=textbox]:visible,textarea[placeholder*=Ask]:visible,input[placeholder*=Ask]:visible';
 let site;for(let i=0;i<100;i++){if(await p.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Continue here',exact:true}).click();for(const f of p.frames().slice(1)){if(await f.locator(editor).count().catch(()=>false)){site=f;break}}if(site)break;await p.waitForTimeout(500)}if(!site)throw Error('Guest composer not loaded');const composer=site.locator(editor).first();await p.waitForTimeout(3000);
 console.log('PROXY_COMPOSER_READY');
 const rate=Number(process.env.ATLAS_CPU_RATE||1);await session.send('Emulation.setCPUThrottlingRate',{rate});
 const timeline=[];let phase='start',finished=false;const mark=(event,data={})=>{const x={event,phase,time:Date.now(),...data};timeline.push(x);console.log('PROBE',JSON.stringify(x));if(typeof arm==='function')arm()};
 const dump=async(result)=>writeFile(join(E,'BASELINE_'+label+'.json'),JSON.stringify({result,CPUThrottle:rate,timeline,errors,responses},null,2));
 const halt=async()=>{mark('WATCHDOG_HALT');await dump('HALT');const capture=session.send('Profiler.enable').then(()=>session.send('Profiler.start')).then(()=>new Promise(r=>setTimeout(r,5000))).then(()=>session.send('Profiler.stop')).then(({profile})=>writeFile(join(E,'private-diagnostics/halt-'+label+'.cpuprofile'),JSON.stringify(profile),{mode:0o600})).catch(()=>{});await Promise.race([capture,new Promise(r=>setTimeout(r,8000))]);await session.send('Runtime.terminateExecution').catch(()=>{});await browser.close()}; const arm=()=>{clearTimeout(watchdog);watchdog=setTimeout(halt,30000)};arm();
 await p.screenshot({path:join(E,'baseline-ready-'+label+'.png')});
 const probe=async(name)=>{phase=name;const start=performance.now();const state=await site.evaluate(()=>({characters:document.body.innerText.length,paragraphs:document.querySelectorAll('p').length,editors:document.querySelectorAll('textarea').length}));mark('heartbeat',{latency:performance.now()-start,...state,heap:await session.send('Runtime.getHeapUsage')});return state};
 phase='send-long';await composer.fill('Write an approximately 1500-word tutorial on binary search, with twelve numbered sections, worked examples, a comparison table, pseudocode, and mathematical equations.');await site.getByRole('button',{name:'Send message',exact:true}).click();mark('SENT');
 await composer.focus();const typed=[];
 for(let i=0;i<20;i++){
  await p.waitForTimeout(1500);await probe('stream-'+i);
  const begin=performance.now();await p.keyboard.type(' x');typed.push(performance.now()-begin);mark('typing',{latency:typed.at(-1)});
  if(i===4||i===12){await p.mouse.move(28,110);await p.waitForTimeout(350);await p.mouse.move(800,100);mark('sidebar-hover')}
 }
 phase='wait-first-reply';for(let k=0;k<90;k++){if(await site.getByRole('button',{name:'Send message',exact:true}).count())break;await p.waitForTimeout(1000);await probe('wait-first-'+k)} phase='follow-up';await composer.fill('Now give a worked JavaScript example and explain the edge cases.');await site.getByRole('button',{name:'Send message',exact:true}).click();mark('SENT_FOLLOW_UP');
 for(let i=0;i<20;i++){await p.waitForTimeout(1500);await probe('follow-'+i);if(i%4===0){const begin=performance.now();await p.keyboard.type(' draft');mark('typing',{latency:performance.now()-begin})}}
 await p.screenshot({path:join(E,'baseline-replies-'+label+'.png')});
 await dump('COMPLETED');clearTimeout(watchdog);console.log('BASELINE=COMPLETED');
 await c.close();
}finally{clearTimeout(watchdog);await browser.close()}
