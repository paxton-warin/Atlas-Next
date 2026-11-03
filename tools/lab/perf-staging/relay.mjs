/** Actual-exit SSH relay supervisor; never retries an HTTP application request. */
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,openSync,closeSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {forwardingState} from './relay-identity.mjs';
const file=process.argv[2],initial=JSON.parse(readFileSync(file));if(initial.kind!=='atlas-performance-staging-v1'||!initial.publicEdge)throw Error('Marked isolated edge stack required');
const dir=initial.directory,root=dirname(dirname(fileURLToPath(import.meta.url)));let child,stopped=false,timer,attempt=0,prior=initial.tunnelOrigin;
const edit=change=>{const s=JSON.parse(readFileSync(file));change(s);const temp=file+'.relay-'+process.pid;writeFileSync(temp,JSON.stringify(s,null,2)+'\n',{mode:0o600});renameSync(temp,file)};
function connect(){if(stopped)return;attempt++;const s=JSON.parse(readFileSync(file));const log=join(dir,'relay-session-'+attempt+'.log'),fd=openSync(log,'a',0o600);let text='',allocated=false,allocatedHost='',expiryHandled=false;
 child=spawn('ssh',['-T','-4','-F','/dev/null','-p','443','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+join(dir,'serveo_known_hosts'),'-i',join(dir,'tunnel-key'),'-R','80:127.0.0.1:'+s.ports.gateway,'atlasperf'+s.id.replaceAll('-','').slice(0,12)+'@serveo.net'],{stdio:['ignore','pipe','pipe']});
 const session=child;edit(s=>{s.relay={supervisorPid:process.pid,sshPid:child.pid,attempt,state:'connecting',startedAt:new Date().toISOString()}});
 function output(b){writeFileSync(fd,b);text+=b.toString();if(text.length>20000)text=text.slice(-20000);
 const observed=forwardingState(text);
 if(!allocated&&observed){allocated=true;allocatedHost=observed.host;const next=observed.origin,changed=!!prior&&next!==prior;edit(s=>{s.tunnelOrigin=next;s.relay={...s.relay,state:'allocated',browserOriginsChanged:false,backendDomainChanged:changed,allocatedAt:new Date().toISOString()}});console.log('RELAY_ALLOCATED attempt='+attempt+' backendDomainChanged='+changed+' browserOriginsChanged=false');if(changed){try{execFileSync(process.execPath,[join(root,'perf-staging/edge.mjs'),'update-origin',file],{stdio:'inherit'});console.log('OWN_STAGING_EDGE_ORIGINS_UPDATED; browser origins unchanged')}catch(error){console.error('OWN_EDGE_ORIGIN_UPDATE_FAILED: '+error.message)}}prior=next}
 if(allocated&&!expiryHandled&&observed?.expired&&observed.host===allocatedHost){expiryHandled=true;edit(s=>{s.relay={...s.relay,state:'forwarding-expired',expiredAt:new Date().toISOString(),authoritative:true}});console.log('RELAY_FORWARDING_EXPIRED_NOTICE; terminating owned SSH child');session.kill('SIGTERM')}
 }
 child.stdout.on('data',output);child.stderr.on('data',output);child.on('error',error=>console.error('SSH_SPAWN_ERROR '+error.code));child.on('close',(code,signal)=>{closeSync(fd);edit(s=>{s.relay={...s.relay,state:'closed',exitStatus:code,signal,closedAt:new Date().toISOString()}});console.log('RELAY_ACTUAL_EXIT code='+code+' signal='+signal);if(!stopped)timer=setTimeout(connect,2000)})}
for(const sig of['SIGTERM','SIGINT'])process.once(sig,()=>{stopped=true;clearTimeout(timer);child?.kill('SIGTERM');setTimeout(()=>process.exit(0),500).unref()});connect();
