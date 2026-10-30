// Refresh only the local Atlas process against the frozen candidate. Preserve
// the existing lab identity, databases, Hub, HTTPS proxy and private browser data.
import {readFile,writeFile,mkdir,symlink,open} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {cleanEnvironment} from './hub-lab.mjs';
const root=process.cwd(),lab=JSON.parse(execFileSync(process.execPath,['scripts/hub-lab.mjs','status'],{encoding:'utf8'}));
const statePath=join(lab.directory,'state.json'),s=JSON.parse(await readFile(statePath));
if(new URL(s.databaseUrl).pathname!=='/atlas_hub_lab_test')throw Error('Expected existing isolated lab database');
const cwd=resolve('evidence/cookie-cadence-20261022/candidate/Atlas-Next');
for(const name of ['web','runtime'])try{await symlink(resolve('evidence/cookie-cadence-20261022/release',name),join(cwd,'dist',name))}catch(e){if(e.code!=='EEXIST')throw e}
const old=s.processes.find(p=>p.label==='atlas');if(!old)throw Error('Existing local Atlas process missing');
process.kill(old.pid,'SIGTERM');for(let i=0;i<100;i++){try{process.kill(old.pid,0)}catch{break}await new Promise(r=>setTimeout(r,100))}
const log=await open(join(lab.directory,'atlas.log'),'a',0o600);
const child=spawn(process.execPath,['--import',join(root,'scripts/hub-lab-dns.mjs'),join(root,'scripts/hub-lab-atlas.mjs'),'--lab-state='+statePath],{cwd,env:cleanEnvironment({APP_ORIGIN:'https://localhost:4280',RUNTIME_ORIGIN:'https://127.0.0.1:4281',ATLAS_HUB_ORIGIN:'https://localhost:4300',ATLAS_HUB_BRANCH_ID:s.branchId,ATLAS_HUB_BRANCH_SECRET:s.branchSecret,ATLAS_HUB_UI_ONLY_LAB:'false',LOCAL_RELAY_MODE:'frontend',ATLAS_BROWSER_RUNTIME:'same-origin-profile',OPAQUE_ASSETS_DIR:join(cwd,'dist/opaque-runtime'),ATLAS_HUB_SERVICE_SECRET:s.serviceSecret,TRUST_PROXY:'127.0.0.1/32,::1/128',DATA_DIR:join(lab.directory,'atlas'),ATLAS_TEST_FIXTURE:'1',ATLAS_TEST_FIXTURE_PORT:'4299',ATLAS_LAB_STATE:statePath,NODE_EXTRA_CA_CERTS:join(lab.directory,'cert.pem')}),stdio:['ignore',log.fd,log.fd],detached:true});child.unref();await log.close();old.pid=child.pid;await writeFile(statePath,JSON.stringify(s,null,2),{mode:0o600});
for(let i=0;i<100;i++){const r=await fetch('http://127.0.0.1:4286/health').catch(()=>null);if(r?.ok){console.log('LOCAL_CANDIDATE=READY; existing data retained; only Atlas process refreshed');process.exit(0)}await new Promise(r=>setTimeout(r,200))}throw Error('Local candidate health timed out');
