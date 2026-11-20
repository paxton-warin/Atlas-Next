import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {createGfnImaSourceAdapter,adaptGfnIma,GFN_IMA_INPUTS,GFN_IMA_OUTPUTS} from '../scripts/runtime-gfn-ima.mjs';
import {adaptNormalRuntimeCore} from '../scripts/runtime-normal-core.mjs';
import {adaptRuntimeWorkerGlobals} from '../scripts/runtime-worker-globals.mjs';
import {adaptToggleAttribute} from '../scripts/runtime-toggle-attribute.mjs';
import {adaptLiteralEval} from '../scripts/runtime-literal-eval.mjs';
import {adaptRequestCancellationCore} from '../scripts/runtime-request-cancellation.mjs';
import {adaptModuleIdentity,adaptModuleIdentityForPreCancellationRelease,MODULE_IDENTITY_OUTPUTS,MODULE_IDENTITY_PRE_CANCELLATION_OUTPUTS} from '../scripts/runtime-module-identity.mjs';

const sdkURL = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';
const fixture = await readFile(new URL('./fixtures/gfn-ima-source.js',import.meta.url),'utf8');
const insertion = 'b.srcdoc=gk(fk("")),';
const seam = 'c=new Promise(function(k){b.addEventListener("load",function(){k()})}),a.appendChild(b),h.h(c,2)';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const adapt = createGfnImaSourceAdapter();

test('qualified classic SDK changes only the measurement factory before append',()=>{
  const output = adapt(fixture,sdkURL);
  assert.notEqual(output,fixture);
  assert.equal(output.length-fixture.length,insertion.length);
  assert.equal(output.split(insertion).length,2);
  assert.equal(output.replace(insertion,''),fixture);
  assert.ok(output.includes(seam.replace('a.appendChild(b)',insertion+'a.appendChild(b)')));
  new vm.Script(fixture);new vm.Script(output);
});

test('preserves string and Uint8Array source types and never mutates input',()=>{
  const bytes = new TextEncoder().encode(fixture), before = bytes.slice();
  const output = adapt(bytes,sdkURL,false);
  assert.ok(output instanceof Uint8Array);
  assert.notEqual(output,bytes);
  assert.deepEqual(bytes,before);
  assert.equal(new TextDecoder().decode(output),adapt(fixture,sdkURL,false));
  const foreign = vm.runInNewContext('new Uint8Array('+JSON.stringify([...bytes])+')');
  assert.equal(new TextDecoder().decode(adapt(foreign,sdkURL)),adapt(fixture,sdkURL));
});

test('only the exact public HTTPS SDK identity and classic scripts qualify',()=>{
  for(const url of [undefined,'','ima3.js','http://imasdk.googleapis.com/js/sdkloader/ima3.js',
    'https://other.fixture.test/js/sdkloader/ima3.js','https://imasdk.googleapis.com/js/sdkloader/ima3.js?x=1',
    'https://imasdk.googleapis.com/js/sdkloader/ima3.js#x','https://imasdk.googleapis.com/js/sdkloader/other.js',
    'https://user@imasdk.googleapis.com/js/sdkloader/ima3.js','https://imasdk.googleapis.com:443/js/sdkloader/ima3.js',
    {toString(){throw Error('must not coerce')}}])assert.equal(adapt(fixture,url),fixture);
  for(const module of [true,1,0,null,'false',{}])assert.equal(adapt(fixture,sdkURL,module),fixture);
});

test('bounded ASCII input only; unchanged inputs retain reference identity',()=>{
  const maximum = fixture+' '.repeat(1024*1024-fixture.length);
  assert.equal(adapt(maximum,sdkURL),maximum);
  for(const source of [maximum+' ',fixture+'\u00a0',fixture+'\ud800'])assert.equal(adapt(source,sdkURL),source);
  const bytes = new TextEncoder().encode(fixture), nonASCII = new Uint8Array(bytes.length+1);
  nonASCII.set(bytes);nonASCII[bytes.length]=128;
  const oversized = new Uint8Array(1024*1024+1);oversized.set(bytes);
  for(const source of [nonASCII,oversized,new Uint8ClampedArray(bytes),new Uint16Array([1]),new DataView(bytes.buffer),null,{},42])
    assert.equal(adapt(source,sdkURL),source);
});

test('private synchronous ASCII SHA-256 agrees with native crypto at padding boundaries',()=>{
  const factorySource=createGfnImaSourceAdapter.toString();
  const prefix=factorySource.slice(0,factorySource.indexOf('return function adaptSource('));
  const digest=vm.runInNewContext('('+prefix+'return sha256Ascii;})()', {TextDecoder,TextEncoder});
  for(const value of ['', 'abc', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(63), 'd'.repeat(64),
    'e'.repeat(65), 'f'.repeat(1024*1024), fixture])assert.equal(digest(value),sha(Buffer.from(value,'ascii')));
});

test('comment/template lookalikes never qualify, including padding to the public SDK length',()=>{
  const start=fixture.indexOf('function KM(a){'),end=fixture.indexOf('function LM(){',start);
  const factory=fixture.slice(start,end);
  const helpers=fixture.slice(fixture.indexOf('function fk(a){'),fixture.indexOf('\nvar hB='));
  const anchors='"h.3.797.1" "bridge3.797.1_" '+helpers+' '+factory;
  for(const lookalike of ['/* '+anchors+' */','const cached=`'+anchors+'`;']){
    for(const length of [lookalike.length,fixture.length,508928]){
      const source=lookalike+' '.repeat(length-lookalike.length);
      new vm.Script(source);
      assert.equal(adapt(source,sdkURL),source);
      const bytes=new TextEncoder().encode(source);assert.equal(adapt(bytes,sdkURL),bytes);
    }
  }
  const sameLengthChanged=fixture.replace('Authored, inert','Authored, other');
  assert.equal(sameLengthChanged.length,fixture.length);
  assert.equal(adapt(sameLengthChanged,sdkURL),sameLengthChanged);
});

test('unknown SDK versions, changed helpers and changed factory fail unchanged',()=>{
  for(const source of [fixture.replaceAll('h.3.797.1','h.0.0.0'),fixture.replace('bridge3.797.1_','bridge0.0.0_'),
    fixture.replace('a=b?b.createHTML(a):a','a=a'),fixture.replace('if(a instanceof ek)return a.h','return a.h'),
    fixture.replace('b.title="Advertisement"','b.title="Other"'),fixture.replace('a.appendChild(b)','b.sandbox="";a.appendChild(b)'),
    fixture.replace('function KM(a){','function OtherFactory(a){')])assert.equal(adapt(source,sdkURL),source);
});

test('multiple matches and already adapted source fail unchanged',()=>{
  const start=fixture.indexOf('function KM(a){'),end=fixture.indexOf('function LM(){',start);
  const factory=fixture.slice(start,end);
  for(const source of [fixture+factory,fixture+'\n/*'+seam+'*/',
    fixture+'\nfunction KM(a){}',fixture+'\nfunction fk(a){}',fixture+'\nfunction gk(a){}',
    fixture+'\n"bridge3.797.1_"',adapt(fixture,sdkURL)])assert.equal(adapt(source,sdkURL),source);
});

test('injected helper remains private and works with captured byte APIs',()=>{
  const context=vm.createContext({TextDecoder,TextEncoder,source:new TextEncoder().encode(fixture),sdkURL});
  vm.runInContext('adapter=('+createGfnImaSourceAdapter.toString()+')();globalThis.TextEncoder=undefined;globalThis.TextDecoder=undefined',context);
  const output=vm.runInContext('adapter(source,sdkURL,false)',context);
  assert.equal(new TextDecoder().decode(output),adapt(fixture,sdkURL));
  assert.equal(vm.runInContext('typeof KM',context),'undefined');
});

async function qualifiedVariants(){
  const raw=await readFile('upstream/scramjet-ls-bypass/app/vendor/runtimekit.js');
  const variants={};
  for(const[k,b]of Object.entries({'runtimekit.js':raw,'runtimekit-normal.js':adaptNormalRuntimeCore(raw),'runtimekit-worker.js':adaptRuntimeWorkerGlobals(raw)})){
    const before=adaptLiteralEval(adaptToggleAttribute(b));
    variants['pre-'+k]=adaptModuleIdentityForPreCancellationRelease(before);
    variants['post-'+k]=adaptModuleIdentity(adaptRequestCancellationCore(before));
  }
  return variants;
}

test('all six pinned cores receive only private pre-WASM source adaptation',async()=>{
  const variants=await qualifiedVariants();assert.equal(Object.keys(variants).length,6);
  for(const[k,bytes]of Object.entries(variants)){
    const digest=sha(bytes);assert.equal(digest,GFN_IMA_INPUTS[k]);
    assert.equal(digest,(k.startsWith('pre-')?MODULE_IDENTITY_PRE_CANCELLATION_OUTPUTS:MODULE_IDENTITY_OUTPUTS)[k.replace(/^(pre|post)-/,'')]);
    const output=adaptGfnIma(bytes),text=output.toString();
    assert.equal(sha(output),GFN_IMA_OUTPUTS[k]);new vm.Script(text);
    assert.equal(text.split('const atlasGfnImaSourceAdapter=').length,2);
    assert.equal(text.split('e=atlasGfnImaSourceAdapter(e,t,A);').length,2);
    assert.ok(text.includes('e=atlasGfnImaSourceAdapter(e,t,A);let[l,c]=(0,n.n)(r,a),u={};'));
    const restored=text.replace('const atlasGfnImaSourceAdapter=('+createGfnImaSourceAdapter.toString()+')();','')
      .replace('e=atlasGfnImaSourceAdapter(e,t,A);','');
    assert.equal(restored,bytes.toString());
    if(k.startsWith('pre-'))for(const token of ['atlasCancelFetch','atlasSignal','$atlas$registerFetch'])
      assert.equal(text.includes(token),false,token);
    assert.throws(()=>adaptGfnIma(output),/qualified/);
  }
});

test('unknown, mutated and unqualified core bytes are rejected',async()=>{
  assert.throws(()=>adaptGfnIma(Buffer.from('unknown')),/qualified/);
  const raw=await readFile('upstream/scramjet-ls-bypass/app/vendor/runtimekit.js');
  assert.throws(()=>adaptGfnIma(raw),/qualified/);
  for(const bytes of Object.values(await qualifiedVariants())){
    const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    assert.throws(()=>adaptGfnIma(changed),/qualified/);
  }
});
