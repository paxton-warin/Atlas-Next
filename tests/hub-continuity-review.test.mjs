import test from 'node:test';
import assert from 'node:assert/strict';
import {localOrigin,reviewOptions,reviewMode,SOURCE,TARGET,FIXTURE,COOKIE_CLICKER} from '../scripts/hub-continuity-review.mjs';
test('review uses distinct existing local aliases and the deterministic website fixture',()=>{
 assert.notEqual(SOURCE,TARGET);assert.equal(localOrigin(SOURCE),SOURCE);assert.equal(localOrigin(TARGET),TARGET);assert.equal(FIXTURE,'http://fixture.localhost:4299/storage');
 for(const value of ['https://example.com:4280','http://localhost:4280','https://user@localhost:4280','https://localhost:4280/path','https://localhost:4280/?x=1','https://localhost:4280/#x','https://localhost:4300'])assert.throws(()=>localOrigin(value));
});
test('Cookie Clicker preparation uses the actual official game, not the diagnostic fixture',()=>{
 assert.equal(COOKIE_CLICKER,'https://orteil.dashnet.org/cookieclicker/');
 assert.deepEqual(reviewMode('--prepare-cookie-clicker'),{mode:'--prepare-cookie-clicker',temporary:false,cookieClicker:true});
 assert.deepEqual(reviewMode('--verify-only'),{mode:'--verify-only',temporary:true,cookieClicker:false});
 assert.equal(reviewMode().cookieClicker,false);assert.throws(()=>reviewMode('--unknown'));
});
test('new review browser trusts only the calculated public key and keeps ordinary TLS enforcement enabled',()=>{
 const spki='a'.repeat(43)+'=',options=reviewOptions({executable:'/browser',spki});
 assert.equal(options.ignoreHTTPSErrors,false);assert.equal(options.headless,false);
 assert.deepEqual(options.args,['--host-resolver-rules=MAP *.localhost 127.0.0.1','--ignore-certificate-errors-spki-list='+spki]);
 assert.ok(!options.args.includes('--ignore-certificate-errors'));assert.ok(!options.args.some(x=>x.startsWith('--ignore-certificate-errors=')));
 assert.throws(()=>reviewOptions({executable:'/browser',spki:'unverified'}));
});
