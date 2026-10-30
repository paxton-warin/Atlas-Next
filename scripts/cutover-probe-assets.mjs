import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const canonicalProbeJSON = value => Array.isArray(value) ? '[' + value.map(canonicalProbeJSON).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonicalProbeJSON(v)).join(',') + '}' : JSON.stringify(value);
export const probeDigest = value => createHash('sha256').update(canonicalProbeJSON(value)).digest('hex');
export async function createProbeAssetManifest(atlasRoot, hubRoot) {
  async function entry(directory) {
    const html = await readFile(join(directory,'index.html'),'utf8');
    const paths = ['/index.html', ...[...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(m=>m[1])];
    const files=[];for(const path of [...new Set(paths)])files.push({path,sha256:createHash('sha256').update(await readFile(join(directory,path.slice(1)))).digest('hex')});return files;
  }
  const frontend = await entry(join(atlasRoot,'dist/web')), hub = await entry(join(hubRoot,'apps/web/dist'));
  const html=await readFile(join(atlasRoot,'dist/web/index.html'),'utf8');
  // The module worker is referenced by the entry graph, not directly in HTML.
  const js=await readFile(join(atlasRoot,'dist/web',frontend.find(v=>v.path.endsWith('.js')).path.slice(1)),'utf8');
  const worker=js.match(/profile-local-worker-[A-Za-z0-9_-]+\.js/)?.[0];
  if(!worker)throw Error('Profile-local worker asset not found');
  const path='/assets/'+worker;frontend.push({path,sha256:createHash('sha256').update(await readFile(join(atlasRoot,'dist/web',path.slice(1)))).digest('hex')});
  const node=[];for(const file of['runtime/runtimekit.js','manifest.json'])node.push({path:'/browse/runtime/'+file,sha256:createHash('sha256').update(await readFile(join(atlasRoot,'dist/runtime',file))).digest('hex')});
  return {format:'atlas-runtime-probe-assets-v1',roles:{frontend,hub,node}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);if(args.size!==3||!args.get('--atlas')||!args.get('--hub')||!args.get('--out'))throw Error();
 const manifest=await createProbeAssetManifest(resolve(args.get('--atlas')),resolve(args.get('--hub')));await writeFile(resolve(args.get('--out')),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});process.stdout.write('ASSET_MANIFEST_SHA256='+probeDigest(manifest)+'\n');}
 catch{process.stderr.write('ASSET_MANIFEST=FAILED\n');process.exitCode=1;}
}
