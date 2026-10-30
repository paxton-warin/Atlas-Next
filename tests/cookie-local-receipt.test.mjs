import test from 'node:test';
import assert from 'node:assert/strict';
import {createCookieLocalReceiptWriter,createCookieLocalReceiptReader,COOKIE_LOCAL_RECEIPT_PROBE} from '../runtime/cookie-local-receipt.ts';
const ORIGIN='https://local.example',DOC='cookie_receipt_synthetic_012345';
function fixture({missingMove=false,failProbe=false}={}){
 const state={failMove:failProbe,failWrite:false,failRemovePending:false,beforePublish:undefined,moves:0,inPlaceWrites:0,readPaths:[],fs:undefined};
 class BlobValue{constructor(parts){this.text=parts.join('');this.size=new TextEncoder().encode(this.text).byteLength;}}
 class Directory{
  constructor(name='',parent){this.name=name;this.parent=parent;this.children=new Map();}
  getDirectory(name,{create=false,exclusive=false}={}){const old=this.children.get(name);if(old){if(exclusive)throw Error('exists');return old;}if(!create)throw Error('missing');const dir=new Directory(name,this);this.children.set(name,dir);return dir;}
  getFile(name,{create=false,exclusive=false}={}){const old=this.children.get(name);if(old){if(exclusive)throw Error('exists');return old;}if(!create)throw Error('missing');const entry={name,parent:this,text:'',remove(){if(this.name==='pending'&&state.failRemovePending)throw Error('cleanup failed');this.parent.children.delete(this.name);},createWriter(){const entry=this;return{write(blob){if(entry.name.startsWith('r')&&entry.text!=='')state.inPlaceWrites++;if(state.failWrite)throw Error('write failed');entry.text=blob.text;},seek(){throw Error('unexpected in-place seek');},truncate(){throw Error('unexpected in-place truncate');}};}};if(!missingMove)entry.moveTo=function(dir,name){state.beforePublish?.(this.text);if(state.failMove)throw Error('move failed');this.parent.children.delete(this.name);this.parent=dir;this.name=name;dir.children.set(name,this);state.moves++;return this;};this.children.set(name,entry);return entry;}
  remove(){if(this.children.size)throw Error('not empty');this.parent?.children.delete(this.name);}
 }
 const root=new Directory();state.fs=root;
 const scope={location:{origin:ORIGIN},crypto:globalThis.crypto,TEMPORARY:0,Blob:BlobValue,btoa:globalThis.btoa,webkitRequestFileSystemSync:(_type,size)=>{state.requestedBytes=size;return{root}}};
 let clock=0;
 class XHR{
  open(method,url,async){assert.equal(method,'GET');assert.equal(async,false);this.url=url;state.readPaths.push(url);}
  setRequestHeader(){throw Error('no range request');}
  send(){let entry=root;for(const part of this.url.slice(('filesystem:'+ORIGIN+'/temporary/').length).split('/'))entry=entry?.children.get(part);this.entry=entry;}
  get status(){return this.entry?200:404;}
  get responseText(){return this.entry?.text||'';}
 }
 const host={location:{origin:ORIGIN},XMLHttpRequest:XHR,performance:{now:()=>++clock}};
 const writer=options=>createCookieLocalReceiptWriter(scope,DOC,options);
 const reader=grant=>createCookieLocalReceiptReader({host,documentId:DOC,grant});
 const dir=w=>root.children.get('atlas-cookie-receipts-v2').children.get(w.grant.directory);
 return{state,writer,reader,dir};
}
test('complete probe publishes atomically before granting a cookie receipt capability',()=>{
 const f=fixture(),w=f.writer();assert.ok(w);assert.equal(f.state.moves,1);assert.equal(f.reader(w.grant).read(0),COOKIE_LOCAL_RECEIPT_PROBE);assert.equal(f.dir(w).children.size,2);assert.equal(f.dir(w).children.has('pending'),false);w.dispose();assert.equal(f.state.fs.children.get('atlas-cookie-receipts-v2').children.size,0);
});
test('alternating short/long packets and same-sequence lost-receipt replay never overwrite/truncate published files',()=>{
 const f=fixture(),w=f.writer(),r=f.reader(w.grant);for(let sequence=1;sequence<=40;sequence++){const packet='x'.repeat(sequence%2?100000:3);w.write(sequence,packet);assert.equal(r.read(sequence),packet);assert.equal(f.dir(w).children.size,2);assert.equal(f.state.inPlaceWrites,0);if(sequence>2)assert.ok(f.dir(w).children.get('r'+sequence%2).text.length>packet.length);}w.write(40,'regenerated');assert.equal(r.read(40),'regenerated');assert.throws(()=>w.write(39,'stale'),{name:'InvalidStateError'});assert.equal(r.read(40),'regenerated');w.dispose();
});
test('an unpublished pending file cannot acknowledge the requested sequence',()=>{
 const f=fixture(),w=f.writer(),r=f.reader(w.grant);let before;f.state.beforePublish=()=>{before=r.read(1);};w.write(1,'committed');assert.equal(before,undefined);assert.equal(r.read(1),'committed');assert.ok(f.state.readPaths.every(p=>!p.endsWith('/pending')));w.dispose();
});
test('rename and write failures preserve the previous slot and remove bounded scratch data',()=>{
 for(const failure of ['failMove','failWrite']){const f=fixture(),w=f.writer(),r=f.reader(w.grant);w.write(1,'before');f.state[failure]=true;assert.throws(()=>w.write(3,'after'));assert.equal(r.read(3),undefined);assert.equal(r.read(1),'before');assert.equal(f.dir(w).children.has('pending'),false);assert.equal(f.dir(w).children.size,2);f.state[failure]=false;w.write(3,'after');assert.equal(r.read(3),'after');w.dispose();}
});
test('failed scratch cleanup stays bounded and does not advance the published identity',()=>{
 const f=fixture(),w=f.writer(),r=f.reader(w.grant);f.state.failMove=true;f.state.failRemovePending=true;assert.throws(()=>w.write(1,'held'));assert.equal(r.read(1),undefined);assert.equal(f.dir(w).children.size,3);assert.throws(()=>w.write(2,'more'),{name:'InvalidStateError'});assert.equal(f.dir(w).children.size,3);f.state.failRemovePending=false;w.dispose();assert.equal(f.state.fs.children.get('atlas-cookie-receipts-v2').children.size,0);
});
test('missing or failing atomic publication fails initialization before advertising a capability',()=>{
 for(const options of [{missingMove:true},{failProbe:true}]){const f=fixture(options);assert.equal(f.writer(),null);assert.equal(f.state.fs.children.get('atlas-cookie-receipts-v2').children.size,0);}
});

test('published high-water lengths use bounded UTF-8 bytes, not JavaScript character counts',()=>{
 const f=fixture(),w=f.writer(),r=f.reader(w.grant);w.write(1,'x'.repeat(1024*1024));const physical=f.dir(w).children.get('r1').text.length;assert.ok(physical<=1024*1024+512);w.write(3,'x');assert.equal(f.dir(w).children.get('r1').text.length,physical);assert.equal(r.read(3),'x');assert.throws(()=>w.write(4,'界'.repeat(400000)),RangeError);assert.equal(r.read(4),undefined);assert.equal(f.dir(w).children.size,2);w.dispose();
});


test('split operation grants keep getter high-water bytes out of setter files',()=>{
 const f=fixture(),w=f.writer({splitOperations:true}),r=f.reader(w.grant);assert.equal(w.grant.protocol,'atlas-cookie-local-receipt-v3');assert.equal(r.splitOperations,true);
 assert.equal(r.read(0,'get'),COOKIE_LOCAL_RECEIPT_PROBE);assert.equal(r.read(0,'set'),COOKIE_LOCAL_RECEIPT_PROBE);assert.equal(f.dir(w).children.size,4);
 w.write(1,'g'.repeat(100000),'get');assert.equal(r.read(1,'get').length,100000);assert.equal(r.read(1,'set'),undefined);
 w.write(2,'set','set');assert.equal(r.read(2,'set'),'set');const short=f.dir(w).children.get('s0').text.length;assert.ok(short<512);
 w.write(3,'G'.repeat(150000),'get');w.write(4,'s','set');assert.equal(r.read(4,'set'),'s');assert.equal(f.dir(w).children.get('s0').text.length,short);
 w.write(5,'S','set');w.write(6,'g'.repeat(180000),'get');w.write(7,'x','set');assert.equal(r.read(7,'set'),'x');assert.ok(f.dir(w).children.get('s1').text.length<512);
 assert.ok(f.dir(w).children.get('g0').text.length>180000);assert.ok(f.dir(w).children.get('g1').text.length>150000);
 assert.equal(f.state.inPlaceWrites,0);assert.equal(f.dir(w).children.size,4);assert.equal(f.dir(w).children.has('pending'),false);
 w.write(7,'replay','set');assert.equal(r.read(7,'set'),'replay');assert.throws(()=>w.write(6,'stale','get'),{name:'InvalidStateError'});
 assert.throws(()=>w.write(8,'bad','unexpected'),{name:'InvalidStateError'});assert.equal(r.read(8,'unexpected'),undefined);
 w.dispose();assert.equal(f.state.fs.children.get('atlas-cookie-receipts-v2').children.size,0);
});
test('split operation publication failures preserve authenticated old paths and bounded scratch',()=>{
 const f=fixture(),w=f.writer({splitOperations:true}),r=f.reader(w.grant);w.write(1,'original-set','set');w.write(2,'snapshot','get');
 f.state.failMove=true;assert.throws(()=>w.write(3,'new-set','set'));assert.equal(r.read(3,'set'),undefined);assert.equal(r.read(1,'set'),'original-set');assert.equal(r.read(2,'get'),'snapshot');assert.equal(f.dir(w).children.size,4);
 f.state.failMove=false;w.write(3,'new-set','set');assert.equal(r.read(3,'set'),'new-set');w.dispose();
});
test('a split capability is never advertised when its second operation probe fails',()=>{
 const f=fixture();f.state.beforePublish=()=>{if(f.state.moves===1)f.state.failMove=true};assert.equal(f.writer({splitOperations:true}),null);assert.equal(f.state.fs.children.get('atlas-cookie-receipts-v2').children.size,0);
});
test('legacy receipt grants remain readable without silently claiming split operation support',()=>{
 const f=fixture(),w=f.writer(),r=f.reader(w.grant);assert.equal(r.splitOperations,false);w.write(1,'legacy');assert.equal(r.read(1,'set'),'legacy');assert.equal(r.read(1,'get'),'legacy');assert.equal(f.reader({...w.grant,protocol:'atlas-cookie-local-receipt-v4'}),null);w.dispose();
});


test('split working-set hint covers all bounded lanes and one atomic pending file',()=>{
 const f=fixture(),w=f.writer({splitOperations:true}),r=f.reader(w.grant);let peak=0;
 f.state.beforePublish=()=>{const files=[...f.dir(w).children.values()];assert.ok(files.length<=5);const bytes=files.reduce((n,file)=>n+new TextEncoder().encode(file.text).length,0);peak=Math.max(peak,bytes);assert.ok(bytes<=f.state.requestedBytes)};
 for(const[sequence,operation]of[[1,'get'],[2,'get'],[3,'set'],[4,'set'],[5,'get']]){w.write(sequence,'x'.repeat(1024*1024),operation);assert.equal(r.read(sequence,operation).length,1024*1024)}
 assert.ok(peak>5*1024*1024);assert.equal(f.state.requestedBytes,5*(1024*1024+512));assert.equal(f.dir(w).children.size,4);w.dispose();
});
