import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forwardingState,ownsSsh} from './relay-identity.mjs';
const good='Forwarding HTTP traffic from https://fixture.serveousercontent.com\r\n';
test('allocation and expiry require exact full provider lines and exact matching host',()=>{
 assert.equal(forwardingState(good).expired,false);assert.equal(forwardingState('\x1b[32m'+good+'\x1b[0mPort forwarding for fixture.serveousercontent.com expired\r\n').expired,true);
 for(const text of['prefix '+good,'Forwarding HTTP traffic from https://fixture.serveousercontent.com.evil.example\n','Forwarding HTTP traffic from https://fixture.serveousercontent.com:443\n','Forwarding HTTP traffic from https://fixture.serveousercontent.com/path\n'])assert.equal(forwardingState(text),null);
 assert.equal(forwardingState(good+'Port forwarding for other.serveousercontent.com expired\n').expired,false);assert.equal(forwardingState(good+'prefix Port forwarding for fixture.serveousercontent.com expired\n').expired,false);
});
test('guard requires SSH executable, parent supervisor and exact key/forward/destination tokens',()=>{
 const s={id:'1234-5678-9012-3456',directory:'/tmp/fixture',stateFile:'/tmp/fixture/state.json',ports:{gateway:123}},r={supervisorPid:91},script='/repo/tools/lab/perf-staging/relay.mjs',valid={ppid:'91',comm:'/usr/bin/ssh',args:'ssh -i /tmp/fixture/tunnel-key -R 80:127.0.0.1:123 atlasperf123456789012@serveo.net',parentArgs:'node '+script+' '+s.stateFile};assert.equal(ownsSsh(valid,s,r,script),true);
 for(const bad of[{ppid:'92'},{comm:'node'},{args:valid.args.replace(':123 ',':1234 ')},{args:valid.args.replace('tunnel-key ','tunnel-key-other ')},{args:valid.args.replace('@serveo.net','@evil.example')},{parentArgs:valid.parentArgs.replace('relay.mjs','relay-other.mjs')},{parentArgs:valid.parentArgs.replace('state.json','state-other.json')}])assert.equal(ownsSsh({...valid,...bad},s,r,script),false);
});
