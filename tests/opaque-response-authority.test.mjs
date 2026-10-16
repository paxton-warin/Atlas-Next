import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpaqueNetworkClient} from '../runtime/opaque-runtime-adapter.ts';
import {bindSandboxNetwork} from '../runtime/sandbox-network.ts';
function fixture() {
  const channel = new MessageChannel(), documentId='response-authority-test';
  const owner=bindSandboxNetwork({port:channel.port1,documentId,documentURL:'https://site.test/',frontendOrigin:'https://atlas.test',fetch:async request=>({url:request.url,status:200,statusText:'OK',headers:[['content-type','text/plain'],['set-cookie','private=value']],body:new TextEncoder().encode('payload').buffer})});
  const client=createOpaqueNetworkClient({port:channel.port2,documentId,documentURL:'https://site.test/'});
  return {client,close(){client.dispose();owner.dispose();}};
}
test('private response authority follows prototype and instance clones without trusting public type', async()=>{
  const nativeClone=Response.prototype.clone,s=fixture();
  try {
    const response=await s.client.fetch('/body');
    assert.deepEqual(s.client.describeCacheResponse(response),{type:'basic',url:'https://site.test/body',redirected:false});
    const clone=Response.prototype.clone.call(response), twice=clone.clone();
    assert.equal(clone.type,'basic');assert.equal(twice.url,'https://site.test/body');
    assert.equal(await twice.text(),'payload');
    assert.deepEqual(s.client.describeCacheResponse(clone),s.client.describeCacheResponse(response));
    assert.equal(clone.headers.get('set-cookie'),null);
    const synthetic=new Response('synthetic');Object.defineProperty(synthetic,'type',{value:'opaque'});
    assert.equal(s.client.describeCacheResponse(synthetic),undefined);
    assert.throws(()=>Response.prototype.clone.call({}),TypeError);
    await clone.text();assert.throws(()=>Response.prototype.clone.call(clone),TypeError);
  } finally {s.close();}
  assert.equal(Response.prototype.clone,nativeClone);
});
test('prototype cloning cannot launder an opaque response to synthetic default metadata',async()=>{
  const s=fixture();try {
    const response=await s.client.fetch('https://peer.test/private',{mode:'no-cors'}), clone=Response.prototype.clone.call(response);
    assert.equal(response.type,'opaque');assert.equal(clone.type,'opaque');
    assert.deepEqual(s.client.describeCacheResponse(clone),{type:'opaque',url:'',redirected:false});
    assert.equal(clone.status,0);assert.equal(clone.body,null);assert.equal(await clone.text(),'');
  }finally{s.close();}
});
test('concurrent clients share clone tracking until the last private owner is disposed',async()=>{
  const nativeClone=Response.prototype.clone,a=fixture(),b=fixture(),wrapper=Response.prototype.clone;
  try {const response=await b.client.fetch('/body');a.close();assert.equal(Response.prototype.clone,wrapper);const clone=Response.prototype.clone.call(response);assert.equal(b.client.describeCacheResponse(clone).type,'basic');}
  finally{a.close();b.close();}
  assert.equal(Response.prototype.clone,nativeClone);
});
