/** Mac Chrome integration/measurement only. This is not physical Chromebook or
 * Edge qualification, nor an external browsing/load test. */
import {createServer} from 'vite';import {chromium} from '@playwright/test';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {resolve} from 'node:path';import assert from 'node:assert/strict';
const evidence=resolve('evidence/local-first-backups-20261028');await mkdir(evidence,{recursive:true});
const report={command:'node tests/local-first-vite-performance-v2-browser.mjs',productionChanged:false,hardware:'Mac Chrome actual local Vite worker integration; no CPU emulation; not Chromebook qualification',samples:[],checks:{}};
const sourceFiles=['web/src/local-first-profile.ts','web/src/backup-v2-actor.ts','web/src/backup-v2-service.ts','runtime/backup-v2-worker.ts','runtime/backup-v2-capture.ts','runtime/backup-v2-indexeddb-source.ts','runtime/local-dirty-v2.ts','runtime/storage-native-worker-v2.ts','runtime/cookie-native-worker-v2.ts','runtime/replica-control-worker-v2.ts','tests/local-first-vite-performance-v2-browser.mjs'];
async function hashes(){return Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));}
report.sourceBefore=await hashes();
let vite,browser,manifest,uploadCount=0,publishCount=0;const identities=[];
async function body(req){let bytes=0,text='';for await(const part of req){bytes+=part.length;if(bytes>262144)throw Error('Fixture body limit');text+=part;}return text?JSON.parse(text):{};}
try{
 vite=await createServer({configFile:resolve('vite.config.ts'),server:{host:'127.0.0.1',port:0}});
 vite.middlewares.use(async(req,res,next)=>{try{
  if(req.url==='/__local-first-fixture'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Actual Vite local-first performance fixture</title><input id="draft" value="kept"><iframe id="site" srcdoc="<title>Persistent website frame</title><p>Local browsing fixture</p>"></iframe>');return;}
  const json=(data,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  const base='/api/hub/profile/backups/v2';
  if(req.url===base+'/checkpoints/latest'){json({checkpoint:null});return;}
  if(req.url===base+'/replicas'&&req.method==='POST'){const data=await body(req);json({...data,headCheckpointId:null,headSequence:0,adoptedThrough:0});return;}
  if(req.url?.startsWith(base+'/replicas/')&&req.url.endsWith('/checkpoints')){manifest=await body(req);identities.push(manifest.manifestDigest);json({checkpointId:manifest.checkpointId,status:'prepared',missingParts:manifest.namespaces.flatMap(n=>n.parts.map(p=>p.sha256))});return;}
  if(req.url?.includes('/parts/')&&req.method==='PUT'){for await(const _ of req){}uploadCount++;setTimeout(()=>json({stored:true}),1000);return;}
  if(req.url?.endsWith('/publish')){await body(req);publishCount++;json({error:{code:'HUB_UNAVAILABLE',message:'Controlled publication outage after held upload'}},503);return;}
  next();
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}});
 // Fixture routes precede Vite's SPA fallback; source/worker modules remain Vite-served.
 vite.middlewares.stack.unshift(vite.middlewares.stack.pop());
 await vite.listen();const address=vite.httpServer.address(),origin='http://127.0.0.1:'+address.port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browser=browser.version();
 const browserCDP=await browser.newBrowserCDPSession(),page=await browser.newPage(),cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/__local-first-fixture');
 await page.evaluate(async(runtimePath)=>{
  window.profileAPI=await import('/src/local-first-profile.ts');window.model=await import('/src/model.ts');window.contextAPI=await import(runtimePath+'/profile-context.ts');window.nativeAPI=await import(runtimePath+'/sandbox-local-owners-v2.ts');window.storageAPI=await import(runtimePath+'/sandbox-local-storage.ts');
  window.state={enabled:true,authenticated:true,csrf:'fixture',grant:{protocol:1,userId:'test',profileId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',branchId:'branch',sessionId:'session',contextId:'context',expiresAt:'2099-01-01T00:00:00Z',grantExpiresAt:'2099-01-01T00:00:00Z'}};
  window.profile=await profileAPI.createLocalFirstProfile(state,{current:()=>state,onStatus:()=>{},legacy:async()=>{throw Error('Unexpected legacy');}});await contextAPI.prepareProfileDocument('https://performance.example');
  window.owner=await nativeAPI.createLocalStorageOwnerV2({nativeV2:true,workerURL:runtimePath+'/sandbox-storage-worker.ts',localAuthority:profile.authority});
  const bound=await owner.bind({documentId:'performance_document_01234567',website:'https://performance.example',sessionId:'performance_session_012345678'});
  window.facades=await storageAPI.createSandboxStorageFacades({documentId:'performance_document_01234567',endpoint:bound.endpoint,port:bound.port,window,localOnly:true});storageAPI.rebindSandboxStorageFacades(facades,window);
  window.frame=document.querySelector('#site');window.frameWindow=frame.contentWindow;window.tasks=[];window.longObserver=new PerformanceObserver(list=>{for(const e of list.getEntries())tasks.push({startTime:e.startTime,duration:e.duration,name:e.name});});longObserver.observe({type:'longtask',buffered:false});
  window.inputPaintLatencies=[];document.querySelector('#draft').addEventListener('input',()=>{const at=performance.now();requestAnimationFrame(()=>inputPaintLatencies.push(performance.now()-at));});
  window.memoryStart=performance.now();document.querySelector('#draft').focus();
 },'/@fs'+resolve('runtime'));
 let workerMessageId=0;
 async function workerCommand(targetId,method){
  const attached=await browserCDP.send('Target.attachToTarget',{targetId,flatten:false}),id=++workerMessageId;
  try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{browserCDP.off('Target.receivedMessageFromTarget',receive);reject(Error('Worker CDP deadline'));},2000);
   function receive(event){if(event.sessionId!==attached.sessionId)return;const message=JSON.parse(event.message);if(message.id!==id)return;clearTimeout(timer);browserCDP.off('Target.receivedMessageFromTarget',receive);message.error?reject(Error(message.error.message)):resolve(message.result);}
   browserCDP.on('Target.receivedMessageFromTarget',receive);browserCDP.send('Target.sendMessageToTarget',{sessionId:attached.sessionId,message:JSON.stringify({id,method})}).catch(reject);
  });}finally{await browserCDP.send('Target.detachFromTarget',{sessionId:attached.sessionId}).catch(()=>{});}
 }
 async function sample(label){const info=await browserCDP.send('SystemInfo.getProcessInfo'),targets=await browserCDP.send('Target.getTargets'),ids=info.processInfo.map(p=>String(p.id));let rss='';try{rss=execFileSync('ps',['-o','pid=,rss=,comm=','-p',ids.join(',')],{encoding:'utf8'});}catch{}
  const rssRows=rss.trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m?{pid:Number(m[1]),rssKiB:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
  const workerHeaps=[];for(const target of targets.targetInfos.filter(t=>['worker','shared_worker','service_worker'].includes(t.type)))try{workerHeaps.push({targetId:target.targetId,url:target.url,heap:await workerCommand(target.targetId,'Runtime.getHeapUsage')});}catch(error){workerHeaps.push({targetId:target.targetId,error:error.message});}
  const memory=await cdp.send('Performance.getMetrics');report.samples.push({label,at:new Date().toISOString(),processes:info.processInfo,targets:targets.targetInfos.map(t=>({type:t.type,url:t.url,targetId:t.targetId})),workerHeaps,processRSS:rss,totalProcessRSSKiB:rssRows.reduce((n,r)=>n+r.rssKiB,0),rendererProcessRSSKiB:rssRows.filter(r=>info.processInfo.some(p=>p.id===r.pid&&p.type==='renderer')).reduce((n,r)=>n+r.rssKiB,0),performanceMetrics:memory.metrics});}
 await sample('baseline actors ready');
 await page.evaluate(async()=>{for(let n=0;n<100;n++){facades.localStorage.setItem('draft','initial-'+n);await new Promise(r=>setTimeout(r,0));}model.writeLocal('atlas.tabs',[{url:'https://performance.example/'}]);await new Promise(r=>setTimeout(r,400));});
 const cycles=20;for(let cycle=0;cycle<cycles;cycle++){
  await page.waitForTimeout(600);const beforeUploads=uploadCount;
  await page.evaluate(()=>{window.backupFlight=profile.backup.flush().catch(e=>({error:e.message}));});
  for(let spin=0;spin<300&&uploadCount===beforeUploads;spin++)await new Promise(r=>setTimeout(r,10));
  assert.ok(uploadCount>beforeUploads,'The fixture must reach a held upload before typing.');
  await page.locator('#draft').pressSequentially(' responsive-'+cycle,{delay:10});
  await page.evaluate(async(cycle)=>{for(let n=0;n<30;n++){facades.localStorage.setItem('draft',cycle+':'+n);await new Promise(r=>setTimeout(r,0));}await backupFlight;},cycle);
  await sample('held upload +503 cycle '+cycle);
 }
 report.checks=await page.evaluate(()=>({tasks,inputPaintLatencies,frameUnchanged:frame===document.querySelector('#site')&&frameWindow===frame.contentWindow,focus:document.activeElement.id,draft:facades.localStorage.getItem('draft'),text:document.querySelector('#draft').value,backup:profile.backup.status()}));
 report.uploadCount=uploadCount;report.publishCount=publishCount;report.publicationIdentities=identities;report.errors=errors;assert.equal(new Set(identities).size,1);
 report.unforcedSampleCount=report.samples.length;
 // Separate diagnostic only: never use forced collection as an unforced pass.
 await cdp.send('HeapProfiler.collectGarbage');const finalTargets=await browserCDP.send('Target.getTargets');for(const target of finalTargets.targetInfos.filter(t=>t.type==='worker'))await workerCommand(target.targetId,'HeapProfiler.collectGarbage').catch(()=>{});await page.waitForTimeout(1000);await sample('FORCED_GC_DIAGNOSTIC_NOT_ACCEPTANCE');
 assert.equal(report.checks.frameUnchanged,true);assert.equal(report.checks.focus,'draft');assert.equal(report.checks.draft,(cycles-1)+':29');assert.ok(report.checks.text.includes('responsive-'+(cycles-1)));assert.equal(uploadCount,cycles*manifest.namespaces.reduce((n,v)=>n+v.parts.length,0));assert.equal(publishCount,cycles);assert.deepEqual(errors,[]);
 // A measurement, not automatic approval: long tasks (if any) remain visible.
 report.sourceAfter=await hashes();report.sourceChangedDuringMeasurement=JSON.stringify(report.sourceBefore)!==JSON.stringify(report.sourceAfter);
 const latencies=report.checks.inputPaintLatencies.slice().sort((a,b)=>a-b);report.inputToNextRAFP95Ms=latencies[Math.max(0,Math.ceil(latencies.length*.95)-1)]??null;
 report.mainThreadLongTaskCount=report.checks.tasks.length;report.mainThreadMaxTaskMs=Math.max(0,...report.checks.tasks.map(t=>t.duration));assert.equal(report.sourceChangedDuringMeasurement,false,'Source files changed during performance measurement.');
  report.result='PASS_FUNCTIONAL_MEASUREMENTS_RECORDED';
 console.log('LOCAL_FIRST_VITE PASS real Vite workers held uploads/outage; focus/frame/drafts preserved; '+report.mainThreadLongTaskCount+' main-thread long tasks recorded');
}catch(error){report.result='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;}finally{await writeFile(resolve(evidence,'LOCAL_FIRST_VITE_PERFORMANCE.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();await vite?.close();}
