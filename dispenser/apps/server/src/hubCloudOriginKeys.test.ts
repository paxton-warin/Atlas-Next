import { describe,it,expect } from 'vitest';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';import{tmpdir}from'node:os';
import {loadCloudOriginKeys} from './hubCloudOriginKeys.js';
import {distributionConfig,type CloudResource} from './hubCloudWorker.js';
const resource=(host:string,role:CloudResource['role']='node'):CloudResource=>({key:'node',role,logicalId:'stable-node',originHost:host});
describe('private per-origin routing keys',()=>{
 it('keeps each physical origin key separate without changing the immutable resource plan',()=>{
  const map={'main.example':'main-private-key-0000','node.example':'node-private-key-0000'};
  const main=distributionConfig('job',resource('main.example','frontend'),'arn',map);
  const node=distributionConfig('job',resource('node.example'),'arn',map);
  expect(main.DistributionConfig.Origins.Items[0]!.CustomHeaders.Items?.[0]?.HeaderValue).toBe(map['main.example']);
  expect(node.DistributionConfig.Origins.Items[0]!.CustomHeaders.Items?.[0]?.HeaderValue).toBe(map['node.example']);
  expect(JSON.stringify(resource('main.example'))).not.toContain('private-key');
 });
 it('fails on an unmapped non-Hub origin, rather than leaking another server key',()=>{
  expect(()=>distributionConfig('job',resource('missing.example'),'arn',{'node.example':'secret-private-0000'})).toThrow('ORIGIN_KEY_REQUIRED');
  expect(distributionConfig('job',resource('hub.example','hub'),'arn',{}).DistributionConfig.Origins.Items[0]!.CustomHeaders.Quantity).toBe(0);
 });
 it('requires a key on a Hub host only when explicitly present in the private map',()=>{
  const c=distributionConfig('job',resource('gateway.example','hub'),'arn',{'gateway.example':'isolated-private-gateway-key'});
  expect(c.DistributionConfig.Origins.Items[0]!.CustomHeaders.Quantity).toBe(1);
  expect(c.DistributionConfig.Origins.Items[0]!.CustomHeaders.Items?.[0]?.HeaderValue).toBe('isolated-private-gateway-key');
 });
 it('preserves the explicitly configured legacy single-key adapter',()=>{
  expect(distributionConfig('job',resource('node.example'),'arn','legacy-secret').DistributionConfig.Origins.Items[0]!.CustomHeaders.Items?.[0]?.HeaderValue).toBe('legacy-secret');
 });
 it('loads only a bounded owner-only regular JSON file and never echoes malformed secret contents',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'atlas-origin-keys-'));try{
   const file=join(dir,'keys.json');await writeFile(file,JSON.stringify({'node.example':'node-private-key-0000'}),{mode:0o600});
   const map=loadCloudOriginKeys(file)!;expect(map['node.example']).toBe('node-private-key-0000');expect(Object.isFrozen(map)).toBe(true);
   await chmod(file,0o644);expect(()=>loadCloudOriginKeys(file)).toThrow('ORIGIN_KEYS_FILE_INVALID');await chmod(file,0o600);
   await writeFile(file,'{"SECRET_VALUE_DO_NOT_LOG"');try{loadCloudOriginKeys(file);throw Error('expected failure')}catch(e){expect(String(e)).toBe('Error: ORIGIN_KEYS_FILE_INVALID')}
   await writeFile(file,JSON.stringify({'node.example':'bad\nsecret-value-000'}));expect(()=>loadCloudOriginKeys(file)).toThrow('ORIGIN_KEYS_FILE_INVALID');
   const alias=join(dir,'alias');await symlink(file,alias);expect(()=>loadCloudOriginKeys(alias)).toThrow('ORIGIN_KEYS_FILE_INVALID');
   await writeFile(file,JSON.stringify({'https://node.example':'node-private-key-0000'}));expect(()=>loadCloudOriginKeys(file)).toThrow('ORIGIN_KEYS_FILE_INVALID');
  }finally{await rm(dir,{recursive:true,force:true})}
 });
});
