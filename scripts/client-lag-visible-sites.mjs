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
const label=process.env.ATLAS_PERF_LABEL||'visible-r5';
const email='client-public-'+label+'@atlas-lab.example';
await pool.query("INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),'Dedicated synthetic client performance benchmark') ON CONFLICT(normalized_email) DO NOTHING",[email]);
const user=(await pool.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[email])).rows[0];
if(user.role!=='user'||user.status!=='active')throw Error('Unexpected synthetic role');
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,SOURCE]);await pool.end();
const options=reviewOptions({executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:false});
const browser=await chromium.launch(options);const results=[];
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
 for(const target of (process.env.ATLAS_PERF_SITE?[process.env.ATLAS_PERF_SITE]:['https://chatgpt.com/','https://www.google.com/search?q=what+is+gravity'])){
  await session.send('Emulation.setCPUThrottlingRate',{rate:4});let reads=0,readNetworkMs=0;const listener=r=>{if(r.url().includes('/browse/cookies/result/')){reads++;readNetworkMs+=Math.max(0,r.timing().responseEnd)}};p.on('requestfinished',listener);
  const start=Date.now();await session.send('Profiler.start');const box=p.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill(target);await box.press('Enter');await p.waitForTimeout(30000);
  const chrome=await p.evaluate(()=>{const h=document.querySelector('.topbar');const k=Object.keys(h).find(k=>k.startsWith('__reactProps'));return {origin:location.origin,root:document.querySelector('.atlas').className,collapsed:document.querySelector('.atlas').dataset.railCollapsed,hover:matchMedia('(hover: hover) and (pointer: fine)').matches,pointerEnter:!!h[k]?.onPointerEnter,css:[...document.styleSheets].map(s=>s.href?.split('/').pop()).filter(Boolean)}});console.log('CHROME_GEOMETRY',JSON.stringify(chrome));const hover=[];for(let i=0;i<3;i++){await p.mouse.move(600,100);await p.waitForTimeout(400);const t=Date.now();await p.mouse.move(28,110);try{await p.locator('.sidebar-peeking').waitFor({timeout:3000});hover.push(Date.now()-t)}catch{hover.push(null)}await p.mouse.move(600,100);await p.waitForTimeout(500)}
  const {profile}=await session.send('Profiler.stop');const key=new URL(target).hostname.replace(/\W/g,'_');await writeFile(join(E,'public-'+label+'-'+key+'.cpuprofile'),JSON.stringify(profile));
  const count=new Map();for(const id of profile.samples||[])count.set(id,(count.get(id)||0)+1);const hot=profile.nodes.map(n=>({name:n.callFrame.functionName,url:n.callFrame.url.replace(/\?.*|#.*$/,''),samples:count.get(n.id)||0})).sort((a,b)=>b.samples-a.samples).slice(0,18);
  const longTasks=await p.evaluate(()=>perfLongTasks.splice(0));const metrics=(await session.send('Performance.getMetrics')).metrics.filter(x=>/TaskDuration|ScriptDuration|LayoutDuration|JSHeapUsedSize|Nodes/.test(x.name));const frames=[];for(const f of p.frames().slice(1)){const s=await f.evaluate(()=>({title:document.title,characters:document.body?.textContent?.length||0,inputs:document.querySelectorAll('input,textarea,[contenteditable=true]').length,challenge:/verify you are human|just a moment/i.test(document.title)})).catch(()=>null);if(s)frames.push(s)}
  await p.screenshot({path:join(E,'public-'+label+'-'+key+'.png'),timeout:12000});p.off('requestfinished',listener);const record={label,simulatedCookieResultLatencyMs:latency,target,CPUThrottle:4,viewport:{width:1366,height:768},elapsedMs:Date.now()-start,chrome,cookieReads:reads,cookieHTTPTimeMs:readNetworkMs,hoverOpenWallMs:hover,longTasks,metrics,frames,hot};results.push(record);await writeFile(join(E,'PUBLIC_SITES_'+label.toUpperCase()+'.json'),JSON.stringify({qualification:'Fresh public signed-out sites; actual local same-origin profile runtime and real upstream nodes; CPU 4x emulation, not physical N100 qualification',results},null,2));console.log(JSON.stringify({target,cookieReads:reads,hover,frames,hot:hot.slice(0,6)}));
 }
 await c.close();
}finally{await browser.close();}
