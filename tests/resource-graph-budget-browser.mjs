/** Actual default opaque runtime: a finite Discord-sized entry graph. The
 * baseline changes ONLY its former 256 resource/context budget in a private
 * builder copy, never the working tree. Website bytes are deterministic. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(),
  evidence = join(root, "evidence/resource-graph-budget-20261016");
await fs.mkdir(evidence, { recursive: true });
const base = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8"),
  start = base.indexOf("  const png ="),
  end = base.lastIndexOf("\n} finally {");
assert.ok(start > 0 && end > start);
const temporary = [];
let source = base
  .slice(0, start)
  .replace(
    /(from\s+["'])\.\.\/([^"']+)/g,
    (_m, begin, path) => begin + pathToFileURL(join(root, path)).href,
  );
if (
  process.env.ATLAS_GRAPH_BASELINE === "1" ||
  process.env.ATLAS_SCRIPT_BUDGET_BASELINE === "1"
) {
  const scriptBaseline = process.env.ATLAS_SCRIPT_BUDGET_BASELINE === "1";
  const graphPath = join(evidence, "baseline-branch-" + process.pid + ".ts");
  let graph = await fs.readFile(
    scriptBaseline
      ? "runtime/resource-response-budget.ts"
      : "runtime/opaque-resource-graph.ts",
    "utf8",
  );
  const before = scriptBaseline
      ? "SCRIPT_RESPONSE_BYTES = 32 * 1024 * 1024"
      : "options.maxResources ?? 1024",
    after = scriptBaseline
      ? "SCRIPT_RESPONSE_BYTES = 8 * 1024 * 1024"
      : "options.maxResources ?? 256";
  assert.equal(graph.split(before).length, 2);
  graph = graph.replace(before, after);
  await fs.writeFile(graphPath, graph);
  temporary.push(graphPath);
  let builder = await fs.readFile("scripts/build-opaque-runtime.mjs", "utf8");
  builder = builder.replace(
    /(from\s+["'])\.\/([^"']+)/g,
    (_m, begin, path) =>
      begin + pathToFileURL(join(root, "scripts", path)).href,
  );
  const needle = "    const common = {";
  assert.equal(builder.split(needle).length, 2);
  builder = builder.replace(
    needle,
    needle +
      `plugins:[{name:'prior-count-branch',setup(b){b.onLoad({filter:${scriptBaseline ? "/\\/runtime\\/resource-response-budget\\.ts$/" : "/\\/runtime\\/opaque-resource-graph\\.ts$/"}},async()=>({contents:await readFile(${JSON.stringify(graphPath)},'utf8'),loader:'ts',resolveDir:resolve('runtime')}))}}],`,
  );
  const file = join(evidence, "baseline-builder-" + process.pid + ".mjs");
  await fs.writeFile(file, builder);
  temporary.push(file);
  source = source.replace(
    pathToFileURL(join(root, "scripts/build-opaque-runtime.mjs")).href,
    pathToFileURL(file).href,
  );
}
source +=
  `
  const result=await page.evaluate(async()=>{
    const {createFrontendBrowser}=await import('/fixture.js');
    const styles=Array.from({length:322},(_,i)=>'<link rel="stylesheet" href="/style-'+i+'.css">').join('');
    const scripts=Array.from({length:356},(_,i)=>'<script src="/script-'+i+'.js"><'+'/script>').join('');
    const html='<!doctype html><html><head>'+styles+'</head><body>Finite large entry graph'+scripts+'</body></html>';
    const calls=[],states=[];
    const controller=await createFrontendBrowser({container:document.querySelector('main'),timeoutMs:30000,onState:state=>states.push({status:state.status,code:state.code}),components:{fetch:()=>async request=>{
      const path=new URL(request.url).pathname;calls.push(path);
      const css=/^\\/style-\\d+\\.css$/.test(path),script=/^\\/script-\\d+\\.js$/.test(path);
      if(path!=='/'&&!css&&!script)throw Error('UNEXPECTED_RESOURCE');
      const text=path==='/'?html:css?'body{color:rgb(1,2,3)}':(path==='/script-0.js'?'/*'+'x'.repeat(9*1024*1024)+'*/':'')+'window.largeGraphCount=(window.largeGraphCount||0)+1;';
      return{url:request.url,status:200,statusText:'OK',headers:[['content-type',path==='/'?'text/html':css?'text/css':'text/javascript']],body:new TextEncoder().encode(text).buffer};
    }}});
    window.largeGraphController=controller;
    let failure;try{await controller.start('https://site.example/')}catch(error){failure={code:error.code,name:error.name}}
    return{calls:calls.length,states,failure};
  });
  assert.equal(result.failure,undefined,JSON.stringify(result));
  const frame=page.frames().find(frame=>frame.url().startsWith(frontend+'/browse/frame/'));assert.ok(frame);
  await frame.waitForFunction(()=>window.largeGraphCount===356);
  const content=await frame.evaluate(()=>({scripts:window.largeGraphCount,stylesheets:document.querySelectorAll('link[rel=stylesheet]').length,color:getComputedStyle(document.body).color}));
  assert.deepEqual(content,{scripts:356,stylesheets:322,color:'rgb(1, 2, 3)'});assert.equal(result.calls,679);
  const receipt={...result,content,assets:Object.keys(manifest.files).length,defaultRuntime:true,largeScriptBytes:9*1024*1024,scriptResponseBudget:32*1024*1024,limit:1024,maxLimit:2048,byteBudget:32*1024*1024};
  await fs.writeFile(${JSON.stringify(join(evidence, "MODIFIED-BROWSER.json"))},JSON.stringify(receipt,null,2)+'\\n');console.log(JSON.stringify(receipt));
  await page.evaluate(()=>largeGraphController.dispose());
` + base.slice(end);
const probe = join(evidence, "probe-" + process.pid + ".mjs");
await fs.writeFile(probe, source);
temporary.push(probe);
try {
  await import(pathToFileURL(probe).href);
} finally {
  for (const file of temporary) await fs.rm(file, { force: true });
}
