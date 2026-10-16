/** Native Trusted Types with ACTUAL built opaque core/controller/graph/owners.
 * Only upstream website bytes are deterministic; no native TT API is mocked. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(),
  evidence = join(root, "evidence/trusted-types-gmail-20261016");
await fs.mkdir(evidence, { recursive: true });
const mode = process.env.ATLAS_TT_EVAL_MODE || "unsafe-eval";
assert.ok(["unsafe-eval", "denied"].includes(mode));
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
function replace(before, after) {
  assert.equal(
    source.split(before).length,
    2,
    "TT integration fixture source changed: " + before.slice(0, 80),
  );
  source = source.replace(before, after);
}
const test = `
  const tt={};
  const attempt=fn=>{try{fn();return 'allowed'}catch(e){return e.name}};
  const typed=trustedTypes.createPolicy('site',{createHTML:s=>s,createScript:s=>s,createScriptURL:s=>s});
  const box=document.createElement('div');
  tt.rawHTML=attempt(()=>{box.innerHTML='<b>raw</b>'});
  tt.forgedHTML=attempt(()=>{box.innerHTML={toString:()=>'<b>forged</b>'}});
  tt.wrongBrand=attempt(()=>{box.innerHTML=typed.createScript('notHTML')});
  tt.trustedHTML=attempt(()=>{box.innerHTML=typed.createHTML('<b id="tt-safe">safe</b>')});
  tt.trustedHTMLText=box.querySelector('#tt-safe')?.textContent;
  tt.inlineHandler=attempt(()=>{box.innerHTML=typed.createHTML('<img src="no" onerror="window.handlerTT=true">')});
  tt.scriptURLMarkup=attempt(()=>{box.innerHTML=typed.createHTML('<a href="javascript:window.handlerTT=true">bad</a>')});
  tt.nativeBrand=trustedTypes.isHTML(typed.createHTML('ok'));
  tt.forbiddenPolicy=attempt(()=>trustedTypes.createPolicy('not-allowed',{createHTML:s=>s}));
  tt.duplicatePolicy=attempt(()=>trustedTypes.createPolicy('site',{createHTML:s=>s}));
  const element=document.createElement('script');
  tt.rawScriptText=attempt(()=>{element.textContent='window.rawTTScript=true'});
  tt.trustedScriptText=attempt(()=>{element.textContent=typed.createScript('window.typedTTScript=true')});
  tt.rawScriptURL=attempt(()=>{element.src='https://site.example/raw.js'});
  tt.trustedScriptURL=attempt(()=>{element.src=typed.createScriptURL('https://site.example/typed.js')});
  const parsed=new DOMParser();
  tt.rawParser=attempt(()=>parsed.parseFromString('<p>raw</p>','text/html'));
  tt.typedParser=attempt(()=>parsed.parseFromString(typed.createHTML('<p>safe</p>'),'text/html'));
  tt.rawEval=attempt(()=>eval('window.rawTTEval=true'));
  tt.trustedEval=attempt(()=>eval(typed.createScript('window.typedTTEval=true')));
  tt.rewriteBrand=trustedTypes.isScript(window['$runtimekit$rewrite'](typed.createScript('window.typedTTEval=true')));
  tt.evalExecuted=window.typedTTEval===true;
  tt.rawFunction=attempt(()=>Function('return 1'));
  tt.trustedFunction=attempt(()=>Function(typed.createScript('return 7'))());
  const seen=[];
  trustedTypes.createPolicy('default',{createHTML:(s,type,sink)=>{seen.push([type,sink]);return s==='reject'?null:s==='throw'?(()=>{throw new RangeError('expected')})():s.replace('original','sanitized')}});
  tt.defaultHTML=attempt(()=>{box.innerHTML='<i>original</i>'});
  tt.defaultHTMLText=box.textContent;
  tt.defaultNull=attempt(()=>{box.innerHTML='reject'});
  tt.defaultThrow=attempt(()=>{box.innerHTML='throw'});
  tt.defaultSink=seen[0];
  // Native policy objects retain their brands and restrictions; a website
  // mutation of policy prototype methods cannot expose the internal policy.
  let privatePolicyLeaked=false;
  const proto=Object.getPrototypeOf(typed),method=proto.createHTML;
  proto.createHTML=function(...args){if(this.name!=='site'&&this.name!=='default')privatePolicyLeaked=true;return Reflect.apply(method,this,args)};
  tt.afterPrototypeMutation=attempt(()=>{box.innerHTML=typed.createHTML('<em>safe</em>')});
  proto.createHTML=method;
  tt.privatePolicyLeaked=privatePolicyLeaked;
  window.originalTTResult=tt;
`;
replace(
  "  (async()=>{let parentFrontendLeak=false;",
  test + "\n  (async()=>{let parentFrontendLeak=false;",
);
replace(
  "default-src 'none'; script-src https://assets.example 'unsafe-inline'; style-src https://assets.example; img-src https://assets.example; connect-src 'none'",
  "default-src 'none'; script-src https://assets.example 'unsafe-inline'" +
    (mode === "denied" ? "" : " '" + mode + "'") +
    "; style-src https://assets.example; img-src https://assets.example; connect-src 'none'; require-trusted-types-for 'script'; trusted-types site default",
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `
  const tt=await frame.evaluate(()=>window.originalTTResult);
  console.log(JSON.stringify({trustedTypesMode:${JSON.stringify(mode)},trustedTypes:tt}));
  assert.ok(tt,'original TT test executed');
  for(const key of ['rawHTML','forgedHTML','wrongBrand','rawScriptText','rawScriptURL','rawParser','rawEval','forbiddenPolicy','duplicatePolicy','defaultNull'])assert.equal(tt[key],'TypeError',key);
  for(const key of ['trustedHTML','trustedScriptText','trustedScriptURL','typedParser','defaultHTML','afterPrototypeMutation'])assert.equal(tt[key],'allowed',key);
  assert.equal(tt.trustedHTMLText,'safe');assert.equal(tt.defaultHTMLText,'sanitized');assert.equal(tt.nativeBrand,true);assert.equal(tt.defaultThrow,'RangeError');assert.deepEqual(tt.defaultSink,['TrustedHTML','Element innerHTML']);assert.equal(tt.privatePolicyLeaked,false);
  assert.equal(tt.inlineHandler,'NotSupportedError');assert.equal(tt.scriptURLMarkup,'NotSupportedError');
  assert.equal(tt.trustedEval,${JSON.stringify(mode === "denied" ? "EvalError" : "allowed")});assert.equal(tt.evalExecuted,${mode !== "denied"});
  assert.equal(tt.rawFunction,'EvalError');assert.equal(tt.trustedFunction,'EvalError');
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(join(evidence, "BUILT-" + mode + ".json")),
);
const file = join(evidence, "built-tt-" + mode + "-" + process.pid + ".mjs");
await fs.writeFile(file, source);
try {
  await import(pathToFileURL(file).href);
} finally {
  await fs.rm(file, { force: true });
}
