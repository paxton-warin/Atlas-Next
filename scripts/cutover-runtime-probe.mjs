/** Operator-run real endpoint qualification. No AWS, staging, deployment or
 * acceptance writes occur here. A signed envelope is emitted only after actual
 * browser handoffs, remote commit receipts, native restoration and relay echo. */
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { chromium } from '@playwright/test';
import { canonicalProbeJSON, probeDigest } from './cutover-probe-assets.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const stop = code => { throw Object.assign(Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function probeOrigin(value) { try { const u = new URL(value); if (u.protocol === 'https:' && u.origin === value && !u.username && !u.password) return value; } catch {} return stop('EXACT_HTTPS_ORIGIN_REQUIRED'); }
export function validateProbeStage(stage, assets) {
  if (!stage || !uuid(stage.jobId) || !Number.isSafeInteger(stage.jobRevision) || stage.jobRevision < 0 || !hash(stage.planHash) || !hash(stage.checkpointHash) || !hash(stage.assetManifestHash) || !/^\d{12}$/.test(stage.accountIdentity || '') || !Array.isArray(stage.items) || !stage.items.length) stop('EXACT_STAGED_JOB_REQUIRED');
  probeOrigin(stage.coordinatorOrigin);
  if (assets?.format !== 'atlas-runtime-probe-assets-v1' || probeDigest(assets) !== stage.assetManifestHash) stop('TRUSTED_ASSET_MANIFEST_MISMATCH');
  const keys = new Set(); for (const item of stage.items) {
    if (!item || !['frontend','hub','node'].includes(item.role) || typeof item.resourceKey !== 'string' || !item.resourceKey || keys.has(item.resourceKey) || !/^[A-Z0-9]{8,64}$/.test(item.distributionId || '')) stop('STAGED_RESOURCE_BINDING_INVALID');
    keys.add(item.resourceKey); probeOrigin(item.origin);
    if (!Array.isArray(assets.roles?.[item.role]) || !assets.roles[item.role].length) stop('ROLE_ASSET_MANIFEST_REQUIRED');
    for (const asset of assets.roles[item.role]) if (!asset || typeof asset.path !== 'string' || !asset.path.startsWith('/') || asset.path.startsWith('//') || /[?#\\]/.test(asset.path) || asset.path.split('/').includes('..') || !hash(asset.sha256)) stop('ROLE_ASSET_PATH_INVALID');
    if (item.role === 'frontend' && !uuid(item.branchId)) stop('STAGED_BRANCH_REQUIRED');
  }
  return stage;
}
export function observedCookieAttributes(cookie, origin) {
  if (!cookie || cookie.domain !== new URL(origin).hostname || !cookie.secure || !cookie.httpOnly || cookie.path !== '/' || !['Lax','Strict'].includes(cookie.sameSite)) stop('OBSERVED_HOST_ONLY_COOKIE_REQUIRED');
  return ['Secure','HttpOnly','HostOnly','Path=/','SameSite='+cookie.sameSite];
}
export function signProbePayload(payload, privateKeyPEM) {
  const key = createPrivateKey(privateKeyPEM); if (key.asymmetricKeyType !== 'ed25519') stop('ED25519_PROBE_KEY_REQUIRED');
  return { format:'atlas-runtime-acceptance-envelope-v1', payload, signature:sign(null,Buffer.from(canonicalProbeJSON(payload)),key).toString('base64url') };
}
async function privateFile(path) {
  const p = await realpath(resolve(path)), root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
  if (p === root || p.startsWith(root + '/') || ((await stat(p)).mode & 0o077)) stop('PRIVATE_OPERATOR_FILE_OUTSIDE_WORKSPACE_REQUIRED');
  return readFile(p,'utf8');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export async function runCutoverRuntimeProbe(options) {
  const stage=validateProbeStage(JSON.parse(await readFile(options.stage,'utf8')),JSON.parse(await readFile(options.assets,'utf8'))), assets=JSON.parse(await readFile(options.assets,'utf8'));
  const fixture=new URL(options.fixture);if(fixture.protocol!=='https:'||fixture.pathname!=='/atlas-runtime-probe-v1/'||fixture.search||fixture.hash||fixture.username||fixture.password)stop('CONTROLLED_PUBLIC_FIXTURE_REQUIRED');
  const started=new Date(), observationTime=started.toISOString(), output=resolve(options.out);await mkdir(output,{recursive:false});
  const key=await privateFile(options.key), operator=JSON.parse(await privateFile(options.operatorState));
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), require=createRequire(join(root,'../Atlas-Link-Dispenser/apps/server/package.json')),{Pool}=require('pg');
  if(!process.env.ATLAS_PROBE_DATABASE_URL||!process.env.ATLAS_PROBE_COORDINATOR_TOKEN)stop('PRIVATE_PROBE_DATABASE_AND_CONTROL_CONFIGURATION_REQUIRED');
  const pool=new Pool({connectionString:process.env.ATLAS_PROBE_DATABASE_URL,max:1,connectionTimeoutMillis:5000});
  async function query(sql,values=[]){const c=await pool.connect();try{await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='10s'");const r=await c.query(sql,values);await c.query('COMMIT');return r.rows;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
  let browser, context, phase='job-binding';const transcripts=[], proofByKey=new Map(), websockets=[];
  try{
    const job=(await query('SELECT id,revision,plan_hash,plan,checkpoint FROM hub_cloud_jobs WHERE id=$1',[stage.jobId]))[0];
    if(!job||Number(job.revision)!==stage.jobRevision||job.plan_hash!==stage.planHash||probeDigest(job.checkpoint)!==stage.checkpointHash||job.plan.accountIdentity!==stage.accountIdentity)stop('LIVE_JOB_BINDING_MISMATCH');
    for(const item of stage.items){const d=job.checkpoint.resources?.[item.resourceKey];if(!d||d.id!==item.distributionId||item.origin!=='https://'+d.domain)stop('LIVE_CHECKPOINT_TARGET_MISMATCH');}
    const headers={authorization:'Bearer '+process.env.ATLAS_PROBE_COORDINATOR_TOKEN};if(process.env.ATLAS_PROBE_COORDINATOR_ORIGIN_KEY)headers['X-Atlas-Origin-Key']=process.env.ATLAS_PROBE_COORDINATOR_ORIGIN_KEY;
    const snapshotResponse=await fetch(stage.coordinatorOrigin+'/api/internal/hub/endpoints',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});if(!snapshotResponse.ok)stop('COORDINATOR_SNAPSHOT_HTTP_FAILED');
    const coordinator=await snapshotResponse.json();if(coordinator.format!=='atlas-coordinator-endpoint-snapshot-v1'||coordinator.origin!==stage.coordinatorOrigin)stop('COORDINATOR_SNAPSHOT_BINDING_FAILED');
    phase='asset-identity';for(const item of stage.items){for(const asset of assets.roles[item.role]){const r=await fetch(item.origin+asset.path,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{'cache-control':'no-cache'}});if(!r.ok||sha(Buffer.from(await r.arrayBuffer()))!==asset.sha256)stop('PUBLIC_ASSET_HASH_MISMATCH');}proofByKey.set(item.resourceKey,{resourceKey:item.resourceKey,distributionId:item.distributionId,origin:item.origin,role:item.role,assetManifestHash:stage.assetManifestHash});}
    browser=await chromium.launch({headless:!options.headful,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const hubOrigins=new Set([coordinator.hubOrigin,...stage.items.filter(i=>i.role==='hub').map(i=>i.origin)]);
    // Reuse real operator Hub sessions, never Atlas/website data or reassigned
    // cookie domains. Raw cookie values stay only in the private browser state.
    const storageState={cookies:(operator.cookies||[]).filter(c=>['ald_session','ald_csrf'].includes(c.name)&&[...hubOrigins].some(o=>c.domain===new URL(o).hostname)),origins:(operator.origins||[]).filter(o=>hubOrigins.has(o.origin))};
    context=await browser.newContext({storageState,viewport:{width:1440,height:1000}});
    const pages=new Map();
    async function open(origin){if(pages.has(origin))return pages.get(origin);const p=await context.newPage(),record={page:p,origin,callback:null,grant:null,relays:[],auth:null};pages.set(origin,record);
      p.on('request',r=>{const u=new URL(r.url());if(u.origin===origin&&u.pathname==='/auth/hub/callback')record.callback=r.url();});
      p.on('websocket',ws=>{const u=new URL(ws.url());if(u.protocol==='wss:'&&/^\/(?:relay|wisp)\//.test(u.pathname)){const observed={url:u.origin+u.pathname.replace(/\/(?:relay|wisp)\/.*/, '/relay/redacted/'),urlHash:sha(ws.url()),openedAt:new Date().toISOString(),closedAt:null};record.relays.push(observed);websockets.push(observed);ws.on('close',()=>observed.closedAt=new Date().toISOString());}});
      await p.goto(origin);const signin=p.getByRole('button',{name:'Sign in',exact:true}),saves=p.getByRole('button',{name:'Your saves',exact:true});await Promise.race([signin.waitFor({timeout:30000}),saves.waitFor({timeout:30000})]);if(await signin.isVisible().catch(()=>false))await signin.click();
      await saves.waitFor({timeout:options.headful?180000:60000});const defaults=p.getByRole('button',{name:'Use defaults',exact:true});if(await defaults.isVisible().catch(()=>false))await defaults.click();
      const state=await p.evaluate(async()=>{const r=await fetch('/api/hub/state',{cache:'no-store'});return r.json()});if(!state.authenticated||!uuid(state.grant?.sessionId)||!record.callback)stop('REAL_ACCOUNT_HANDOFF_REQUIRED');record.grant=state.grant;
      if(stage.probeAccountId&&state.grant.userId!==stage.probeAccountId)stop('DEDICATED_PROBE_ACCOUNT_MISMATCH');
      const replay=await p.request.get(record.callback,{maxRedirects:0});if(![400,409].includes(replay.status()))stop('AUTH_CODE_REPLAY_WAS_NOT_DENIED');
      const row=(await query('SELECT h.code_hash,h.used_at,bs.parent_session_id FROM hub_branch_sessions bs JOIN hub_handoffs h ON h.parent_session_id=bs.parent_session_id AND h.branch_id=bs.branch_id AND h.user_id=bs.user_id WHERE bs.id=$1 AND h.callback_origin=$2 AND h.used_at>=$3 ORDER BY h.used_at DESC LIMIT 1',[state.grant.sessionId,origin,started.toISOString()]))[0];if(!row)stop('REDEEMED_HANDOFF_DATABASE_PROOF_REQUIRED');
      const cookies=await context.cookies(origin),cookie=cookies.find(c=>c.name==='__Host-atlas-hub');
      record.auth={kind:'account-bound-handoff',branchId:state.grant.branchId,userId:state.grant.userId,profileId:state.grant.profileId,sessionId:state.grant.sessionId,callbackOrigin:origin,redeemedCodeHash:row.code_hash,redeemedAt:new Date(row.used_at).toISOString(),replayHTTPStatus:replay.status(),cookieAttributes:observedCookieAttributes(cookie,origin)};
      return record;
    }
    async function site(record,run){const url=new URL(fixture);url.searchParams.set('run',run);const field=record.page.getByPlaceholder('Search or enter a URL',{exact:true}).first();await field.fill(url.href);await field.press('Enter');for(let i=0;i<600;i++){const go=record.page.getByRole('button',{name:'Continue here',exact:true});if(await go.isVisible().catch(()=>false))await go.click();for(const f of record.page.frames())if(await f.locator('#result').isVisible().catch(()=>false)){const value=await f.locator('#result').textContent().then(t=>{try{return JSON.parse(t)}catch{return null}});if(value?.run===run)return f;}await sleep(200);}stop('ACTUAL_NATIVE_WEBSITE_DID_NOT_LOAD');}
    async function value(frame){await frame.locator('#read').click();const v=JSON.parse(await frame.locator('#result').textContent());if(v.error)stop('NATIVE_WEBSITE_READ_FAILED');return v.saved;}
    async function echo(record,frame,nonce,requiredOrigin){await frame.locator('#value').fill(nonce);await frame.locator('#echo').click();await frame.locator('#result').filter({hasText:nonce}).waitFor({timeout:30000});let result;for(let i=0;i<150;i++){result=JSON.parse(await frame.locator('#result').textContent());if(result.error)stop('ACTUAL_WEBSOCKET_ECHO_FAILED');if(result.echo===nonce)break;await sleep(100);}if(result.echo!==nonce)stop('ACTUAL_WEBSOCKET_ECHO_INCOMPLETE');const relay=[...record.relays].reverse().find(w=>!requiredOrigin||new URL(w.url).origin==='wss://'+new URL(requiredOrigin).host);if(!relay)stop('AUTHENTICATED_TARGET_RELAY_NOT_OBSERVED');transcripts.push({kind:'logical-echo-over-observed-authenticated-relay',origin:record.origin,sessionId:record.grant.sessionId,relayURLHash:relay.urlHash,logicalEchoURL:result.echoURL,sentSHA256:sha(nonce),receivedSHA256:sha(result.echo),bytes:Buffer.byteLength(nonce)});return{relay,sentSHA256:sha(nonce),receivedSHA256:sha(result.echo),sentBytes:Buffer.byteLength(nonce),receivedBytes:Buffer.byteLength(result.echo),sessionId:record.grant.sessionId};}
    const frontends=stage.items.filter(i=>i.role==='frontend');if(!frontends.length)stop('A_FRONTEND_PROBE_TARGET_IS_REQUIRED');const peerOrigin=options.peer?probeOrigin(options.peer):frontends[1]?.origin;if(!peerOrigin)stop('DISTINCT_RESTORE_PEER_REQUIRED');
    for(const item of frontends){phase='frontend-'+item.resourceKey;const source=await open(item.origin),run=randomBytes(24).toString('base64url'),nonce='atlas-continuity-'+randomBytes(48).toString('hex'),frame=await site(source,run);const origin=fixture.origin;
      const receipts=[];const listener=async r=>{if(new URL(r.url()).origin!==item.origin||new URL(r.url()).pathname!=='/api/hub/profile/commits')return;try{const input=r.request().postDataJSON(),ack=await r.json();if(r.ok()&&ack.acknowledged===true&&input.namespace.kind==='local'&&input.namespace.origin===origin)receipts.push({input,ack,at:new Date().toISOString()});}catch{}};source.page.on('response',listener);
      await frame.locator('#value').fill(nonce);await frame.locator('#write').click();if(await value(frame)!==nonce)stop('DURABLE_LOCAL_VALUE_MISMATCH');
      for(let i=0;i<450&&!receipts.length;i++)await sleep(100);source.page.off('response',listener);if(receipts.length!==1)stop('EXACT_REMOTE_SAVE_ACK_REQUIRED');const commit=receipts[0];
      const receiptResponse=await source.page.request.get(item.origin+'/api/hub/profile/receipts/'+commit.input.idempotencyKey);if(!receiptResponse.ok())stop('IMMUTABLE_REMOTE_RECEIPT_REQUIRED');const receipt=await receiptResponse.json();if(!receipt.acknowledged||receipt.revision!==commit.ack.revision||!hash(receipt.payloadHash))stop('IMMUTABLE_REMOTE_RECEIPT_MISMATCH');
      const w=await echo(source,frame,nonce);const destination=await open(peerOrigin===item.origin?frontends[0].origin:peerOrigin);if(destination.origin===source.origin)stop('DISTINCT_RESTORE_PEER_REQUIRED');const restoredFrame=await site(destination,run),restored=await value(restoredFrame);if(restored!==nonce)stop('FRESH_HOST_NATIVE_RESTORE_MISMATCH');
      const proof=proofByKey.get(item.resourceKey);proof.auth=source.auth;proof.profile={profileId:source.grant.profileId,namespace:['local',origin,''],idempotencyKey:commit.input.idempotencyKey,revision:receipt.revision,payloadHash:receipt.payloadHash,sourceValueHash:sha(nonce),restoredValueHash:sha(restored),acknowledgedAt:commit.at,restoredAt:new Date().toISOString()};proof.websocket=w;
      await source.page.screenshot({path:join(output,item.resourceKey+'-source.png'),fullPage:true});await destination.page.screenshot({path:join(output,item.resourceKey+'-restored.png'),fullPage:true});
    }
    for(const item of stage.items.filter(i=>i.role==='node')){phase='node-'+item.resourceKey;if(!options.nodeCredentials)stop('PRIVATE_PAIRED_NODE_CREDENTIAL_REQUIRED');const credentials=JSON.parse(await privateFile(options.nodeCredentials)),token=credentials[item.logicalId]?.token||credentials[item.logicalId]?.secret;if(typeof token!=='string'||token.length<32)stop('PRIVATE_PAIRED_NODE_CREDENTIAL_REQUIRED');const r=await fetch(item.origin+'/node/health',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)}),health=r.ok()?await r.json():null;if(health?.id!==item.logicalId)stop('REAL_NODE_IDENTITY_MISMATCH');
      const source=await open(frontends[0].origin),frame=await site(source,randomBytes(24).toString('base64url')),nonce='atlas-node-echo-'+randomBytes(48).toString('hex');const w=await echo(source,frame,nonce,item.origin);const proof=proofByKey.get(item.resourceKey);proof.nodeIdentity={expectedId:item.logicalId,observedId:health.id};proof.websocket=w;
    }
    for(const item of stage.items.filter(i=>i.role==='hub')){phase='hub-'+item.resourceKey;const page=await context.newPage();await page.goto(item.origin);const sessionResponse=await page.request.get(item.origin+'/api/session');const session=sessionResponse.ok()?await sessionResponse.json():null;if(!session?.user?.id||!session.csrfToken)stop('REAL_HUB_SESSION_REQUIRED');
      const challenge=createHash('sha256').update(randomBytes(48)).digest('base64url'),state=randomBytes(24).toString('base64url'),branch=frontends[0];const h=await page.request.post(item.origin+'/api/hub/handoffs',{headers:{origin:item.origin,'x-csrf-token':session.csrfToken},data:{branchId:branch.branchId,callbackOrigin:branch.origin,codeChallenge:challenge,state}});if(!h.ok())stop('REAL_HUB_HANDOFF_SESSION_BINDING_REQUIRED');
      const row=(await query('SELECT parent_session_id FROM hub_handoffs WHERE branch_id=$1 AND user_id=$2 AND challenge=$3 AND state=$4 AND callback_origin=$5',[branch.branchId,session.user.id,challenge,state,branch.origin]))[0];if(!row)stop('REAL_HUB_SESSION_DATABASE_BINDING_REQUIRED');const cookie=(await context.cookies(item.origin)).find(c=>c.name==='ald_session');proofByKey.get(item.resourceKey).hubSession={sessionId:row.parent_session_id,userId:session.user.id,HTTPStatus:sessionResponse.status(),cookieAttributes:observedCookieAttributes(cookie,item.origin)};
    }
    phase='close-and-sign';await context.close();context=null;await sleep(250);
    const endpoints=[...proofByKey.values()];for(const proof of endpoints)if(proof.websocket){const{relay,...w}=proof.websocket;if(!relay.closedAt)stop('AUTHENTICATED_RELAY_CLOSE_NOT_OBSERVED');proof.websocket={url:relay.url,openedAt:relay.openedAt,closedAt:relay.closedAt,...w};}
    const payload={format:'atlas-runtime-acceptance-v1',jobId:stage.jobId,jobRevision:stage.jobRevision,planHash:stage.planHash,checkpointHash:stage.checkpointHash,accountIdentity:stage.accountIdentity,assetManifestHash:stage.assetManifestHash,observedAt:observationTime,expiresAt:new Date(started.getTime()+15*60000).toISOString(),coordinator,endpoints};
    if(Date.now()-started.getTime()>=14*60000)stop('PROBE_EVIDENCE_WINDOW_EXCEEDED');
    const envelope=signProbePayload(payload,key);await writeFile(join(output,'RUNTIME_ACCEPTANCE.json'),JSON.stringify(envelope,null,2)+'\n',{flag:'wx',mode:0o600});await writeFile(join(output,'PUBLIC_PROBE_TRANSCRIPT.json'),JSON.stringify({format:'atlas-public-probe-transcript-v1',phase,browser:browser.version(),transcripts,rawCredentialsRetained:false,awsOrDeploymentMutations:false},null,2)+'\n',{flag:'wx'});return{result:'PASS',evidenceHash:probeDigest(payload),path:join(output,'RUNTIME_ACCEPTANCE.json')};
  }catch(e){await writeFile(join(output,'PROBE_FAILURE.json'),JSON.stringify({result:'FAIL',phase,code:e.code||'REAL_PROBE_OBSERVATION_FAILED',signedEvidenceProduced:false,awsOrDeploymentMutations:false},null,2)+'\n',{flag:'wx'});throw e;}
  finally{await context?.close();await browser?.close();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const args={};for(let i=2;i<process.argv.length;i++){if(process.argv[i]==='--headful'){args.headful=true;continue;}const key={'--stage':'stage','--assets':'assets','--operator-state':'operatorState','--key':'key','--fixture':'fixture','--peer':'peer','--node-credentials':'nodeCredentials','--out':'out'}[process.argv[i]];if(!key||args[key]||!process.argv[i+1])stop('INVALID_PROBE_ARGUMENTS');args[key]=process.argv[++i];}for(const k of['stage','assets','operatorState','key','fixture','out'])if(!args[k])stop('MISSING_PROBE_ARGUMENTS');const result=await runCutoverRuntimeProbe(args);process.stdout.write('REAL_RUNTIME_PROBE=PASS; EVIDENCE_SHA256='+result.evidenceHash+'\n');}
 catch(e){process.stderr.write('REAL_RUNTIME_PROBE=FAILED; CODE='+(e.code||'REAL_PROBE_OBSERVATION_FAILED')+'; SIGNED_SUCCESS_NOT_INFERRED\n');process.exitCode=1;}
}
