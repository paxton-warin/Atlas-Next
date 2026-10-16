/** Regression against mutable MessageEvent.data on private document channels.
 * Reuses the full default-components browser fixture, not an emulated handler.
 * A baseline run builds only two preserved pre-hardening source files in an
 * isolated source copy; neither run modifies the actual workspace or assets.
 */
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(),
  evidence = join(root, "evidence/private-document-events-20261016");
await fs.mkdir(evidence, { recursive: true });
const temporary = await fs.mkdtemp(join(tmpdir(), "atlas-private-events-"));
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
const replace = (from, to) => {
  if (source.split(from).length !== 2)
    throw Error("Private event fixture source changed");
  source = source.replace(from, to);
};
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
replace(
  "(async()=>{let parentFrontendLeak=false;",
  `(async()=>{
  window.privateEventAccess=[];const nativeApply=Reflect.apply,nativeData=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;
  Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get(){const data=nativeApply(nativeData,this,[]);if(this.currentTarget instanceof MessagePort&&(data?.protocol===2||data?.protocol==='atlas-network-v2'))window.privateEventAccess.push({protocol:data.protocol,type:data.type});return data}});
  try {await fetch(location.href)} catch {}
  let parentFrontendLeak=false;`,
);
replace(
  "  const receipt = {",
  `  const privateEvents=await restoredFrame.evaluate(()=>window.privateEventAccess);
  console.log(JSON.stringify({privateDocumentEventAccess:privateEvents,expected:0}));
  assert.deepEqual(privateEvents,[], 'private channel event data must bypass mutable website getters');
  const receipt = {`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(
    join(
      evidence,
      process.env.ATLAS_PRIVATE_EVENTS_BASELINE === "1"
        ? "BASELINE-RECEIPT.json"
        : "MODIFIED-RECEIPT.json",
    ),
  ),
);
if (process.env.ATLAS_PRIVATE_EVENTS_BASELINE === "1") {
  const copy = join(temporary, "source");
  await fs.mkdir(join(copy, "runtime"), { recursive: true });
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copy, "runtime", file),
      );
  for (const file of ["opaque-document.ts", "opaque-runtime-adapter.ts"])
    await fs.copyFile(
      join(evidence, "before", file),
      join(copy, "runtime", file),
    );
  for (const name of ["scripts", "node_modules"])
    await fs.symlink(join(root, name), join(copy, name), "dir");
  await fs.symlink(
    join(root, "runtime/public"),
    join(copy, "runtime/public"),
    "dir",
  );
  replace(
    "manifest = await buildOpaqueRuntime({ outdir: assetDir });",
    `manifest = await (async()=>{const originalCwd=process.cwd();process.chdir(${JSON.stringify(copy)});try{return await buildOpaqueRuntime({outdir:assetDir})}finally{process.chdir(originalCwd)}})();`,
  );
}
const probe = join(evidence, "probe-" + process.pid + ".mjs");
await fs.writeFile(probe, source);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await fs.rm(probe, { force: true });
  await fs.rm(temporary, { recursive: true, force: true });
}
