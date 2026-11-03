import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
test('frozen asset activation and rollback retain source/native state',()=>{
 const dir=mkdtempSync('/tmp/atlas-perf-stage-snapshot-test-'),source=join(dir,'source'),snapshot=join(dir,'snapshot');
 try{
  for(const base of[source,snapshot]){for(const p of['dist/web','dist/runtime','dist/opaque-runtime','server'])mkdirSync(join(base,p),{recursive:true});for(const p of['dist/web/index.html','dist/runtime/index.html','dist/opaque-runtime/manifest.json'])writeFileSync(join(base,p),'BASELINE');writeFileSync(join(base,'server/app.mjs'),'fixed-server')}
  writeFileSync(join(snapshot,'dist/web/index.html'),'BASELINE');writeFileSync(join(source,'dist/web/index.html'),'MODIFIED');const native=join(dir,'native-data');writeFileSync(native,'LATER_NATIVE_WRITE');const file=join(dir,'state.json');writeFileSync(file,JSON.stringify({kind:'atlas-performance-staging-v1',directory:dir,stateFile:file,snapshotMain:snapshot,revision:'baseline'}));const tool=resolve('tools/lab/perf-staging/snapshot-update.mjs'),call=(command,value)=>execFileSync(process.execPath,[tool,command,file,value],{encoding:'utf8'});
  assert.equal(readFileSync(join(snapshot,'dist/web/index.html'),'utf8'),'BASELINE');const ready=JSON.parse(call('prepare',join(source,'dist')));assert.equal(ready.activated,false);assert.equal(readFileSync(join(snapshot,'dist/web/index.html'),'utf8'),'BASELINE');call('activate',ready.record);assert.equal(readFileSync(join(snapshot,'dist/web/index.html'),'utf8'),'MODIFIED');call('rollback',ready.record);assert.equal(readFileSync(join(snapshot,'dist/web/index.html'),'utf8'),'BASELINE');assert.equal(readFileSync(native,'utf8'),'LATER_NATIVE_WRITE');assert.equal(readFileSync(join(source,'dist/web/index.html'),'utf8'),'MODIFIED');console.log('BASELINE=BASELINE; MODIFIED=MODIFIED; ROLLBACK=BASELINE; NATIVE=LATER_NATIVE_WRITE; SOURCE=MODIFIED');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
