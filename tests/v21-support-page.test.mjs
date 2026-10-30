import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source = name => readFile(process.env.ATLAS_SUPPORT_SOURCE_ROOT ? process.env.ATLAS_SUPPORT_SOURCE_ROOT+'/'+name : new URL('../web/src/'+name,import.meta.url),'utf8');
test('support uses the persistent page outlet and notification opening selects that page',async()=>{
 const app=await source('App.tsx'),support=await source('HubSupportPanel.tsx');
 assert.match(app,/active=\{page === "support"\}/);
 assert.match(app,/className="support-page-outlet"[^>]*hidden=\{page !== "support"\}/);
 assert.match(app,/onOpen=\{\(\) => \{[\s\S]*?setPage\("support"\)/);
 assert.match(app,/aria-current=\{page === key/);
 assert.match(support,/createPortal\(/);
 assert.match(support,/className="page hub-support-page"/);
 assert.doesNotMatch(support,/hub-support-backdrop|aria-modal="true"|Close support/);
 assert.match(support,/onClick=\{\(\) => openNotification\(notification\)\}/);
 assert.match(support,/if \(!isAnnouncement\(notification\)\) \{ show\(notification.ticket_id \|\| undefined\)/);
 assert.match(support,/drafts\.current\.set\(selectedRef\.current, bodyRef\.current\)/);
 assert.equal((support.match(/new EventSource\(/g)||[]).length,1);
 assert.match(support,/if \(!open \|\| !selected \|\| !messages\.length \|\| announcement\) return/);
 assert.match(support,/active\.current\.open/);
 assert.match(support,/\) : \(\s*legacySupport/);
});
test('support page no longer uses viewport-sized dialog geometry',async()=>{
 const css=await source('HubGate.css');
 assert.doesNotMatch(css,/hub-support-backdrop|\.hub-support-panel\{[^}]*height:min/);
 assert.match(css,/\.hub-support-columns\{grid-template-columns:240px minmax\(0,1fr\)/);
});
test('managed about:blank popups do not pass non-web URLs into external popout creation',async()=>{
 const app=await source('App.tsx');
 assert.match(app,/if \(opaqueMode\) \{[\s\S]*?\/\^https\?:\\\/\\\/\/i\.test\(current\.url\)[\s\S]*?\? createPopoutUrl\(/);
});

test('persistent browsing keyboard callbacks use the latest shell state without remounting',async()=>{
 const app=await source('App.tsx');
 assert.match(app,/const focusSearchRef = useRef\(focusSearch\)/);
 assert.match(app,/focusSearchRef\.current = focusSearch/);
 assert.match(app,/event\.type === "focus-search"\) \{ focusSearchRef\.current\(\)/);
});


test('announcements use the existing mixed notification bell without changing support routing or SSE lifetime',async()=>{
 const support=await source('HubSupportPanel.tsx');
 assert.match(support,/kind\?: "support" \| "announcement"/);
 assert.match(support,/notificationRefresh\(seen.current, value.notifications\)/);
 assert.match(support,/function openNotification/);
 assert.match(support,/show\(notification.ticket_id \|\| undefined\)/);
 assert.equal((support.match(/new EventSource\(/g)||[]).length,1);
 assert.match(support,/New announcement: /);
});
test('announcement read ACK requires loaded visible native detail and account-context matching',async()=>{
 const support=await source('HubSupportPanel.tsx');
 assert.match(support,/<dialog ref=\{dialog\} className="hub-announcement-dialog"/);
 assert.match(support,/document.visibilityState !== "visible"/);
 assert.match(support,/!body.current\?\.isConnected/);
 assert.match(support,/!body.current.getClientRects\(\).length \|\| !value/);
 assert.match(support,/announcement.notification_id !== notification.id/);
 assert.match(support,/active.grant\?\.contextId !== session.grant\?\.contextId/);
 assert.match(support,/Retry marking as read/);
 assert.doesNotMatch(support,/dangerouslySetInnerHTML/);
 assert.match(support,/setAnnouncement\(null\);[\s\S]*?drafts.current.clear/);
});


test('actual notification cursor stays monotonic across unread-first reorder, read, withdrawal and bigint IDs',async()=>{
 const support=await source('HubSupportPanel.tsx');
 const begin=support.indexOf('export function notificationRefresh('),end=support.indexOf('type Announcement =',begin);
 assert.ok(begin>=0&&end>begin);
 const compiled=ts.transpileModule(support.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const exports={};runInNewContext(compiled,{exports});const update=exports.notificationRefresh;
 const item=(id,read=false)=>({id,read_at:read?'read':null});
 let r=update('100',[item('12'),item('101',true)]);assert.equal(r.seen,'101');assert.equal(r.latest,undefined);
 r=update(r.seen,[item('12'),item('100',true)]);assert.equal(r.seen,'101');assert.equal(r.latest,undefined);
 r=update(r.seen,[]);assert.equal(r.seen,'101');assert.equal(r.latest,undefined);
 r=update(r.seen,[item('102'),item('103'),item('99')]);assert.equal(r.seen,'103');assert.equal(r.latest.id,'103');
 r=update('9007199254740992',[item('9007199254740993')]);assert.equal(r.seen,'9007199254740993');assert.equal(r.latest.id,'9007199254740993');
 r=update('0',[item('12'),item('101',true)]);assert.equal(r.seen,'101');assert.equal(r.latest.id,'12');
 assert.doesNotMatch(support,/seen.current = value.notifications\[0\]/);
});
