import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
function configured(value){const env={...process.env};delete env.ATLAS_LOCAL_FIRST_V2;delete env.ATLAS_LOCAL_FIRST_V2_CANDIDATE;if(value!==undefined)env.ATLAS_LOCAL_FIRST_V2=value;const result=spawnSync(process.execPath,['--input-type=module','-e',"import config from './vite.config.ts'; console.log(config.define.__ATLAS_LOCAL_FIRST_V2__);"],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
test('native-only builds cannot revive retired replication through environment',()=>{assert.equal(configured(undefined),'true');assert.equal(configured('1'),'true');assert.equal(configured('0'),'true');});
