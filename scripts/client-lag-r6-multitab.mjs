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
const email='client-performance-'+(process.env.ATLAS_PERF_PROFILE||process.env.ATLAS_PERF_LABEL||'baseline')+'@atlas-lab.example';
await pool.query("INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),'Dedicated synthetic client performance benchmark') ON CONFLICT(normalized_email) DO NOTHING",[email]);
const user=(await pool.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[email])).rows[0];
if(user.role!=='user'||user.status!=='active')throw Error('Unexpected synthetic role');
await pool.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,id FROM links WHERE url=$2 AND NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=links.id AND active)',[user.id,SOURCE]);await pool.end();
const options=reviewOptions({executable:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:true});
const browser=await chromium.launch(options);const results=[];
const build=resolve(process.env.ATLAS_PERF_BUILD||'evidence/client-lag-followup-20261022/modified/web-build');
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
 const videoResponse=await fetch('https://media.w3.org/2010/05/sintel/trailer_hd.mp4');if(!videoResponse.ok)throw Error('HD fixture HTTP '+videoResponse.status);const videoBase64=Buffer.from(await videoResponse.arrayBuffer()).toString('base64');
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
 // Actual no-login games, not screenshot placeholders.
 const cookie=await open('Cookie Clicker','https://ozh.github.io/cookieclicker/');
 for(let i=0;i<120;i++){
   if(await cookie.getByText('English',{exact:true}).isVisible().catch(()=>false))await cookie.getByText('English',{exact:true}).click();
   if(await cookie.evaluate(()=>!!window.Game?.ready).catch(()=>false))break;
   await p.waitForTimeout(500);
 }
 const cookieReady=await cookie.evaluate(()=>!!window.Game?.ready).catch(()=>false);
 if(cookieReady){for(let i=0;i<8;i++)await cookie.locator('#bigCookie').click({position:{x:80,y:80}})}
 if(process.env.ATLAS_VISUAL_CAPTURE){await p.waitForTimeout(4000);await p.screenshot({path:join(E,'workload-cookie-clicker.png')});}
 console.log('WORKLOAD_COOKIE',JSON.stringify({ready:cookieReady,title:await cookie.title()}));
 // Hextris excluded: expired upstream TLS certificate, not an Atlas performance pass.
 const swooop=await open('SWOOOP 3D game','https://playcanv.as/e/p/JtL2iqIH/');for(let i=0;i<120;i++){if(await p.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Continue here',exact:true}).click();if(await swooop.locator('canvas').count())break;await p.waitForTimeout(500)}await p.waitForTimeout(2000);await swooop.locator('canvas').click({position:{x:624,y:590}});await p.waitForTimeout(2500);if(process.env.ATLAS_VISUAL_CAPTURE)await p.screenshot({path:join(E,'workload-swooop.png')});console.log('WORKLOAD_SWOOOP',JSON.stringify({title:await swooop.title(),canvases:await swooop.locator('canvas').count(),allFrames:p.frames().map(f=>({path:new URL(f.url()==='about:blank'?'http://blank/':f.url()).pathname.slice(0,32)}))}));
 const video=await open('1080-class video','http://fixture.localhost:4299/storage?performance=video');
 await video.getByRole('heading',{name:'Local storage fixture',exact:true}).waitFor();
 await video.evaluate(videoBase64=>{
   document.body.replaceChildren();document.title='Native video decode workload';
   const v=document.createElement('video');v.id='performance-video';v.controls=true;v.muted=true;v.loop=true;v.playsInline=true;v.style.cssText='width:100%;max-width:1280px';v.src=URL.createObjectURL(new Blob([Uint8Array.from(atob(videoBase64),c=>c.charCodeAt(0))],{type:'video/mp4'}));
   const b=document.createElement('button');b.textContent='Play video';b.onclick=()=>v.play().catch(e=>window.mediaFailure=e.name+':'+e.message);document.body.append(b,v);
 },videoBase64);await video.getByRole('button',{name:'Play video',exact:true}).click();
 await video.waitForFunction(()=>document.querySelector('video').currentTime>1||window.mediaFailure,null,{timeout:45000});if(await video.evaluate(()=>!!window.mediaFailure))throw Error('HD video failed: '+await video.evaluate(()=>window.mediaFailure));
 if(process.env.ATLAS_VISUAL_CAPTURE)await p.screenshot({path:join(E,'workload-video.png')});
 const audio=await open('Music soundtrack','http://fixture.localhost:4299/storage?performance=music');
 await audio.getByRole('heading',{name:'Local storage fixture',exact:true}).waitFor();
 await audio.evaluate(()=>{
   document.body.replaceChildren();document.title='Native soundtrack decode workload';const a=document.createElement('audio');a.id='performance-music';a.controls=true;a.loop=true;a.src='https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';const b=document.createElement('button');b.textContent='Play music';b.onclick=()=>a.play().catch(e=>window.mediaFailure=e.name+':'+e.message);document.body.append(b,a);
 });await audio.getByRole('button',{name:'Play music',exact:true}).click();await audio.waitForFunction(()=>document.querySelector('audio').currentTime>1||window.mediaFailure,null,{timeout:45000});if(await audio.evaluate(()=>!!window.mediaFailure))throw Error('Music failed: '+await audio.evaluate(()=>window.mediaFailure));
 if(process.env.ATLAS_VISUAL_CAPTURE)await p.screenshot({path:join(E,'workload-music.png')});
 const gl=await open('WebGL stress','http://fixture.localhost:4299/storage?performance=webgl');
 await gl.getByRole('heading',{name:'Local storage fixture',exact:true}).waitFor();
 await gl.evaluate(()=>{
   document.body.replaceChildren();document.title='WebGL shader workload';const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;canvas.style.cssText='width:100%;max-width:960px';document.body.append(canvas);const g=canvas.getContext('webgl');if(!g){window.glFailure='WebGL unavailable';return}
   const shader=(type,source)=>{const s=g.createShader(type);g.shaderSource(s,source);g.compileShader(s);if(!g.getShaderParameter(s,g.COMPILE_STATUS))throw Error(g.getShaderInfoLog(s));return s};const program=g.createProgram();g.attachShader(program,shader(g.VERTEX_SHADER,'attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}'));g.attachShader(program,shader(g.FRAGMENT_SHADER,'precision mediump float;uniform float t;void main(){vec2 uv=gl_FragCoord.xy/vec2(960.,540.);float v=0.;for(int i=1;i<20;i++){float f=float(i);v+=sin(uv.x*f*10.+t)*cos(uv.y*f*8.-t)/f;}gl_FragColor=vec4(sin(v+t)*.5+.5,cos(v)*.5+.5,uv.x,1.);}'));g.linkProgram(program);g.useProgram(program);const buffer=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,buffer);g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),g.STATIC_DRAW);const location=g.getAttribLocation(program,'position');g.enableVertexAttribArray(location);g.vertexAttribPointer(location,2,g.FLOAT,false,0,0);const time=g.getUniformLocation(program,'t');window.glFrames=0;function draw(t){g.uniform1f(time,t/1000);g.drawArrays(g.TRIANGLE_STRIP,0,4);window.glFrames++;requestAnimationFrame(draw)}requestAnimationFrame(draw);
 });await p.waitForTimeout(2000);
 if(process.env.ATLAS_VISUAL_CAPTURE)await p.screenshot({path:join(E,'workload-webgl.png')});
 const spotify=await open('Spotify public application','https://open.spotify.com/');await p.waitForTimeout(15000);
 const media=async()=>({video:await video.evaluate(()=>{const v=document.querySelector('video');return {time:v.currentTime,paused:v.paused,ready:v.readyState,width:v.videoWidth,height:v.videoHeight,quality:{totalVideoFrames:v.getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:v.getVideoPlaybackQuality().droppedVideoFrames},failure:window.mediaFailure}}),audio:await audio.evaluate(()=>{const a=document.querySelector('audio');return {time:a.currentTime,paused:a.paused,ready:a.readyState,failure:window.mediaFailure}}),cookie:await cookie.evaluate(()=>({ready:!!window.Game?.ready,ticks:window.Game?.T,visible:window.Game?.visible,documentVisibility:document.visibilityState,cookies:window.Game?.cookies})).catch(()=>({ready:false})),gl:await gl.evaluate(()=>({frames:window.glFrames,failure:window.glFailure}))});
 const startMedia=await media();
 const browserCDP=await browser.newBrowserCDPSession();
 for(const rate of (process.env.ATLAS_VISUAL_CAPTURE?[6]:[1,4,6])){
   await session.send('Emulation.setCPUThrottlingRate',{rate});
   await p.evaluate(()=>{window.perfLongTasks.splice(0);window.lagSamples=[];window.lagTick&&clearInterval(window.lagTick);let expected=performance.now()+50;window.lagTick=setInterval(()=>{const now=performance.now();lagSamples.push(Math.max(0,now-expected));expected=now+50},50)});
   const opens=[];
   for(let i=0;i<12;i++){await p.mouse.move(600,100);await p.waitForTimeout(350);const start=Date.now();await p.mouse.move(28,110);await p.locator('.sidebar-peeking').waitFor({timeout:15000});await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));opens.push(Date.now()-start)}
   await p.mouse.move(600,100);await p.waitForTimeout(350);
   const typing=[];const box=p.locator('input#omnibox:visible');await box.click();await box.fill('');for(const letter of 'atlas responsiveness proof'){const start=Date.now();await p.keyboard.type(letter);typing.push(Date.now()-start)}await box.press('Escape');
   const counters=await session.send('Memory.getDOMCounters');const metrics=(await session.send('Performance.getMetrics')).metrics.filter(x=>/JSHeapUsedSize|TaskDuration|Nodes/.test(x.name));
   const targets=(await browserCDP.send('Target.getTargets')).targetInfos;const snapshots=await media();const workerHeaps=await workerMemory(browserCDP);const timings=await p.evaluate(()=>({longTasks:perfLongTasks.splice(0),lag:lagSamples.splice(0)}));
   const record={workerHeaps,mediaRequests,label,rate,view:{width:1366,height:768,dpr:1},loadedTabs:setups.map(x=>({name:x.name,url:x.url})),hoverOpenMs:opens,hoverIntentMs:250,typingMs:typing,counters,metrics,workers:targets.filter(t=>t.type==='worker').length,serviceWorkers:targets.filter(t=>t.type==='service_worker').length,media:snapshots,timings};results.push(record);await writeFile(join(E,'MULTITAB_'+label.toUpperCase()+'.json'),JSON.stringify({qualification:'Actual public Cookie Clicker/SWOOOP/Spotify and actual node-proxied music plus preloaded public 1920x1080 H.264 native video decode with deterministic native WebGL load; fresh synthetic lab profile; CPU-throttled Mac, not physical Chromebook or whole-system 4GB emulation',startMedia,results},null,2));console.log('MULTITAB_SAMPLE',JSON.stringify({label,rate,workers:record.workers,hoverOpenMs:opens,typingMax:Math.max(...typing),video:snapshots.video,audio:snapshots.audio,cookie:snapshots.cookie,mediaRequests}));await p.screenshot({path:join(E,'multitab-'+label+'-'+rate+'x.png'),timeout:20000});
 }
 if(process.env.ATLAS_VISUAL_CAPTURE){
  await p.mouse.move(800,100);await p.waitForTimeout(400);await p.getByRole('tab',{name:/cookies - Cookie Clicker/}).first().click();await p.mouse.move(800,100);await p.waitForTimeout(2500);console.log('COOKIE_RETURN',await cookie.evaluate(()=>({ready:!!Game.ready,visible:Game.visible,state:document.visibilityState,ticks:Game.T,cookies:Game.cookies})));await p.screenshot({path:join(E,'workload-cookie-clicker-return.png')});
  await p.getByRole('tab',{name:'SWOOOP',exact:true}).first().click();await p.waitForTimeout(2500);await p.screenshot({path:join(E,'workload-swooop-return.png')});
 }
 await p.evaluate(()=>clearInterval(window.lagTick));
 await c.close();
}finally{await browser.close();}
