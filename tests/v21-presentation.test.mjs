import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {profileStatusLabel} from '../web/src/profile-status-view.ts';
import {anchoredPopover} from '../web/src/v21-popover.ts';
import {contrastInk} from '../web/src/v21-theme.ts';
test('V2.1 save labels never turn pending, offline or failed writes into cloud success',()=>{
 const expect={synced:'Synced',restoring:'Restoring…',pending:'Sync pending',offline:'Saved locally · offline',conflict:'Needs attention',error:'Sync issue',local:'Saved locally'};
 for(const [state,label] of Object.entries(expect))assert.equal(profileStatusLabel({state,message:''}),label);
 assert.equal(profileStatusLabel({state:'local',message:'Portable saves are backed up. Some data remains local.'}),'Partial backup');
});
test('V2.1 custom accent chooses contrasting ink without changing the stored color',()=>{
 assert.equal(contrastInk('#ffffff'),'#0b100d');assert.equal(contrastInk('#000000'),'#ffffff');assert.equal(contrastInk('#bce39b'),'#0b100d');assert.equal(contrastInk('#406e2e'),'#ffffff');
});
test('V2.1 self-hosted fonts have recorded license and byte hashes',async()=>{
 const base=new URL('../web/public/fonts/v21/',import.meta.url);const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
 assert.deepEqual(manifest.map(f=>f.family),['Inter','Inter Tight','Lora','JetBrains Mono']);
 for(const font of manifest){assert.equal(createHash('sha256').update(await readFile(new URL(font.file,base))).digest('hex'),font.sha256);assert.match(await readFile(new URL(font.license,base),'utf8'),/SIL OPEN FONT LICENSE/);}
});
test('V2.1 activity does not open a conversation directly or create another support subscription',async()=>{
 const source=await readFile(new URL('../web/src/HubSupportPanel.tsx',import.meta.url),'utf8');
 assert.match(source,/aria-label=\{\s*count\s*\? `Notifications/);assert.match(source,/onClick=\{\(\) => setActivityOpen\(\(value\) => !value\)\}/);
 assert.equal((source.match(/new EventSource\(/g)||[]).length,1);
 assert.match(source,/if \(!open \|\| !selected \|\| !messages\.length \|\| announcement\) return/);
});
test('V2.1 checking gate does not offer a sign-in or destructive import choice before state resolves',async()=>{
 const source=await readFile(new URL('../web/src/HubGate.tsx',import.meta.url),'utf8');
 assert.match(source,/const importing = !!state\?\.authenticated && !!profileStatus\.importing/);
 assert.match(source,/"Opening Atlas"/);assert.match(source,/state\?\.enabled && !state.authenticated/);
 assert.match(source,/!loading && !busy && \(error \|\| state\?\.authenticated\)/);
});

test('V2.1 account popovers stay near their control in the left rail and mobile header',()=>{
 const rail=anchoredPopover({left:10,top:780,bottom:824},{width:1440,height:900});
 assert.equal(rail.left,12);assert.equal(rail.bottom,130);assert.equal(rail.top,'auto');
 const mobile=anchoredPopover({left:285,top:8,bottom:52},{width:320,height:844});
 assert.equal(mobile.width,296);assert.equal(mobile.left,12);assert.equal(mobile.top,62);
 assert.equal(mobile.maxHeight,770);
});
