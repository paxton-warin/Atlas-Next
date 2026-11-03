/** Real isolated PostgreSQL regressions. Never connects without an explicit _test DB. */
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";
import Fastify from "fastify";
import { registerHubIdentityRoutes } from "./hubIdentity.js";
import { createManualVerificationService } from "./manualVerification.js";
import { evaluateEmailPolicy } from "./emailPolicy.js";
import { AppError } from "./errors.js";
const url=process.env.TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite("ordinary-user handoffs reuse one real PostgreSQL transaction client",()=>{
 async function fixture(max:number,fullApp=false){
  if(!new URL(url!).pathname.endsWith("_test")||!['127.0.0.1','localhost'].includes(new URL(url!).hostname))throw Error('DEDICATED_LOOPBACK_TEST_DB_REQUIRED');
  const schema='auth_'+randomUUID().replaceAll('-','');
  const maintenance=new Pool({connectionString:url,max:2});await maintenance.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');await maintenance.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString:url,max,connectionTimeoutMillis:max>2?3000:500,options:'-c search_path='+schema+',public',application_name:schema});
  for(const name of(await readdir(resolve(import.meta.dirname,'../../../packages/database/migrations'))).filter(p=>p.endsWith('.sql')).sort())await pool.query(await readFile(resolve(import.meta.dirname,'../../../packages/database/migrations',name),'utf8'));
  const branchSecret='b'.repeat(43),link=(await pool.query("INSERT INTO links(name,url)VALUES('Test branch','https://branch.test')RETURNING id")).rows[0];
  const branch=(await pool.query('INSERT INTO hub_branches(link_id,origin,secret_hash)VALUES($1,$2,$3)RETURNING id',[link.id,'https://branch.test',hashSecret(branchSecret,config.sessionSecret)])).rows[0];
  const redis={status:'ready',ping:async()=> 'PONG',incr:async()=>1,expire:async()=>1};
  // The full application deliberately owns a dedicated profile LISTEN client.
  // max=1 isolates actual identity routes; full-app max=2 leaves exactly one
  // request connection and independently checks app eligibility propagation.
  const app=fullApp?(await buildApp({pool,redis:redis as any,hubEnabled:true})).app:Fastify({logger:false});
  if(!fullApp){
   const manual=createManualVerificationService(pool);
   app.setErrorHandler((error:any,_req,reply)=>reply.code(error instanceof AppError?error.status:500).send({error:{code:error.code||'INTERNAL_ERROR'}}));
   registerHubIdentityRoutes(app,{pool,sessionSecret:config.sessionSecret,encryptionKey:config.encryptionKey,requireUser:async()=>{throw Error('unused')},requireEligibleUser:async()=>{throw Error('unused')},requireAdmin:async()=>{throw Error('unused')},csrf(){},assertEligible:async(user,queryable=pool)=>{
    if(user.status!=='active')throw new AppError('USER_SUSPENDED','Suspended',403);
    if(user.role==='admin')return;
    const registration=(await queryable.query("SELECT value FROM app_settings WHERE key='registration'")).rows[0].value;
    const rules=(await queryable.query('SELECT * FROM email_rules ORDER BY priority DESC')).rows;
    if(!evaluateEmailPolicy(user.email,rules,registration.defaultMode).allowed)throw new AppError('EMAIL_NOT_ALLOWED','Denied',403);
    if((await manual.state(user,queryable)).required)throw new AppError('MANUAL_VERIFICATION_REQUIRED','Review required',403);
   }});
  }
  await app.ready();
  const headers={'x-atlas-branch-id':branch.id,authorization:'Bearer '+branchSecret};
  async function handoff(failure?:string){
   const email=randomUUID()+'@ordinary.test',user=(await pool.query("INSERT INTO users(email,normalized_email,verified_at,status)VALUES($1,$1,now(),$2)RETURNING id",[email,failure==='suspended'?'suspended':'active'])).rows[0];
   const parent=(await pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at,revoked_at)VALUES($1,$2,'fixture',now()+interval '1 day',$3)RETURNING id",[user.id,randomUUID(),failure==='parent-revoked'?new Date():null])).rows[0];
   if(failure!=='unassigned')await pool.query('INSERT INTO link_assignments(user_id,link_id)VALUES($1,$2)',[user.id,link.id]);
   const verifier='v'.repeat(43),code=randomUUID().replaceAll('-','')+'c'.repeat(11),challenge=createHash('sha256').update(verifier).digest('base64url');
   await pool.query("INSERT INTO hub_handoffs(code_hash,branch_id,user_id,parent_session_id,challenge,state,callback_origin,expires_at)VALUES($1,$2,$3,$4,$5,'test-state-123456789',$6,$7)",[hashSecret(code,config.sessionSecret),branch.id,user.id,parent.id,challenge,'https://branch.test',new Date(Date.now()+(failure==='expired'?-1000:60000))]);
   return{userId:user.id,email,code,verifier,body:{code,verifier:failure==='pkce'?'x'.repeat(43):verifier,callbackOrigin:failure==='callback'?'https://wrong.test':'https://branch.test'},codeHash:hashSecret(code,config.sessionSecret)};
  }
  async function exchange(h:Awaited<ReturnType<typeof handoff>>){return app.inject({method:'POST',url:'/api/hub/branch/exchange',headers,payload:h.body});}
  async function clean(){await app.close();await pool.end();await maintenance.query('DROP SCHEMA '+schema+' CASCADE');await maintenance.end();}
  async function idle(){const r=(await maintenance.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",[schema])).rows[0];expect(r.n).toBe(0);expect(pool.waitingCount).toBe(0);}
  return{pool,maintenance,schema,app,headers,handoff,exchange,clean,idle};
 }
 it('pool max=1 completes a non-admin handoff with real email/manual eligibility queries',async()=>{
  const f=await fixture(1);try{const h=await f.handoff(),r=await f.exchange(h);expect(r.statusCode).toBe(200);expect(r.json().grant.userId).toBe(h.userId);expect(r.json().branchSession).toHaveLength(43);await f.idle();}finally{await f.clean();}
 });
 it('pool max=2 completes ten parallel independent non-admin handoffs without orphan transactions',async()=>{
  const f=await fixture(2,true);try{const hs=[];for(let i=0;i<10;i++)hs.push(await f.handoff());const results=await Promise.all(hs.map(f.exchange));expect(results.map(r=>r.statusCode)).toEqual(Array(10).fill(200));expect(new Set(results.map(r=>r.json().grant.profileId)).size).toBe(10);expect((await f.pool.query('SELECT count(*)::int n FROM hub_handoffs WHERE used_at IS NOT NULL')).rows[0].n).toBe(10);await f.idle();}finally{await f.clean();}
 });
 it('admits 500 real ordinary accounts validating four times on one branch without sharing account budgets',async()=>{
  const f=await fixture(8,true);try{
   const hs=[];for(let i=0;i<500;i++)hs.push(await f.handoff());
   const sessions:{userId:string;profileId:string;token:string}[]=[];
   for(let i=0;i<hs.length;i+=20){const results=await Promise.all(hs.slice(i,i+20).map(f.exchange));for(let j=0;j<results.length;j++){const r=results[j];expect(r.statusCode).toBe(200);const value=r.json();expect(value.grant.userId).toBe(hs[i+j].userId);sessions.push({userId:value.grant.userId,profileId:value.grant.profileId,token:value.branchSession});}}
   expect(new Set(sessions.map(s=>s.profileId)).size).toBe(500);
   let validations=0;
   for(let round=0;round<4;round++)for(let i=0;i<sessions.length;i+=50){const results=await Promise.all(sessions.slice(i,i+50).map(s=>f.app.inject({method:'POST',url:'/api/hub/branch/session',headers:{...f.headers,'x-atlas-branch-session':s.token}})));for(let j=0;j<results.length;j++){const r=results[j];expect(r.statusCode).toBe(200);const value=r.json();expect(value.grant.userId).toBe(sessions[i+j].userId);expect(value.grant.profileId).toBe(sessions[i+j].profileId);validations++;}}
   expect(validations).toBe(2000);await f.idle();console.info('ADMISSION_PG_PROOF',JSON.stringify({ordinaryAccounts:sessions.length,verifiedValidations:validations,sharedBranches:1,capacityQualification:false}));
  }finally{await f.clean();}
 },60000);
 it('rejects suspended/unassigned/expired/revoked/PKCE/callback handoffs atomically and preserves replay guard',async()=>{
  const f=await fixture(1);try{
   for(const failure of['suspended','unassigned','expired','parent-revoked','pkce','callback']){const h=await f.handoff(failure),r=await f.exchange(h);expect(r.statusCode).toBe(failure==='suspended'||failure==='unassigned'?403:401);expect((await f.pool.query('SELECT used_at FROM hub_handoffs WHERE code_hash=$1',[h.codeHash])).rows[0].used_at).toBeNull();expect((await f.pool.query('SELECT count(*)::int n FROM hub_profiles WHERE user_id=$1',[h.userId])).rows[0].n).toBe(0);}
   await f.pool.query("UPDATE app_settings SET value=jsonb_set(value,'{defaultMode}','\"deny\"')WHERE key='registration'");const denied=await f.handoff();expect((await f.exchange(denied)).statusCode).toBe(403);await f.pool.query("UPDATE app_settings SET value=jsonb_set(value,'{defaultMode}','\"allow\"')WHERE key='registration'");
   await f.pool.query("INSERT INTO manual_verification_domains(domain,enabled)VALUES('ordinary.test',true)");const review=await f.handoff();const reviewResponse=await f.exchange(review);expect(reviewResponse.statusCode).toBe(403);expect(reviewResponse.json().error.code).toBe('MANUAL_VERIFICATION_REQUIRED');expect((await f.pool.query('SELECT used_at FROM hub_handoffs WHERE code_hash=$1',[review.codeHash])).rows[0].used_at).toBeNull();await f.pool.query("DELETE FROM manual_verification_domains WHERE domain='ordinary.test'");
   const good=await f.handoff();expect((await f.exchange(good)).statusCode).toBe(200);expect((await f.exchange(good)).statusCode).toBe(401);await f.idle();expect((await f.pool.query('SELECT 1 ok')).rows[0].ok).toBe(1);
  }finally{await f.clean();}
 });
 it('rolls back a real lock timeout, leaves the handoff unused and pool reusable',async()=>{
  const f=await fixture(1);let blocker;try{const h=await f.handoff();blocker=await f.maintenance.connect();await blocker.query('BEGIN');await blocker.query('SET LOCAL search_path='+f.schema+',public');await blocker.query('SELECT 1 FROM hub_handoffs WHERE code_hash=$1 FOR UPDATE',[h.codeHash]);const r=await f.exchange(h);expect(r.statusCode).toBe(503);expect(r.json().error.code).toBe('HUB_TRANSACTION_TIMEOUT');await blocker.query('ROLLBACK');blocker.release();blocker=undefined;expect((await f.pool.query('SELECT used_at FROM hub_handoffs WHERE code_hash=$1',[h.codeHash])).rows[0].used_at).toBeNull();expect((await f.exchange(h)).statusCode).toBe(200);await f.idle();}finally{if(blocker){await blocker.query('ROLLBACK');blocker.release();}await f.clean();}
 });
 it('guards performance telemetry behind admin auth and returns aggregate-only versioned fields',async()=>{
  const f=await fixture(2,true);try{expect((await f.app.inject({method:'GET',url:'/api/admin/performance'})).statusCode).toBe(401);const h=await f.handoff(),token='a'.repeat(43),csrf='fixture-csrf';await f.pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 day')",[h.userId,hashSecret('ordinary-'+token,config.sessionSecret),hashSecret(csrf,config.sessionSecret)]);expect((await f.app.inject({method:'GET',url:'/api/admin/performance',headers:{cookie:'ald_session=ordinary-'+token}})).statusCode).toBe(403);await f.pool.query("UPDATE users SET role='admin' WHERE id=$1",[h.userId]);await f.pool.query("INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 day')",[h.userId,hashSecret(token,config.sessionSecret),hashSecret(csrf,config.sessionSecret)]);const result=await f.app.inject({method:'GET',url:'/api/admin/performance',headers:{cookie:'ald_session='+token}});expect(result.statusCode).toBe(200);const value=result.json();expect(value.schema).toBe('atlas-hub-performance-v1');expect(Object.keys(value.pool)).toEqual(['total','idle','waiting']);for(const secret of[h.email,h.code,token,h.userId])expect(result.body.includes(secret)).toBe(false);}finally{await f.clean();}
 });
});
