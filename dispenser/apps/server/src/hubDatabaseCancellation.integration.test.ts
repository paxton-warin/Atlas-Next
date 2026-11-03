import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe,it,expect } from 'vitest';
import { acquireHubClient,withHubAuthTransaction } from './hubDatabaseWork.js';
const url=process.env.TEST_DATABASE_URL,suite=url?describe:describe.skip;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function guard(){if(!new URL(url!).pathname.endsWith('_test')||new URL(url!).hostname!=='127.0.0.1')throw Error('DEDICATED_LOOPBACK_TEST_DATABASE_REQUIRED');}
suite('actual PostgreSQL cancellation and queued-client recovery',()=>{
 it('response abort interrupts its own SQL transaction without orphan locks or harming other connections',async()=>{
  guard();const application='cancel_'+randomUUID(),pool=new Pool({connectionString:url,max:1,application_name:application}),other=new Pool({connectionString:url,max:2});
  const request={raw:Object.assign(new EventEmitter(),{aborted:false})}as any,reply={raw:Object.assign(new EventEmitter(),{writableEnded:false})}as any;
  try{
   const op=withHubAuthTransaction(pool,request,reply,async client=>{await client.query('SELECT pg_sleep(10)');return true;});
   const rejected=expect(op).rejects.toMatchObject({code:'HUB_REQUEST_ABORTED'});
   const until=Date.now()+2000;let active=false;
   while(Date.now()<until){active=!!(await other.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND query='SELECT pg_sleep(10)'",[application])).rowCount;if(active)break;await wait(10);}
   expect(active).toBe(true);reply.raw.emit('close');await rejected;
   expect((await pool.query('SELECT 1 healthy')).rows[0].healthy).toBe(1);
   expect((await other.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",[application])).rows[0].n).toBe(0);
   expect((await other.query('SELECT 2 unaffected')).rows[0].unaffected).toBe(2);expect(pool.waitingCount).toBe(0);
  }finally{await pool.end();await other.end();}
 });
 it('a real queued acquire deadline releases the eventually assigned client and leaves the pool usable',async()=>{
  guard();const pool=new Pool({connectionString:url,max:1}),held=await pool.connect();
  try{await expect(acquireHubClient(pool,new AbortController().signal,40)).rejects.toMatchObject({code:'HUB_DATABASE_BUSY'});held.release();await wait(20);expect((await pool.query('SELECT 1 healthy')).rows[0].healthy).toBe(1);expect(pool.waitingCount).toBe(0);expect(pool.idleCount).toBe(1);}finally{await pool.end();}
 });
});
