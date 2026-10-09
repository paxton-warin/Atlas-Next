import test from 'node:test';
import assert from 'node:assert/strict';
import {plan,run} from '../scripts/cloudfront-two-accounts.mjs';
const account='083712835210';
test('two equal batches, all 104 links unique, original references preserved',()=>{
 const a=plan(1,account), b=plan(2,'123456789012');
 assert.equal(a.length,52);assert.equal(b.length,52);
 assert.equal(a[0].key,'frontend-001');assert.equal(a[49].key,'frontend-050');
 assert.equal(b[0].key,'frontend-051');assert.equal(b[49].key,'frontend-100');
 assert.deepEqual(a.slice(50).map(x=>x.role),['dispenser','node2']);
 assert.deepEqual(b.slice(50).map(x=>x.role),['node3','node4']);
 assert.equal(new Set([...a,...b].map(x=>x.key)).size,104);
 assert.equal(a[0].batch,'five-account-v1-083712835210-1');
 assert.throws(()=>plan(3,account));
});
test('reuse completed 21; create only 31; rerun creates zero',()=>{
 const existing=plan(1,account).filter(x=>x.key<='frontend-020'||x.role==='dispenser').map((x,i)=>({
  Id:'old'+i,DomainName:'old'+i+'.cloudfront.net',
  Comment:'atlas-replace:'+x.batch+':'+x.key,
  Origins:{Items:[{DomainName:x.role==='dispenser'?'atlas-dispenser-vps-b.internals.paxton.co':'vps-1.internals.paxton.co'}]}
 }));
 assert.equal(existing.length,21);
 let creates=0, saved=[];
 const aws=args=>{
  if(args[1]==='get-caller-identity') return {Account:account};
  if(args[1]==='list-functions') return {FunctionList:{Items:[{Name:'atlas-five-account-viewer-1',FunctionMetadata:{FunctionARN:'arn:fixture'}}]}};
  if(args[1]==='describe-function') return {ETag:'etag'};
  if(args[1]==='publish-function') return {};
  if(args[1]==='list-distributions') return {DistributionList:{Items:existing}};
  if(args[1]==='create-distribution-with-tags') {
   creates++;
   const c=JSON.parse(args[3]).DistributionConfig;
   return {Distribution:{...c,Id:'new'+creates,DomainName:'new'+creates+'.cloudfront.net'}};
  }
  throw Error('Unexpected operation');
 };
 run(1,'fixture',account,aws,()=> 'fixture-key',rows=>saved=[...rows],()=>{});
 assert.equal(creates,31);assert.equal(saved.length,52);
 run(1,'fixture',account,aws,()=> 'fixture-key',()=>{},()=>{});
 assert.equal(creates,31);
});
test('account mismatch stops before key reads or provisioning',()=>{
 assert.throws(()=>run(1,'fixture',account,()=>({Account:'999999999999'}),()=>{throw Error('unexpected SSH');},()=>{}),/account differs/);
});
