import test from 'node:test';
import assert from 'node:assert/strict';
import { wallpaperMime, wallpaperSignature, wallpaperDimensions, canonicalWallpaperDataUrl,
  prepareWallpaper, WALLPAPER_MAX_INPUT_BYTES, WALLPAPER_MAX_OUTPUT_BYTES } from '../web/src/wallpaper-upload.ts';
const file = (name='photo.jpg',type='image/jpeg',size=100) => ({name,type,size});
test('JPG aliases and missing OS MIME metadata canonicalize only supported photo types', () => {
  for (const type of ['image/jpeg','image/jpg','image/pjpeg','IMAGE/JPEG']) assert.equal(wallpaperMime(file('test.jpg',type)),'image/jpeg');
  for (const name of ['test.jpg','test.JPEG']) assert.equal(wallpaperMime(file(name,'')),'image/jpeg');
  assert.equal(wallpaperMime(file('test.png','')),'image/png');
  assert.equal(wallpaperMime(file('test.webp','')),'image/webp');
  for (const type of ['image/svg+xml','image/gif','image/heic','text/html','application/octet-stream']) assert.throws(()=>wallpaperMime(file('test.jpg',type)),/JPG, PNG or WebP/);
  assert.throws(()=>wallpaperMime(file('test.svg','')),/JPG, PNG or WebP/);
});
test('input bounds are explicit and signature checks reject active or mismatched documents', () => {
  assert.equal(wallpaperMime(file('test.jpg','image/jpeg',WALLPAPER_MAX_INPUT_BYTES)),'image/jpeg');
  for (const size of [0,-1,NaN,Infinity,WALLPAPER_MAX_INPUT_BYTES+1]) assert.throws(()=>wallpaperMime(file('test.jpg','image/jpeg',size)));
  const bytes=hex=>Uint8Array.from(Buffer.from(hex,'hex'));
  assert.ok(wallpaperSignature(bytes('ffd8ffe0'),'image/jpeg'));
  assert.ok(wallpaperSignature(bytes('89504e470d0a1a0a'),'image/png'));
  assert.ok(wallpaperSignature(bytes('524946460000000057454250'),'image/webp'));
  assert.equal(wallpaperSignature(bytes('3c7376673e'),'image/jpeg'),false);
  assert.equal(wallpaperSignature(bytes('89504e470d0a1a0a'),'image/jpeg'),false);
});
test('large camera photos retain aspect ratio and never upscale smaller images', () => {
  assert.deepEqual(wallpaperDimensions(5712,4284),{width:1920,height:1440});
  assert.deepEqual(wallpaperDimensions(4284,5712),{width:1440,height:1920});
  assert.deepEqual(wallpaperDimensions(400,200),{width:400,height:200});
  assert.deepEqual(wallpaperDimensions(100000,1),{width:1920,height:1});
  for (const pair of [[0,100],[-1,100],[1.5,100],[100000,100000],[Infinity,100]]) assert.throws(()=>wallpaperDimensions(...pair));
});
test('canonical data URLs cannot inject CSS quotes or non-raster URL schemes', () => {
  assert.equal(canonicalWallpaperDataUrl('data:image/jpg;base64,/9j/4A=='),'data:image/jpeg;base64,/9j/4A==');
  assert.equal(canonicalWallpaperDataUrl('data:image/pjpeg;base64,/9j/4A=='),'data:image/jpeg;base64,/9j/4A==');
  assert.equal(canonicalWallpaperDataUrl('data:image/PNG;base64,iVBORw=='),'data:image/png;base64,iVBORw==');
  for (const value of [null,'data:image/svg+xml;base64,PHN2Zz4=','https://image.test/a.jpg','data:image/jpeg;base64,AAAA");url("x','data:image/jpeg;base64,A','data:image/jpeg;base64,']) assert.throws(()=>canonicalWallpaperDataUrl(value));
});
test('unreadable or invalid files reject before image decode or persistent writes', async () => {
  await assert.rejects(prepareWallpaper({ ...file(),slice(){throw Error('read failed')} }),/could not be read/);
  await assert.rejects(prepareWallpaper(new File(['<html>not a photo</html>'],'test.jpg',{type:'image/jpeg'})),/not a valid/);
  assert.equal(WALLPAPER_MAX_OUTPUT_BYTES,256*1024);
});
async function browserFixture({width=400,height=200,encodedSize=1000}={}, run) {
  const original = Object.fromEntries(['createImageBitmap','FileReader','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const state={closed:0,created:0,encodes:[],draws:[],canvas:null};
  globalThis.createImageBitmap=async blob=>({width,height,close(){state.closed++}});
  globalThis.FileReader=class {
    readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload?.()}).catch(()=>this.onerror?.())}
  };
  globalThis.document={createElement(name){assert.equal(name,'canvas');state.created++;const canvas={width:0,height:0,getContext(){return{drawImage(...args){state.draws.push(args.slice(1))}}},toBlob(callback,mime,quality){state.encodes.push({mime,quality,width:canvas.width,height:canvas.height});const size=typeof encodedSize==='function'?encodedSize(state.encodes.length):encodedSize;queueMicrotask(()=>callback(new Blob([new Uint8Array(size)],{type:mime})))}};state.canvas=canvas;return canvas}};
  try{return await run(state)}finally{for(const[key,descriptor]of Object.entries(original)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
}
test('small JPG aliases decode before preservation and release their native bitmap', async () => {
  await browserFixture({},async state=>{
    const output=await prepareWallpaper(new File([Buffer.from('ffd8ffe0','hex')],'photo.jpg',{type:'image/jpg'}));
    assert.equal(output,'data:image/jpeg;base64,/9j/4A==');
    assert.equal(state.closed,1);assert.equal(state.created,0);assert.equal(state.encodes.length,0);
  });
});
test('large camera photos encode to a bounded raster and clear canvas and bitmap buffers',async()=>{
 await browserFixture({width:5712,height:4284,encodedSize:n=>n<3?WALLPAPER_MAX_OUTPUT_BYTES+1:5000},async state=>{
  const output=await prepareWallpaper(new File([Buffer.from('ffd8ffe0','hex'),new Uint8Array(300000)],'camera.jpg',{type:'image/jpeg'}));
  assert.ok(output.startsWith('data:image/webp;base64,'));
  assert.ok(Buffer.from(output.split(',')[1],'base64').length<=WALLPAPER_MAX_OUTPUT_BYTES);
  assert.deepEqual(state.encodes.map(v=>v.quality),[.86,.7,.54]);
  assert.deepEqual(state.draws,[[0,0,1920,1440]]);assert.equal(state.closed,1);
  assert.equal(state.canvas.width,0);assert.equal(state.canvas.height,0);
 });
});
test('failed compression has a finite retry budget and releases native buffers',async()=>{
 await browserFixture({width:5712,height:4284,encodedSize:WALLPAPER_MAX_OUTPUT_BYTES+1},async state=>{
  await assert.rejects(prepareWallpaper(new File([Buffer.from('ffd8ffe0','hex'),new Uint8Array(300000)],'camera.jpg',{type:'image/jpeg'})),/small enough to save/);
  assert.equal(state.encodes.length,24);assert.equal(state.closed,1);
  assert.equal(state.canvas.width,0);assert.equal(state.canvas.height,0);
 });
});
