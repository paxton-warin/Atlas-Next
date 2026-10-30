#!/usr/bin/env node
/** Open the existing synthetic laboratory for human review. Never start/reset
 * services, load production configuration, invoke AWS, or touch student saves. */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, chmod, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { SOURCE, TARGET, localOrigin, reviewOptions, certificateSPKI } from './hub-continuity-review.mjs';
import { validateLabDatabase } from './hub-lab.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EMAIL = 'review@atlas-lab.example';
export function reviewMode(value) {
  if (value !== undefined && value !== '--verify-only') throw Error('Use no argument or --verify-only. This launcher never resets, provisions or deploys.');
  return { headless: value === '--verify-only', temporary: value === '--verify-only' };
}
export function validateReviewEmail(value) {
  if (value !== EMAIL) throw Error('Only the dedicated synthetic review account is permitted.');
  return value;
}
export function validateReviewStatus(value) {
  if (value?.localRuntime !== 'same-origin-profile' || value.simulation !== 'AWS simulator with local endpoint activation' || !isAbsolute(value.directory || '')) throw Error('An existing same-origin local simulator is required. No services were changed.');
  localOrigin(value.hub, 4300); localOrigin(value.atlas, 4280);
  return value;
}
async function main() {
  const mode = reviewMode(process.argv[2]);
  const lab = validateReviewStatus(JSON.parse(execFileSync(process.execPath, ['scripts/hub-lab.mjs','status'], {cwd: ROOT, encoding:'utf8'})));
  for (const process of lab.processes) { if (!Number.isSafeInteger(process.pid)) throw Error('Invalid Lab PID.'); globalThis.process.kill(process.pid, 0); }
  const out = join(ROOT, 'evidence/local-release-readiness-20261021/review');
  await mkdir(out, {recursive:true});
  const state = JSON.parse(await readFile(join(lab.directory, 'state.json'), 'utf8'));
  validateLabDatabase(state.databaseUrl);
  const require = createRequire(resolve(ROOT, '../Atlas-Link-Dispenser/apps/server/package.json'));
  const { Pool } = require('pg'); const pool = new Pool({connectionString:state.databaseUrl});
  const sha = value => createHash('sha256').update(value).digest('hex');
  const receipt = {startedAt:new Date().toISOString(),result:'PREPARING',mode:mode.temporary?'verify-only':'human-review',user:EMAIL,admin:'admin@atlas-lab.example',hub:lab.hub,source:SOURCE,target:TARGET,localRuntime:lab.localRuntime,AWS:'Local fake provider only; no real AWS commands',productionChanged:false,studentBrowserChanged:false,serviceRestarted:false,checks:[],screenshots:[],errors:[]};
  const record = (name, details={}) => receipt.checks.push({name,...details});
  const save = () => writeFile(join(out,mode.temporary?'VERIFIED.json':'PREPARED.json'), JSON.stringify(receipt,null,2)+'\n');
  const contexts = []; const temporaryDirs = [];
  let success = false;
  try {
    if ((await pool.query('SELECT id FROM atlas_lab_identity')).rows[0]?.id !== state.id) throw Error('Wrong Lab identity.');
    const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='id' ORDER BY table_name")).rows.map(r=>r.table_name).filter(n=>/^[a-z][a-z0-9_]*$/.test(n));
    const before = new Map();
    for (const table of tables) before.set(table,new Set((await pool.query('SELECT id::text FROM "'+table+'"')).rows.map(r=>r.id)));
    const privateHashes = {};
    for (const name of ['state.json','nodes.json','key.pem','cert.pem']) privateHashes[name] = sha(await readFile(join(lab.directory,name)));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const links=(await client.query('SELECT id,url,enabled FROM links WHERE url=ANY($1::text[])',[[SOURCE,TARGET]])).rows;
      if (links.length!==2 || links.some(l=>!l.enabled)) throw Error('Both existing A/B aliases must be enabled. No new endpoint will be provisioned.');
      await client.query('INSERT INTO users(email,normalized_email,verified_at,admin_notes) VALUES($1,$1,now(),$2) ON CONFLICT(normalized_email) DO NOTHING',[validateReviewEmail(EMAIL),'Dedicated synthetic full local review. Student and production data remain separate.']);
      const user=(await client.query('SELECT id,role,status FROM users WHERE normalized_email=$1',[EMAIL])).rows[0];
      if(user?.role!=='user'||user.status!=='active')throw Error('Unexpected review account role/status; existing settings were not changed.');
      for(const link of links)await client.query('INSERT INTO link_assignments(user_id,link_id) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM link_assignments WHERE user_id=$1 AND link_id=$2 AND active)',[user.id,link.id]);
      await client.query('COMMIT');
      record('Dedicated synthetic review account has two existing distinct A/B assignments',{logicalEndpointsCreated:0,studentAccountChanged:false});
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally {client.release();}
    const executable=process.env.CHROME_PATH || join(process.env.HOME,'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    const options=reviewOptions({executable,spki:certificateSPKI(join(lab.directory,'cert.pem')),headless:mode.headless});
    async function context(name) {
      const dir=mode.temporary ? await mkdtemp(join(tmpdir(),'atlas-full-review-'+name+'-')) : join(lab.directory,'review-full-'+name+'-20261021');
      if(mode.temporary)temporaryDirs.push(dir);
      await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
      const c=await chromium.launchPersistentContext(dir,options);contexts.push(c);
      c.on('page',p=>{p.setDefaultTimeout(45000);p.on('pageerror',e=>receipt.errors.push(e.message.replace(/https?:\/\/\S+/g,'[URL]')));});
      return c;
    }
    async function login(c,email) {
      const p=await c.newPage();await p.goto(lab.hub,{waitUntil:'domcontentloaded'});
      await p.getByLabel('Email address',{exact:true}).or(p.getByRole('button',{name:'Sign out',exact:true})).first().waitFor();
      if(await p.getByLabel('Email address',{exact:true}).isVisible().catch(()=>false)) {
        await p.getByLabel('Email address',{exact:true}).fill(email);await p.getByRole('button',{name:'Continue',exact:true}).click();
        const link=p.getByRole('link',{name:'Open your verification file'});await link.waitFor();const href=await link.getAttribute('href'),u=new URL(href);localOrigin(u.origin,4300);
        if(!u.pathname.startsWith('/__lab/verification/'))throw Error('Only the local verification fixture may sign in.');
        const file=await c.newPage();await file.goto(href);const body=await file.locator('body').innerText();await file.close();
        const code=body.match(/Verification code: (\d{6,8})/)?.[1];if(!code)throw Error('Displayed verification file has no code.');
        await p.getByRole('textbox',{name:/digit verification code/}).fill(code);await p.getByRole('button',{name:'Sign out',exact:true}).waitFor();
      }
      const user=await p.evaluate(async()=>{const r=await fetch('/api/session');if(!r.ok)throw Error('Session not ready');return(await r.json()).user;});
      if(user?.email!==email)throw Error('The review profile contains a different account; no automatic logout or data clearing was performed.');
      return p;
    }
    async function capture(p,name,width=1440) {
      await p.setViewportSize({width,height:width<600?844:1000});await p.bringToFront();
      await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
      const path=join(out,name+'.png');await p.screenshot({path,fullPage:true});receipt.screenshots.push(name+'.png');
      const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow)throw Error('Horizontal overflow on '+name);
    }
    const user=await context('user');receipt.browser=user.browser()?.version();
    const guide=await user.newPage();await guide.goto(pathToFileURL(join(ROOT,'evidence/continuity-review-20261021/START_HERE.html')).href);
    const hub=await login(user,EMAIL);record('User signed into real Hub using synthetic verification');
    await capture(hub,'hub-user-desktop');
    const atlas=[];
    for(const [name,url] of [['A',SOURCE],['B',TARGET]]) {
      const p=await user.newPage();await p.goto(url,{waitUntil:'domcontentloaded'});
      await p.locator('.atlas').or(p.getByRole('button',{name:'Sign in',exact:true})).first().waitFor();
      if(await p.getByRole('button',{name:'Sign in',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Sign in',exact:true}).click();
      await p.locator('.atlas').waitFor({timeout:90000});
      if(await p.getByRole('button',{name:'Use defaults',exact:true}).isVisible().catch(()=>false))await p.getByRole('button',{name:'Use defaults',exact:true}).click();
      const s=await p.evaluate(async()=>{const r=await fetch('/api/hub/state');const s=await r.json();return {ok:r.ok,authenticated:s.authenticated,profileId:s.grant?.profileId,enabled:s.enabled,transition:!!s.endpointTransition};});
      if(!s.ok||!s.authenticated||!s.profileId||s.transition)throw Error('A/B must be active authenticated browser endpoints.');
      atlas.push({name,page:p,profileId:s.profileId});
      const registration=await p.evaluate(async()=>{await navigator.serviceWorker.register('/worker.js',{scope:'/'});const r=await Promise.race([navigator.serviceWorker.ready,new Promise((_,j)=>setTimeout(()=>j(Error('Service worker timed out')),15000))]);const until=Date.now()+15000;while(r.active?.state!=='activated'&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));return{scope:r.scope,script:r.active?.scriptURL,state:r.active?.state};});
      if(registration.state!=='activated'||registration.scope!==url+'/')throw Error('The local certificate did not support the actual service worker.');
      record('Atlas '+name+' authenticated with active root worker',{origin:url,workerState:registration.state});await capture(p,'atlas-'+name+'-desktop');
    }
    if(atlas[0].profileId!==atlas[1].profileId)throw Error('A and B must use the same account profile.');
    record('A/B share one cloud profile on distinct frontend origins');
    const admin=await context('admin'),panel=await login(admin,'admin@atlas-lab.example');
    await panel.goto(lab.hub+'/?admin',{waitUntil:'domcontentloaded'});
    await panel.getByRole('button',{name:'Overview',exact:true}).first().waitFor();await capture(panel,'hub-admin-desktop');
    record('Separate administrator window preserves ordinary-user A/B sessions');
    await capture(guide,'review-guide-desktop');await capture(guide,'review-guide-mobile',390);await guide.setViewportSize({width:1440,height:1000});
    const retained=[];
    for(const [table,ids]of before) {const now=new Set((await pool.query('SELECT id::text FROM "'+table+'"')).rows.map(r=>r.id));if([...ids].some(id=>!now.has(id)))throw Error('Existing local records disappeared from '+table);retained.push({table,existingRecordsPreserved:ids.size});}
    for(const [name,hash]of Object.entries(privateHashes))if(sha(await readFile(join(lab.directory,name)))!==hash)throw Error('Existing Lab identity/configuration/key changed.');
    record('Existing database records, service configuration, node identities and TLS key retained',{tables:retained,privateValuesExported:false});
    for(const c of contexts)for(const p of c.pages())if(p.url()==='about:blank')await p.close();
    receipt.result=mode.temporary?'PASS':'READY_FOR_USER';receipt.finishedAt=new Date().toISOString();await save();success=true;
    console.log('LOCAL_REVIEW=READY; USER_LINKS=A_AND_B; SAME_PROFILE=YES; WORKERS=2/2; ADMIN=SEPARATE_WINDOW; EXISTING_RECORDS=RETAINED; AWS=FAKE_ONLY; PRODUCTION=UNCHANGED');
    console.log('HUB='+lab.hub);console.log('A='+SOURCE);console.log('B='+TARGET);console.log('GUIDE='+join(ROOT,'evidence/continuity-review-20261021/START_HERE.html'));
    if(!mode.temporary) {await guide.bringToFront();await Promise.all(contexts.map(c=>new Promise(r=>c.once('close',r))));}
  }catch(e){receipt.result='FAIL';receipt.failure=e.message;await save();throw e;}
  finally{await pool.end();if(mode.temporary||!success)for(const c of contexts)await c.close().catch(()=>{});for(const dir of temporaryDirs)await rm(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
