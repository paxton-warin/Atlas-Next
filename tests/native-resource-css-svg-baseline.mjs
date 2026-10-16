/** Preserved source component baseline; no source edits and no production use. */
import fs from 'node:fs';import assert from 'node:assert/strict';import ts from 'typescript';import{PINNED_OPAQUE_CORE_VERSION}from'../runtime/opaque-runtime-adapter.ts';
const source=fs.readFileSync('evidence/native-css-svg-20261016/BASELINE-REWRITER.ts','utf8').replace('"./opaque-runtime-adapter.ts"',JSON.stringify(new URL('../runtime/opaque-runtime-adapter.ts',import.meta.url).href));
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const{createFrontendResourceRewriter}=await import('data:text/javascript,'+encodeURIComponent(code));
const core={versionInfo:{version:PINNED_OPAQUE_CORE_VERSION},defaultConfig:{flags:{}},setWasm(){},CookieJar:class{},Tap:{create(){return{}}},transformHtml:s=>s,transformJs:s=>s,transformCss(source,context){context.interface.codecEncode('https://assets.example/image');return source}};
const transform=createFrontendResourceRewriter({core,wasm:new Uint8Array(),documentId:'doc_'+'a'.repeat(32),documentURL:'https://site.example/page',frontendOrigin:'https://front.test'});
let css,svg;for(const kind of ['style','image'])try{await transform({body:new TextEncoder().encode(kind==='style'?'a{background:url(image)}':'<svg/>'),mime:kind==='style'?'text/css':'image/svg+xml',kind,url:'https://assets.example/source',signal:new AbortController().signal})}catch(error){if(kind==='style')css=error.name;else svg=error.name;}
assert.equal(css,'NotSupportedError');assert.equal(svg,'NotSupportedError');console.log('BASELINE CSS_DEPENDENCY=NotSupportedError SVG=NotSupportedError exitStatus=0');
