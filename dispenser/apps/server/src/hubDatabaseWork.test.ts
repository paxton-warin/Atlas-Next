import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { acquireHubClient, HUB_AUTH_DATABASE_LIMITS, withHubAuthTransaction } from "./hubDatabaseWork.js";
import { createHubPerformance } from "./hubPerformance.js";
const deferred=()=>{let resolve!:(value?:any)=>void;return{promise:new Promise<any>(r=>{resolve=r}),resolve:(value?:any)=>resolve(value)}};
function request(){return{raw:Object.assign(new EventEmitter(),{aborted:false})}as any;}
function reply(){return{raw:Object.assign(new EventEmitter(),{writableEnded:false})}as any;}
afterEach(()=>vi.useRealTimers());
describe('bounded own-client transaction cleanup',()=>{
 it('times out queued acquisition and releases a late client exactly once',async()=>{
  vi.useFakeTimers();const pending=deferred(),release=vi.fn(),p=acquireHubClient({connect:()=>pending.promise}as unknown as Pool,new AbortController().signal,100);const rejected=expect(p).rejects.toMatchObject({code:'HUB_DATABASE_BUSY',status:503});await vi.advanceTimersByTimeAsync(100);await rejected;pending.resolve({release});await Promise.resolve();expect(release).toHaveBeenCalledTimes(1);
 });
 it('an aborted queued acquisition also returns a later client to its pool',async()=>{
  const pending=deferred(),release=vi.fn(),control=new AbortController(),p=acquireHubClient({connect:()=>pending.promise}as unknown as Pool,control.signal);control.abort();await expect(p).rejects.toBe(control.signal.reason);pending.resolve({release});await Promise.resolve();expect(release).toHaveBeenCalledOnce();
 });
 it('response disconnect destroys only its own checked-out client, never commits, and removes listeners',async()=>{
  const waiting=deferred(),req=request(),res=reply(),release=vi.fn(),query=vi.fn(async(sql:string)=>({rows:[]})),client={release,query};
  const op=withHubAuthTransaction({connect:async()=>client}as unknown as Pool,req,res,async c=>{await waiting.promise;await c.query('SELECT 1');return true;});
  const rejected=expect(op).rejects.toMatchObject({code:'HUB_REQUEST_ABORTED'});await new Promise(r=>setTimeout(r,1));res.raw.emit('close');await rejected;waiting.resolve();await Promise.resolve();expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);expect(req.raw.listenerCount('aborted')).toBe(0);expect(res.raw.listenerCount('close')).toBe(0);
 });
 it('request aborted while queued never starts a transaction',async()=>{
  const pending=deferred(),req=request(),res=reply(),query=vi.fn(),release=vi.fn(),op=withHubAuthTransaction({connect:()=>pending.promise}as unknown as Pool,req,res,async()=>true);const rejected=expect(op).rejects.toMatchObject({code:'HUB_REQUEST_ABORTED'});req.raw.emit('aborted');await rejected;pending.resolve({query,release});await Promise.resolve();expect(query).not.toHaveBeenCalled();expect(release).toHaveBeenCalledOnce();
 });
 it('absolute deadline rejects even a stalled callback and destroys its own client',async()=>{
  vi.useFakeTimers();const waiting=deferred(),req=request(),res=reply(),release=vi.fn(),query=vi.fn(async()=>({rows:[]})),op=withHubAuthTransaction({connect:async()=>({release,query})}as unknown as Pool,req,res,async()=>{await waiting.promise;return true;});const rejected=expect(op).rejects.toMatchObject({code:'HUB_TRANSACTION_TIMEOUT'});await vi.advanceTimersByTimeAsync(HUB_AUTH_DATABASE_LIMITS.transactionMs);await rejected;waiting.resolve();await Promise.resolve();expect(release).toHaveBeenCalledExactlyOnceWith(true);
 });
 it('failed rollback destroys the client and preserves original auth rejection',async()=>{
  const req=request(),res=reply(),release=vi.fn(),query=vi.fn(async(sql:string)=>{if(sql==='ROLLBACK')throw Error('rollback failed');return{rows:[]}}),original=Object.assign(Error('suspended'),{status:403,code:'USER_SUSPENDED'}),telemetry=createHubPerformance();await expect(withHubAuthTransaction({connect:async()=>({release,query})}as unknown as Pool,req,res,async()=>{throw original},telemetry)).rejects.toBe(original);expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(telemetry.snapshot().metrics['auth.rollback'].outcomes.error).toBe(1);
 });
 it('SQL statement/lock timeout is retryable and rolls back before healthy release',async()=>{
  const req=request(),res=reply(),release=vi.fn(),query=vi.fn(async()=>({rows:[]}));await expect(withHubAuthTransaction({connect:async()=>({release,query})}as unknown as Pool,req,res,async()=>{throw Object.assign(Error('lock timeout'),{code:'55P03'})})).rejects.toMatchObject({code:'HUB_TRANSACTION_TIMEOUT',status:503});expect(query).toHaveBeenCalledWith('ROLLBACK');expect(release).toHaveBeenCalledExactlyOnceWith(false);
 });
 it('telemetry ignores unbounded labels and returns a detached, secret-free versioned snapshot',()=>{
  const p=createHubPerformance();for(let i=0;i<1000;i++)p.observe(('secret-'+i)as any,123);p.observe('pool.acquire',23);const s=p.snapshot();expect(s.schema).toBe('atlas-hub-performance-v1');expect(Object.keys(s.metrics)).toHaveLength(12);expect(JSON.stringify(s)).not.toContain('secret-');s.metrics['pool.acquire'].count=1234;expect(p.snapshot().metrics['pool.acquire'].count).toBe(1);
 });
});
