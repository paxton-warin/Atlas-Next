import {workerMemory} from "./perf-worker-metrics.mjs";
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
const email='client-performance-remote-video@atlas-lab.example';
await pool.query("INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),'Dedicated synthetic client performance benchmark') ON CONFLICT(normalized_email) DO NOTHING",[email]);
const user=(await pool.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[email])).rows[0];
if(user.role!=='user'||user.status!=='active')throw Error('Unexpected synthetic role');
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,SOURCE]);await pool.end();
const options=reviewOptions({executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:true});
const browser=await chromium.launch(options);const results=[];
const build=resolve(process.env.ATLAS_PERF_BUILD||'evidence/client-lag-followup-20261022/release/web');
try{
 const c=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1});
 await c.addInitScript(()=>{if(top!==window)return;localStorage.setItem('atlas.onboarded','true');localStorage.setItem('atlas.sidebarCollapsed','true');localStorage.setItem('atlas.settings',JSON.stringify({tabs:'sidebar',restore:true,mode:'dark',theme:'moss',motion:true}));window.perfLongTasks=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())perfLongTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true})}catch{}});
 // Serve exact deployed r4 presentation, retaining the real lab APIs and node.
 await c.route(SOURCE+'/**',async r=>{const u=new URL(r.request().url());if(u.pathname==='/'||u.pathname.startsWith('/assets/')||u.pathname.startsWith('/fonts')||u.pathname==='/favicon.svg'){
  try{const file=join(build,u.pathname==='/'?'index.html':u.pathname);return await r.fulfill({path:file})}catch{}
 }await r.continue();});
 const hub=await c.newPage();await hub.goto(lab.hub);await hub.getByLabel('Email address',{exact:true}).fill(email);await hub.getByRole('button',{name:'Continue',exact:true}).click();const link=hub.getByRole('link',{name:'Open your verification file'});await link.waitFor();const file=await c.newPage();await file.goto(await link.getAttribute('href'));const text=await file.locator('body').innerText();await file.close();const code=text.match(/Verification code: (\d{6,8})/)?.[1];if(!code)throw Error('Missing local synthetic verification');await hub.getByRole('textbox',{name:/digit verification code/}).fill(code);await hub.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 const p=await c.newPage();p.setDefaultTimeout(20000);await p.goto(SOURCE);await p.locator('.atlas').or(p.getByRole('button',{name:'Sign in',exact:true})).first().waitFor({timeout:60000});if(await p.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.locator('.atlas').waitFor({timeout:60000});if(await p.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Use defaults',exact:true}).click();
 await p.goto(SOURCE);await p.locator('.atlas.sidebar-adaptive').waitFor({timeout:30000});
 const session=await c.newCDPSession(p);await session.send('Performance.enable');await session.send('Profiler.enable');
 const label=process.env.ATLAS_PERF_LABEL||'baseline';
 const mediaRequests=[];p.on('response',r=>{if(r.request().resourceType()==='media')mediaRequests.push({HTTP:r.status(),type:r.headers()['content-type'],length:r.headers()['content-length']})});
 const setups=[];
 async function visibleSite(){
   const hostElement=await p.locator('[data-frontend-runtime] > div:not([hidden]) > iframe').elementHandle();
   if(!hostElement)return;
   const host=await hostElement.contentFrame();
   return host?.childFrames().find(f=>f.url().includes('/~/app/'));
 }
 async function open(name,url){
   if(setups.length)await p.getByRole('button',{name:'New tab',exact:true}).first().click();
   const box=p.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill(url);await box.press('Enter');
   let f;for(let i=0;i<240;i++){if(await p.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Continue here',exact:true}).click();f=await visibleSite();if(f&&await f.locator('body').count().catch(()=>0))break;await p.waitForTimeout(250)}
   if(!f)throw Error('No site frame: '+name);
   setups.push({name,url,frame:f});await p.mouse.move(800,100);return f;
 }
 const video=await open('Actual proxied MP4 video','http://fixture.localhost:4299/storage?remote-video');await video.getByRole('heading',{name:'Local storage fixture',exact:true}).waitFor();await video.evaluate(()=>{document.body.replaceChildren();const v=document.createElement('video');v.controls=true;v.muted=true;v.loop=true;v.src='https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';v.style.cssText='width:100%;max-width:960px';window.mediaError='';v.onerror=()=>window.mediaError='Media error '+v.error?.code;const b=document.createElement('button');b.textContent='Play actual proxied video';b.onclick=()=>v.play().catch(e=>window.mediaError=e.name);document.body.append(b,v)});await video.getByRole('button',{name:'Play actual proxied video',exact:true}).click();await video.waitForFunction(()=>document.querySelector('video').currentTime>1||window.mediaError,null,{timeout:45000});await session.send('Emulation.setCPUThrottlingRate',{rate:6});await p.waitForTimeout(3000);const metrics=await video.evaluate(()=>{const v=document.querySelector('video');return{time:v.currentTime,paused:v.paused,width:v.videoWidth,height:v.videoHeight,ready:v.readyState,error:window.mediaError,totalVideoFrames:v.getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:v.getVideoPlaybackQuality().droppedVideoFrames}});if(metrics.error||metrics.paused||metrics.ready<3||metrics.width===0)throw Error('Actual proxied video did not play: '+JSON.stringify(metrics));await p.screenshot({path:join(E,'actual-proxied-video.png')});await writeFile(join(E,'ACTUAL_PROXIED_VIDEO.json'),JSON.stringify({result:'PASS',source:'Public MDN CC0 flower.mp4, actual browsing-node proxy; no blob/preloaded-byte substitution',CPUThrottle:6,metrics},null,2));console.log('ACTUAL_PROXIED_VIDEO=PASS',JSON.stringify(metrics));await c.close();}finally{await browser.close()}
