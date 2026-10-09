#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distribution, makeAwsRunner, sleep } from './cloudfront-reset.mjs';

export function plan(batch, account) {
  if (![1,2].includes(batch) || !/^\d{12}$/.test(account)) throw Error('Expected batch and 12-digit account ID');
  const extras = {1:['dispenser','node2'],2:['node3','node4']};
  return [...Array.from({length:50}, (_,i)=>({role:'frontend',key:`frontend-${String((batch-1)*50+i+1).padStart(3,'0')}`})), ...extras[batch].map(role=>({role,key:role}))].map(item=>({...item, batch:`five-account-v1-${account}-${batch}`}));
}
export function findExisting(items, config) {
  const matches = items.filter(x=>x.Comment===config.Comment);
  if(matches.length>1) throw Error(`Multiple distributions match ${config.Comment}`);
  const found=matches[0];
  if(found && found.Origins?.Items?.[0]?.DomainName!==config.Origins.Items[0].DomainName) throw Error('Existing distribution origin differs; inspect before continuing');
  return found;
}
export function run(batch, profile, account, aws, readKey, save, delay=()=>sleep(5000)) {
  const items=plan(batch,account);
  if(aws(['sts','get-caller-identity']).Account!==account) throw Error('AWS account differs from requested account');
  const hosts={frontend:'vps-1.internals.paxton.co',node2:'vps-2.internals.paxton.co',node3:'vps-3.internals.paxton.co',node4:'vps-4.internals.paxton.co',dispenser:'atlas-dispenser-vps-b.internals.paxton.co'};
  const keys={};
  for(const role of new Set(items.map(x=>x.role))) if(role!=='dispenser') keys[role]=readKey(hosts[role]);
  // Keep the old naming and caller references so the completed first batch is reused.
  const name=`atlas-five-account-viewer-${batch}`;
  let fn=aws(['cloudfront','list-functions']).FunctionList?.Items?.find(x=>x.Name===name);
  if(!fn) {
    const created=aws(['cloudfront','create-function','--name',name,'--function-config',JSON.stringify({Comment:'Atlas trusted viewer headers',Runtime:'cloudfront-js-2.0'}),'--function-code',`fileb://${resolve('scripts/cloudfront-viewer.js')}`]);
    fn=created.FunctionSummary;
  }
  const info=aws(['cloudfront','describe-function','--name',name]);
  aws(['cloudfront','publish-function','--name',name,'--if-match',info.ETag]);
  const existing=aws(['cloudfront','list-distributions']).DistributionList?.Items||[];
  const rows=[];
  for(const item of items) {
    const payload=distribution({batch:item.batch,origins:hosts,priceClass:'PriceClass_All'},item,fn.FunctionMetadata.FunctionARN,keys[item.role]);
    let result=findExisting(existing,payload.DistributionConfig);
    const reused=!!result;
    if(!result) {
      result=aws(['cloudfront','create-distribution-with-tags','--distribution-config-with-tags',JSON.stringify(payload)]).Distribution;
      existing.push(result);
    }
    rows.push({key:item.key,role:item.role,id:result.Id,url:`https://${result.DomainName}`});
    save(rows);
    console.log(`${reused?'REUSED':'CREATED'} ${item.key}: https://${result.DomainName}`);
    if(!reused) delay();
  }
  return rows;
}
function cli() {
  const [batchText,profile,account,option]=process.argv.slice(2);
  const batch=Number(batchText);
  const items=plan(batch,account);
  if(!profile) throw Error('Usage: node scripts/cloudfront-two-accounts.mjs 1|2 PROFILE ACCOUNT_ID [--plan]');
  if(option==='--plan') { console.log(JSON.stringify(items,null,2)); return; }
  if(option) throw Error('Unknown option');
  const dir=join(homedir(),'atlas-cloudfront-two-accounts');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=join(dir,`${account}-${batch}.lock`);
  const fd=openSync(lock,'wx',0o600);
  const output=join(dir,`account-${batch}-${account}.json`);
  const runner=makeAwsRunner({});
  try {
    run(batch,profile,account,args=>runner([...args,'--profile',profile,'--region','us-east-1']),host=>{
      console.log(`Reading origin key from ${host}...`);
      const env=execFileSync('ssh',['-o','ConnectTimeout=15',`${process.env.SSH_USER||'root'}@${host}`,'cat /opt/atlas/.env'],{encoding:'utf8',stdio:['inherit','pipe','inherit']});
      let key=env.match(/^ORIGIN_KEY=(.*)$/m)?.[1]?.trim();
      if(key && /^(['"]).*\1$/.test(key)) key=key.slice(1,-1);
      if(!key || /REPLACE|[\r\n]/.test(key)) throw Error(`Missing origin key: ${host}`);
      return key;
    },rows=>writeFileSync(output,JSON.stringify(rows,null,2)+'\n',{mode:0o600}));
    console.log(`Saved: ${output}\nCreation submitted; deployment continues asynchronously.`);
  } finally {closeSync(fd);unlinkSync(lock);}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.chdir(fileURLToPath(new URL('..',import.meta.url)));
  try {cli();} catch(error) {console.error(error.message);process.exitCode=1;}
}
