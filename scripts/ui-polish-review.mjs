import { chromium } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import assert from 'node:assert/strict';
const E=resolve('evidence/ui-polish-20261021'),mode=process.argv[2]||'modified',results=[],errors=[],services=[],temps=[];
let browser;
const math=String.raw`## Special unitary groups

The definition uses inline math \(SU(n)\).

\[ SU(n)=\{U\in GL_n(\mathbb C)\mid U^{\dagger}U=I,\ \det U=1\} \]

- **Key properties**
  - It is a compact, connected Lie group of dimension \(n^2-1\).
  - Its **fundamental group** is
    \[\pi_1\bigl(SU(n)\bigr)=0\quad\text{for }n\ge2.\]
    This group is simply connected.

Literal code: \`\(x^2\)\`.
`.replaceAll('\\`','`');
const session={enabled:true,authenticated:true,csrf:'synthetic-ui-fixture',grant:{protocol:1,userId:'fixture',profileId:'fixture',branchId:'fixture',sessionId:'fixture',contextId:'fixture'}};
const ticket={id:'ticket-1',subject:'Synthetic account question',status:'open',unread:1,updated_at:'2026-10-21T20:00:00Z'};
const messages=[{id:'1',author:'user',body:'How do I move my saved browser data?',public:true,created_at:'2026-10-21T20:00:00Z'},{id:'2',author:'admin',body:'Your acknowledged saves are available on your next Atlas link.',public:true,created_at:'2026-10-21T20:01:00Z'},{id:'3',author:'admin',body:'Synthetic private follow-up.',public:false,created_at:'2026-10-21T20:02:00Z'}];
async function shot(page,name){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});await page.screenshot({path:join(E,'screenshots',`${mode}-${name}.png`),fullPage:true,scale:'css'});}
async function seed(page){await page.addInitScript(({math})=>{if(window.top!==window)return;localStorage.setItem('atlas.onboarded','true');localStorage.setItem('atlas.settings',JSON.stringify({tabs:'sidebar',restore:true,mode:'dark',theme:'moss',motion:false}));localStorage.setItem('atlas.chats',JSON.stringify([{id:'math',title:'Nested list math',updated:1792600000000,messages:[{id:'a',role:'assistant',content:math,provider:'Groq',model:'synthetic reply'}]}]));},{math});}
async function apiMocks(page,{admin=false,signedOut=false,backend=false}={}){
 await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;
  const data=p.endsWith('/setup/status')?{initialized:true}:p.endsWith('/session')?{user:signedOut?null:{id:'fixture',email:'review@example.invalid',role:admin?'admin':'user'},csrfToken:'fixture'}:p.endsWith('/hub/config')?{enabled:true}:p.endsWith('/availability')?{sources:[]}:p.endsWith('/assignment')?{assignments:[]}:p.endsWith('/notifications')?{unread:12,notifications:[{id:'12',ticket_id:'ticket-1',subject:'Synthetic account question',read_at:null}]}:p.endsWith('/tickets')?{tickets:[ticket]}:p.endsWith('/tickets/ticket-1')?{ticket,messages}:p.endsWith('/ai/config')?{configured:true,provider:'Groq',model:'synthetic reply'}:null;
  if(data===null&&backend)return route.continue();
  await route.fulfill({json:data||{ok:true}});
 });
}
async function staticServer(root){const s=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname;const file=join(root,name==='/'?'index.html':name);let bytes;try{bytes=await readFile(file);}catch{bytes=await readFile(join(root,'index.html'));}res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.html':'text/html'}[extname(file)]||'text/html'));res.end(bytes);}catch{res.statusCode=404;res.end();}});await new Promise(r=>s.listen(0,'127.0.0.1',r));services.push({close:()=>new Promise(r=>s.close(r))});return `http://127.0.0.1:${s.address().port}`;}
try{
 await mkdir(join(E,'screenshots'),{recursive:true});browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const dir=await mkdtemp(join(tmpdir(),'atlas-polish-'));temps.push(dir);const app=await createApp({dataDir:dir,staticDir:join(E,mode,'Atlas-Next/web-build'),appOrigin:'http://localhost',runtimeOrigin:'http://127.0.0.1:1',hubOrigin:'',hubServiceSecret:'',nodesEnabled:false});await app.listen({host:'127.0.0.1',port:0});services.push(app);const atlas=`http://127.0.0.1:${app.server.address().port}`;
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const c=await browser.newContext({viewport}),p=await c.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.stack));await seed(p);await p.goto(atlas);await p.locator('.shortcuts').waitFor();await shot(p,`home-${viewport.width}`);
  const initials=await p.locator('.shortcut-target>span').allTextContents();if(mode==='modified')assert.deepEqual(initials,['G','Y','C','S']);
  await p.getByRole('button',{name:'Add shortcut',exact:true}).click();const dialog=p.getByRole('dialog',{name:'Add shortcut',exact:true});await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Khan Academy');await dialog.getByRole('textbox',{name:'Website',exact:true}).fill('khanacademy.org/math?q=1');await shot(p,`shortcut-form-${viewport.width}`);await dialog.getByRole('button',{name:'Add shortcut',exact:true}).click();
  if(mode==='modified'){
   await dialog.waitFor({state:'hidden'});const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('atlas.shortcuts')).at(-1));assert.equal(saved.url,'https://khanacademy.org/math?q=1');assert.equal(saved.symbol,'KA');assert.equal(await p.locator('.shortcut-target>span').last().textContent(),'KA');
   await p.getByRole('button',{name:'Add shortcut',exact:true}).click();await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Invalid');await dialog.getByRole('textbox',{name:'Website',exact:true}).fill('just a search');await dialog.getByRole('button',{name:'Add shortcut',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('atlas.shortcuts')).length),5);await shot(p,`shortcut-invalid-${viewport.width}`);
  }else{assert.equal(await dialog.getByRole('textbox',{name:'Website',exact:true}).evaluate(e=>e.validity.typeMismatch),true);}
  await dialog.getByRole('button',{name:'Close dialog'}).click();
  const menu=p.getByRole('button',{name:'Menu',exact:true});if(await menu.isVisible())await menu.click();await p.getByRole('navigation',{name:'Atlas pages'}).getByRole('button',{name:'AI',exact:true}).click();await p.locator('.chat-item').getByRole('button',{name:'Nested list math',exact:true}).click();await p.locator('.chat-message.assistant .katex').first().waitFor();await shot(p,`math-${viewport.width}`);
  const displays=await p.locator('.chat-message.assistant .katex-display').count();if(mode==='modified'){assert.equal(displays,2);assert.equal(await p.locator('.chat-message.assistant li .katex-display').count(),1);assert.equal(await p.locator('.katex-error').count(),0);}
  if(mode==='modified'&&viewport.width===1440){
   await p.route('**/api/ai/config',r=>r.fulfill({json:{configured:true,provider:'Groq',model:'synthetic reply'}}));await p.getByRole('button',{name:'Refresh AI connection'}).click();
   await p.evaluate(()=>{const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).endsWith('/api/ai/chat'))return Promise.resolve(new Response(new ReadableStream({start(controller){const encode=x=>new TextEncoder().encode(JSON.stringify(x)+'\n');controller.enqueue(encode({type:'source',provider:'Groq',model:'synthetic reply'}));controller.enqueue(encode({type:'delta',text:'- Streaming formula\n  \\[\\frac{1}{'}));window.finishMathReply=()=>{controller.enqueue(encode({type:'delta',text:'2}\\]'}));controller.enqueue(encode({type:'done'}));controller.close();};}}),{headers:{'Content-Type':'application/x-ndjson'}}));return original(...args);};});
   await p.route('**/api/ai/title',r=>r.fulfill({json:{title:'Streaming formula'}}));await p.getByRole('button',{name:'New chat',exact:true}).click();await p.getByRole('textbox',{name:'Message Atlas AI',exact:true}).fill('Render this formula');await p.getByRole('button',{name:'Send AI message',exact:true}).click();await p.getByRole('button',{name:'Stop reply',exact:true}).waitFor();await shot(p,'math-streaming');await p.evaluate(()=>window.finishMathReply());await p.locator('.chat-message.assistant .katex-display').waitFor();assert.equal(await p.locator('.katex-error').count(),0);await shot(p,'math-stream-complete');
  }
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);results.push({screen:'Atlas home, shortcut form and nested-list math',viewport,initials,displays,bareDomainAccepted:mode==='modified'});await c.close();
 }
 const hub=await staticServer(join(E,mode,'Atlas-Link-Dispenser/web-build'));
 for(const state of [{admin:true,width:1440,height:900},{admin:true,width:768,height:1024},{admin:true,width:390,height:844},{admin:false,width:1440,height:900},{signedOut:true,width:1440,height:900}]){
  const c=await browser.newContext({viewport:{width:state.width,height:state.height}}),p=await c.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.stack));await apiMocks(p,state);await p.goto(hub+(state.admin?'/?admin=support':state.signedOut?'/':'/?view=support'));await p.locator('.brand').first().waitFor();
  if(state.width===390)await p.getByRole('button',{name:'Menu',exact:true}).click();
  if(mode==='modified'){const mark=p.locator('.brand .atlas-brand-mark').first();await mark.waitFor({state:'visible'});const style=await mark.evaluate(e=>{const s=getComputedStyle(e);return{font:s.fontFamily,style:s.fontStyle,width:s.width,height:s.height,radius:s.borderRadius}});assert.deepEqual(style,{font:'Georgia, serif',style:'italic',width:'30px',height:'30px',radius:'10px'});}
  await shot(p,`hub-${state.signedOut?'sign-in':state.admin?'admin':'user'}-${state.width}`);
  if(!state.signedOut){if(state.width===390)await p.getByRole('button',{name:'Close menu',exact:true}).click({position:{x:state.width-4,y:20}});await p.locator('.hub-ticket').first().click();await p.locator('.hub-message').first().waitFor();const userLabel=await p.locator('.hub-message.user>small').innerText();if(mode==='modified')assert.ok(userLabel.startsWith(state.admin?'User ·':'You ·'));assert.equal(await p.locator('.hub-message.is-internal').count(),1);await shot(p,`ticket-${state.admin?'admin':'user'}-${state.width}`);results.push({screen:'Ticket author',state,userLabel});}
  await c.close();
 }

 if(mode==='modified'){
  for(const width of [1440,390]){
   const c=await browser.newContext({viewport:{width,height:900}}),p=await c.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.stack));await apiMocks(p);
   const id='11111111-2222-4333-8444-555555555555';let deletions=0,cloudDeleted=false,failDelete=true;
   await p.route('**/api/hub/profile',async r=>{if(r.request().method()==='DELETE'){deletions++;assert.deepEqual(r.request().postDataJSON(),{profileId:id,confirmation:'DELETE'});assert.equal(r.request().headers()['x-csrf-token'],'fixture');if(failDelete)return r.fulfill({status:503,json:{error:{message:'Synthetic temporary failure'}}});cloudDeleted=true;return r.fulfill({json:{acknowledged:true,deleted:true,localDeviceDataErased:false}});}return r.fulfill({json:{profile:cloudDeleted?null:{id,initialized:true,revision:12,bytes:1048576}}});});await p.route('**/api/hub/sessions',r=>r.fulfill({json:{sessions:[]}}));
   await p.goto(hub+'/?view=data');await p.getByRole('button',{name:'Delete cloud browser data…',exact:true}).click();const d=p.getByRole('dialog',{name:'Delete cloud browser data?',exact:true});await d.waitFor();assert.equal(await d.getByRole('button',{name:'Delete cloud data',exact:true}).isEnabled(),false);await shot(p,`cloud-delete-confirm-${width}`);await d.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(deletions,0);
   await p.getByRole('button',{name:'Delete cloud browser data…',exact:true}).click();await d.getByRole('textbox',{name:'Type DELETE to confirm',exact:true}).fill('DELETE');await d.getByRole('button',{name:'Delete cloud data',exact:true}).click();await d.getByRole('alert').filter({hasText:'Synthetic temporary failure'}).waitFor();assert.equal(cloudDeleted,false);await shot(p,`cloud-delete-error-${width}`);failDelete=false;await d.getByRole('button',{name:'Delete cloud data',exact:true}).click();await d.waitFor({state:'hidden'});await p.getByText('Cloud browser data deleted.',{exact:false}).waitFor();assert.equal(deletions,2);await shot(p,`cloud-delete-success-${width}`);results.push({screen:'User cloud data management',width,cancelRequests:0,failedDeleteRetained:true,confirmedDeleteAcknowledged:true});await c.close();
  }
  const c=await browser.newContext({viewport:{width:1440,height:900}}),p=await c.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.stack));await apiMocks(p,{admin:true});const user={id:'22222222-2222-4333-8444-555555555555',email:'member@example.invalid',role:'user',status:'active',created_at:'2026-10-21T20:00:00Z'};let deleted=false,calls=0;
  await p.route('**/api/admin/users?*',r=>r.fulfill({json:{users:deleted?[]:[user],pagination:{page:1,pageSize:50,total:deleted?0:1,totalPages:1}}}));await p.route('**/api/admin/users/'+user.id,r=>{if(r.request().method()==='DELETE'){calls++;deleted=true;return r.fulfill({json:{ok:true}});}return r.fulfill({json:{user,assignments:[],reports:[],verifications:[],sessions:[],usage:{week:0},counts:{assignments:0,reports:0,verifications:0,sessions:0}}});});
  await p.route('**/api/admin/users/'+user.id+'/activity?*',r=>r.fulfill({json:{items:[],pagination:{page:1,pageSize:50,total:0,totalPages:1}}}));
  await p.goto(hub+'/?admin=users');await p.getByRole('row').filter({hasText:user.email}).getByRole('button',{name:'Open',exact:true}).click();const d=p.getByRole('dialog',{name:user.email,exact:true});await d.getByRole('button',{name:'Delete user…',exact:true}).click();await d.getByRole('button',{name:'Permanently delete user',exact:true}).scrollIntoViewIfNeeded();assert.equal(await d.getByRole('button',{name:'Permanently delete user',exact:true}).isEnabled(),false);await shot(p,'admin-delete-confirm');await d.getByRole('button',{name:'Keep user',exact:true}).click();assert.equal(calls,0);await d.getByRole('button',{name:'Delete user…',exact:true}).click();await d.getByRole('textbox',{name:`Type ${user.email} to confirm`,exact:true}).fill(user.email);await d.getByRole('button',{name:'Permanently delete user',exact:true}).click();await d.waitFor({state:'hidden'});assert.equal(calls,1);assert.equal(await p.getByText(user.email,{exact:true}).count(),0);await shot(p,'admin-delete-success');results.push({screen:'Admin delete user',typedEmailRequired:true,cancelRequests:0,acknowledgedDeleteCount:1});await c.close();
 }
 if(mode==='modified'){
  const h=join(E,'harness');await mkdir(h,{recursive:true});await writeFile(join(h,'index.html'),'<html><head><link rel="stylesheet" href="/fonts.css"></head><body><div id="root"></div><script type="module" src="/review.tsx"></script></body></html>');
  await writeFile(join(h,'review.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import App from '/@fs/${resolve('web/src/App.tsx')}';import{setHubSession}from'/@fs/${resolve('web/src/hub-client-state.ts')}';import'/@fs/${resolve('web/src/styles.css')}';import'/@fs/${resolve('web/src/HubGate.css')}';import'/@fs/${resolve('web/src/v21-tokens.css')}';import'/@fs/${resolve('web/src/atlas-v21.css')}';import'/@fs/${resolve('web/src/sidebar-responsive.css')}';setHubSession(${JSON.stringify(session)});document.body.classList.add('atlas-v21');createRoot(document.getElementById('root')).render(<App/>);`);
  const vite=await createViteServer({configFile:false,root:h,publicDir:resolve('web/public'),plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')] },proxy:{'/api':{target:atlas}}},logLevel:'error'});await vite.listen();services.push(vite);const url=`http://127.0.0.1:${vite.httpServer.address().port}`;
  for(const viewport of [{width:1440,height:900},{width:1366,height:600},{width:1024,height:500},{width:390,height:844}]){
   const c=await browser.newContext({viewport}),p=await c.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.stack));await seed(p);await apiMocks(p,{backend:true});await p.addInitScript(()=>{if(window.top===window)localStorage.setItem('atlas.sidebarCollapsed','true')});await p.goto(url);const bell=p.getByRole('button',{name:'Notifications, 12 unread replies',exact:true});await bell.waitFor({state:'visible'});await p.mouse.move(700,200);await p.waitForTimeout(400);const center=await bell.evaluate(e=>{const b=e.getBoundingClientRect(),i=e.querySelector('svg').getBoundingClientRect(),badge=e.querySelector('.hub-notification-badge').getBoundingClientRect();return{dx:(i.left+i.width/2)-(b.left+b.width/2),dy:(i.top+i.height/2)-(b.top+b.height/2),within:badge.left>=b.left&&badge.right<=b.right&&badge.top>=b.top&&badge.bottom<=b.bottom,width:b.width,height:b.height}});assert.ok(Math.abs(center.dx)<.6&&Math.abs(center.dy)<.6);assert.equal(center.within,true);await shot(p,`notifications-collapsed-${viewport.width}x${viewport.height}`);
   let reads=0;p.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/read'))reads++;});await bell.click();await p.getByRole('dialog',{name:'Notifications',exact:true}).waitFor();assert.equal(reads,0);await shot(p,`notifications-open-${viewport.width}x${viewport.height}`);await p.getByRole('button',{name:'Close notifications',exact:true}).click();
   if(viewport.width===1366){await p.mouse.move(28,90);await p.waitForTimeout(800);assert.equal(await p.locator('.sidebar-peeking').count(),1);await bell.waitFor({state:'visible'});await shot(p,'notifications-peek-1366');}
   await p.getByRole('button',{name:'Connection options',exact:true}).click();assert.equal(await p.getByRole('menuitem',{name:'Open direct node tab',exact:true}).count(),0);await p.getByRole('menu',{name:'Connection options',exact:true}).press('Escape');
   if(viewport.width===1366){await p.mouse.move(700,200);await p.waitForTimeout(400);await p.getByRole('button',{name:'More Atlas tools',exact:true}).click();}
   if(viewport.width===1366||viewport.width===390){
    await p.evaluate(()=>dispatchEvent(new CustomEvent('atlas:profile-status',{detail:{state:'conflict',message:'Saved locally · sync paused. PROFILE_REVISION_CONFLICT'}})));await p.getByRole('button',{name:'Your saves',exact:true}).click();await p.getByRole('button',{name:'Repair sync…',exact:true}).click();await p.getByRole('heading',{name:'Repair synchronization?',exact:true}).waitFor();await shot(p,`sync-repair-confirm-${viewport.width}`);await p.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await p.getByRole('heading',{name:'Repair synchronization?',exact:true}).count(),0);await p.getByRole('button',{name:'Close saves',exact:true}).click();
   }
   results.push({screen:'Notification badge',viewport,center,openingBellMarksRead:false});await c.close();
  }
 }
 assert.deepEqual(errors,[]);await writeFile(join(E,`${mode.toUpperCase()}_BROWSER.json`),JSON.stringify({result:'PASS',browser:browser.version(),results,errors},null,2));console.log(`${mode.toUpperCase()}_UI=PASS; cases=${results.length}; errors=0`);
}catch(e){await writeFile(join(E,`${mode.toUpperCase()}_BROWSER.json`),JSON.stringify({result:'FAIL',results,errors,error:e.stack},null,2));console.error(e.stack);process.exitCode=1;}finally{await browser?.close();for(const s of services.reverse())await s.close();for(const t of temps)await rm(t,{recursive:true,force:true});}
