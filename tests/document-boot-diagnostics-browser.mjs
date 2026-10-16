/** Actual six-asset/default-controller failure receipts. Only upstream website
 * responses are fixtures; no mocked document runtime or content-state callback.
 * Arbitrary response/error text must never escape as frontend error metadata. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve();
const evidence = join(root, "evidence/document-markup-20261016");
await fs.mkdir(evidence, { recursive: true });
const base = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
const start = base.indexOf("  const png ="),
  end = base.lastIndexOf("\n} finally {");
assert.ok(start > 0 && end > start, "Default browser harness changed");
let source = base
  .slice(0, start)
  .replace(
    /(from\s+["'])\.\.\/([^"']+)/g,
    (_m, start, path) => start + pathToFileURL(join(root, path)).href,
  );
if (process.env.ATLAS_BOOT_BASELINE === "1") {
  const needle = "  const bundle = await build({";
  assert.equal(source.split(needle).length, 2);
  source = source.replace(
    needle,
    `  const bundle = await build({plugins:[{name:'baseline-content-failure',setup(builder){builder.onLoad({filter:/\\/runtime\\/frontend-browser\\.ts$/},async()=>({contents:await fs.readFile(${JSON.stringify(join(root, "evidence/frontend-ui-real-20261016/before/runtime/frontend-browser.ts"))},'utf8'),loader:'ts',resolveDir:resolve('runtime')}))}}],`,
  );
}
source +=
  `
  const reports=await page.evaluate(async()=>{
    const {createFrontendBrowser}=await import('/fixture.js');
    const reports=[];
    for(const scenario of ['conditional-css','private-exception']){
      const states=[],calls=[];let controller,rejected;
      try{
        controller=await createFrontendBrowser({container:document.querySelector('main'),timeoutMs:20000,onState:state=>states.push({status:state.status,...(state.code?{code:state.code}:{})}),components:{fetch:()=>async request=>{
          calls.push(new URL(request.url).origin+new URL(request.url).pathname);
          let text,mime;
          if(request.url==='https://site.example/'){text='<!doctype html><html><head><link rel="stylesheet" href="https://assets.example/style.css"></head><body>Never written<script>window.shouldNotRun=true<'+ '/script></body></html>';mime='text/html'}
          else if(request.url==='https://assets.example/style.css'){
            if(scenario==='private-exception')throw Error('PRIVATE_RESPONSE_MARKER https://secret.example/path?token=DO_NOT_FORWARD');
            text='@import url("https://assets.example/never.css?private=DO_NOT_FORWARD") screen and (max-width:1px);';mime='text/css';
          }else throw Error('UNEXPECTED_TRANSPORT');
          return{status:200,statusText:'OK',url:request.url,headers:[['content-type',mime]],body:new TextEncoder().encode(text).buffer};
        }}});
        await controller.start('https://site.example/');
      }catch(error){rejected={name:error?.name,code:error?.code}}
      finally{controller?.dispose()}
      reports.push({scenario,states,rejected,calls});
    }
    return reports;
  });
  for(const report of reports){
    assert.equal(report.states.at(-1)?.status,'error');
    assert.equal(report.rejected?.code,report.scenario==='conditional-css'?'CSS_CONDITIONAL_IMPORT_UNSUPPORTED':'RESOURCE_GRAPH_FAILED');
    assert.equal(report.states.at(-1).code,report.rejected.code);
    assert.deepEqual(report.calls,['https://site.example/','https://assets.example/style.css']);
    assert.equal(JSON.stringify(report).includes('DO_NOT_FORWARD'),false);
    assert.equal(JSON.stringify(report).includes('PRIVATE_RESPONSE_MARKER'),false);
    assert.equal(await page.locator('iframe').count(),0);
  }
  const receipt={assets:Object.keys(manifest.files).length,actualDefaultPrivateController:true,reports};
  await fs.writeFile(${JSON.stringify(join(evidence, process.env.ATLAS_BOOT_BASELINE === "1" ? "BOOT-BASELINE.json" : "BOOT-MODIFIED.json"))},JSON.stringify(receipt,null,2)+'\\n');
  console.log(JSON.stringify(receipt));
` + base.slice(end);
const probe = join(evidence, "boot-probe-" + process.pid + ".mjs");
await fs.writeFile(probe, source);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await fs.rm(probe, { force: true });
}
