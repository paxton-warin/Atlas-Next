/** Provider-log and exact process identity checks, with no signalling side effects. */
import {join,basename} from 'node:path';
export function forwardingState(text){
 const clean=text.replace(/\x1b\[[0-9;]*m/g,'');
 const match=clean.match(/(?:^|\r?\n)Forwarding HTTP traffic from (https:\/\/[a-z0-9.-]+)\r?(?=\n|$)/);
 if(!match)return null;const url=new URL(match[1]);if(url.protocol!=='https:'||url.port||!url.hostname.endsWith('.serveousercontent.com'))return null;
 const notices=[...clean.matchAll(/(?:^|\r?\n)Port forwarding for ([a-z0-9.-]+) expired\r?(?=\n|$)/g)];
 return {origin:url.origin,host:url.hostname,expired:notices.some(m=>m[1]===url.hostname)};
}
export function ownsSsh(observed,state,relay,script){
 const args=observed.args.trim().split(/\s+/),parent=observed.parentArgs.trim().split(/\s+/),get=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:null};
 return Number(observed.ppid)===relay.supervisorPid&&basename(observed.comm.trim())==='ssh'&&basename(args[0])==='ssh'&&get('-i')===join(state.directory,'tunnel-key')&&get('-R')==='80:127.0.0.1:'+state.ports.gateway&&args.at(-1)==='atlasperf'+state.id.replaceAll('-','').slice(0,12)+'@serveo.net'&&parent.includes(script)&&parent.includes(state.stateFile);
}
