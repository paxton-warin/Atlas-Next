import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const E=process.env.ATLAS_DIAGNOSTIC_OUT||'evidence/client-device-20261022';const native=process.env.ATLAS_NATIVE==='1',cpu=Number(process.env.ATLAS_CPU_RATE||1);await mkdir(E,{recursive:true});
const f=JSON.parse(await readFile(process.env.ATLAS_DIAGNOSTIC_FIXTURE||'/var/folders/8c/_1mbhvpn6jj56rmbk2q8rqfc0000gn/T/atlas-prod-control-28bp5huw/production-smoke-fixture.private.json','utf8'));
if(!/smoke|synthetic|perf|test|example/i.test(f.email))throw Error('A dedicated synthetic fixture is required');
if(!native){const sr=await fetch(f.hub+'/api/session',{headers:{cookie:'ald_session='+f.token}});if(!(await sr.json()).user)throw Error('Synthetic fixture session expired; no browser launched')}
const browser=await chromium.launch({headless:process.env.ATLAS_HEADED!=="1",args:[],executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const deadline=setTimeout(()=>{console.log('DIAGNOSTIC_DEADLINE');void browser.close()},180000);
const c=await browser.newContext({viewport:{width:1366,height:768}});const results=[],timing=[],errors=[];let phase='authorization';
if(!native)await c.addCookies([{name:'ald_session',value:f.token,url:f.hub,httpOnly:true,secure:true,sameSite:'Strict'},{name:'ald_csrf',value:f.csrf,url:f.hub,secure:true,sameSite:'Strict'}]);
const p=await c.newPage();p.setDefaultTimeout(12000);const cdp=await c.newCDPSession(p);await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});p.on('pageerror',e=>{if(errors.length<100)errors.push({phase,name:e.name,message:e.message.replace(/(?:https?|blob):\/\/\S+/g,'[URL]').slice(0,400)})});p.on('console',m=>{if(m.type()==='error'&&errors.length<100)errors.push({phase,name:'console',message:m.text().replace(/(?:https?|blob):\/\/\S+/g,'[URL]').slice(0,400)})});
const route=r=>{const u=new URL(r.url());if(u.origin!==new URL(f.a).origin)return 'external';let q=u.pathname;if(q.startsWith('/~/'))return '/~/[website-resource]';q=q.replace(/\/[a-f0-9-]{36,}(?=\/|$)/g,'/*');if(q.startsWith('/assets/'))q='/assets/*';if(q.startsWith('/browse/cookies/result/'))q='/browse/cookies/result/*';if(q.startsWith('/browse/storage/commit/'))q='/browse/storage/commit/*';if(q.startsWith('/browse/runtime/'))q='/browse/runtime/*';return q};
p.on('requestfinished',r=>{const t=r.timing();if(timing.length<2000)timing.push({phase,route:route(r),durationMs:t.responseEnd,method:r.method()})});
const record=async()=>writeFile(E+'/NAVIGATION_LIVE.json',JSON.stringify({checkedAt:new Date().toISOString(),kind:'One sequential headed browsing observation; CPU throttling is not physical Chromebook qualification',native,cpu,phase,results,errors,requests:timing},null,2));
try{
 const start=performance.now();if(!native){await p.goto(f.a,{waitUntil:'domcontentloaded'});
 for(let i=0;i<180;i++){
  if(i%20===0)console.log('ENTRY_PROGRESS',i);
  if(await p.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Sign in',exact:true}).click();
  if(await p.locator('.atlas').count()&&await p.locator('.atlas').isVisible().catch(()=>false))break;
  await p.waitForTimeout(500);
 }
 await p.locator('.atlas').waitFor({timeout:45000});
 if(await p.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Use defaults',exact:true}).click();
 results.push({site:'Atlas entry',milliseconds:performance.now()-start,result:'ready'});console.log('ENTRY_READY',Math.round(performance.now()-start));}
 for(const target of [{site:'Google',url:'https://www.google.com/',selector:'textarea[name=q],input[name=q]'}]){
  phase=target.site;await cdp.send('Profiler.enable');await cdp.send('Profiler.start');const begin=performance.now();if(native)await p.goto(target.url,{waitUntil:'domcontentloaded',timeout:45000});else{const box=p.locator('input#omnibox:visible,.hero-search input:visible').first();await box.fill(target.url);await box.press('Enter');}let found=false,handoff=false,blocked=false;
  for(let i=0;i<120;i++){
   if(await p.getByRole('button',{name:'Continue here',exact:true}).isVisible().catch(()=>false)){handoff=true;await p.getByRole('button',{name:'Continue here',exact:true}).click()}
   for(const frame of (native?p.frames():p.frames().slice(1))){
    if(await frame.locator(target.selector).count().catch(()=>0)){
     if(target.site==='CookieClicker'){if(await Promise.race([frame.evaluate(()=>!!globalThis.Game?.ready).catch(()=>false),new Promise(r=>setTimeout(()=>r(false),1500))])){found=true;break}}else if(target.site!=='Example'||await frame.locator('body').textContent({timeout:500}).then(t=>/documentation examples/i.test(t||'')).catch(()=>false)){found=true;break}
    }
    if(target.site==='ChatGPT')blocked=await frame.locator('body').textContent({timeout:500}).then(t=>/Verify you are human|Checking your browser|Just a moment/i.test(t||'')).catch(()=>false);
   }
   if(found)break;await p.waitForTimeout(500);
  }
  const states=[];for(const frame of (native?p.frames():p.frames().slice(1))){const x=await Promise.race([frame.evaluate(()=>({title:document.title,bytes:document.body?.textContent?.length||0,game:typeof Game==='object',ready:typeof Game==='object'&&!!Game.ready,verification:location.search.includes('__cf_chl')||/Just a moment|Verify you are human/.test(document.title)})).catch(()=>null),new Promise(r=>setTimeout(()=>r(null),1500))]);if(x)states.push(x)}const {profile}=await cdp.send('Profiler.stop');const counts=new Map();for(const id of profile.samples||[])counts.set(id,(counts.get(id)||0)+1);const hot=profile.nodes.map(n=>({fn:n.callFrame.functionName,url:n.callFrame.url.includes('/~/')?'website-resource':n.callFrame.url.replace(/https?:\/\/[^/]+/g,'').split('?')[0],line:n.callFrame.lineNumber,samples:counts.get(n.id)||0})).sort((a,b)=>b.samples-a.samples).slice(0,35);await writeFile(E+'/CPU_'+target.site+'.json',JSON.stringify({cpu,native,hot,totalSamples:(profile.samples||[]).length},null,2));console.log('CPU_HOT',target.site,JSON.stringify(hot.slice(0,12)));const row={site:target.site,milliseconds:performance.now()-begin,result:found?'content-visible':blocked?'upstream-verification':'not-visible',handoff,states};results.push(row);console.log('OPENING',JSON.stringify(row));
  await p.screenshot({path:E+'/opening-'+target.site.toLowerCase()+'.png',fullPage:true});await record();
 }
 phase='complete';await record();
}catch(e){results.push({site:phase,result:'diagnostic-failed',message:e.message.replace(/https?:\/\/\S+/g,'[URL]')});await record();console.error('DIAGNOSTIC_FAILED',phase,e.message.replace(/https?:\/\/\S+/g,'[URL]'));process.exitCode=1}finally{clearTimeout(deadline);await browser.close()}
