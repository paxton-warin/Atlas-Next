import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const {build}=createRequire(import.meta.resolve('vite'))('esbuild');
test('all three dedicated native actors have no Hub, publication, permit, journal or backup codec dependency',async()=>{
 const results=[];
 for(const name of ['local-native-worker','cookie-native-worker-v2','storage-native-worker-v2']) {
  const result=await build({entryPoints:['runtime/'+name+'.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',metafile:true,logLevel:'silent'}),
    source=result.outputFiles[0].text,inputs=Object.keys(result.metafile.inputs),
    remote=inputs.filter(path=>/profile-permissions|profile-journal|profile-sync|hub-contracts|backup-v2|hub-profile/.test(path));
  assert.deepEqual(remote,[],name+' must load only local authority/native implementation');
  assert.equal(/encodePortableValue|assertProfileWrite|appendProfileJournal|withProfileGroupLock|navigator\.onLine|new WebSocket\(|fetch\(/.test(source),false,name+' must not possess cloud-write prerequisites');
  const hashes={};for(const path of inputs.filter(path=>path.startsWith('runtime/')))hashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  results.push({entry:name,bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex'),remoteDependencies:remote,sourceHashes:hashes});
 }
 await mkdir('evidence/local-first-backups-20261028',{recursive:true});
 await writeFile('evidence/local-first-backups-20261028/NATIVE_ACTOR_DEPENDENCIES.json',JSON.stringify({productionChanged:false,result:'PASS',results},null,2)+'\n');
});
