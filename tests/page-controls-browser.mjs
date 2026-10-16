/** Actual six-asset frontend/original-document MessagePort qualification.
 * Reuses the full default orchestrator/native-resource harness, replacing only
 * deterministic website payloads as that harness already does. Not fleet/site
 * compatibility proof. No window-message bridge is introduced by this test. */
import { readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
let source = await readFile(
  new URL("./frontend-browser-browser.mjs", import.meta.url),
  "utf8",
);
function replace(before, after) {
  if (source.split(before).length !== 2)
    throw Error("Page-control proof anchor changed: " + before.slice(0, 80));
  source = source.replace(before, after);
}
source = source.replaceAll("https://site.example", "https://coolmathgames.com");
replace(
  "onState: (state) => jointStates.push(state),",
  "onState: (state) => jointStates.push(state),\n      onTelemetry: (event) => (window.pageTelemetry ||= []).push(event),",
);
replace(
  "  const renewed = await page.evaluate(async () => {",
  `
  const configured = await page.evaluate(() => {
    if (typeof frontendBrowser.pageCommand !== 'function') return {method:typeof frontendBrowser.pageCommand};
    return {method:'function', accepted:frontendBrowser.pageCommand({type:'compatibility-config',metadata:true,diagnostics:true})};
  });
  assert.deepEqual(configured,{method:'function',accepted:true});
  await frame.waitForFunction(()=>document.title==='Website');
  await page.waitForFunction(()=>window.pageTelemetry?.some(e=>e.type==='compatibility-status'&&e.applied>0&&e.risk===false));
  await page.evaluate(()=>frontendBrowser.pageCommand({type:'compatibility-export'}));
  await page.waitForFunction(()=>window.pageTelemetry?.some(e=>e.type==='compatibility-diagnostics'));
  const controlReport=await page.evaluate(()=>window.pageTelemetry.findLast(e=>e.type==='compatibility-diagnostics').report);
  assert.equal(controlReport.version,1);assert.equal(controlReport.active,true);
  assert.ok(controlReport.entries.some(e=>e.event==='document'&&e.origin==='https://coolmathgames.com'));
  assert.equal(/ticket|token|nonce|cookie|query|Native site/i.test(JSON.stringify(controlReport)),false);
  await page.evaluate(()=>frontendBrowser.pageCommand({type:'compatibility-config',metadata:false,diagnostics:false}));
  await frame.waitForFunction(()=>document.title==='Native site');
  const renewed = await page.evaluate(async () => {`,
);
replace(
  "  const previous = await page.evaluate(() => ({",
  `
  const stale = await page.evaluate(async()=>{
    const old=frontendBrowser.document;
    await frontendBrowser.navigate('https://coolmathgames.com/page');
    return {accepted:old.command({type:'compatibility-config',metadata:true,diagnostics:true}),oldLive:old.live,different:old.documentId!==frontendBrowser.document.documentId};
  });
  assert.deepEqual(stale,{accepted:false,oldLive:false,different:true});
  await page.waitForFunction(()=>window.pageTelemetry.filter(e=>e.type==='title'&&e.title==='Native site').length>=2);
  const count=await page.evaluate(()=>window.pageTelemetry.length);
  await page.evaluate(()=>{
    window.postMessage({protocol:2,documentId:frontendBrowser.document.documentId,type:'page-telemetry',event:{type:'title',title:'FORGED WINDOW MESSAGE'}},'*');
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.pageTelemetry.length),count);
  assert.equal(await page.evaluate(()=>window.pageTelemetry.some(e=>e.title==='FORGED WINDOW MESSAGE')),false);
  const previous = await page.evaluate(() => ({`,
);
replace(
  'assert.equal(restored.before, "1");',
  'assert.equal(restored.before, "2");',
);
replace(
  'assert.equal(restored.save, "2");',
  'assert.equal(restored.save, "3");',
);
replace(
  '    result: "frontend_browser_default_components_verified",',
  `    result: "page_controls_original_document_port_verified",
    pageControls:{metadataAppliedAndRestored:true,diagnosticsTrustedAndSanitized:true,staleDocumentCommandDenied:true,forgedWindowTelemetryIgnored:true,riskSamplingPaused:true},`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json",',
  '"evidence/page-controls-20261016/ACTUAL-BROWSER.json",',
);
if (process.env.ATLAS_PAGE_CONTROL_FRONTEND_SOURCE) {
  const previous = await readFile(
    process.env.ATLAS_PAGE_CONTROL_FRONTEND_SOURCE,
    "utf8",
  );
  replace(
    "export {createFrontendBrowser} from './frontend-browser.ts';",
    previous,
  );
  replace(
    'resolveDir: resolve("runtime"),',
    'resolveDir: resolve("runtime"), loader: "ts",',
  );
}
const filename = resolve(
  "tests/.page-controls-generated-" + process.pid + ".mjs",
);
await writeFile(filename, source);
try {
  const child = spawn(process.execPath, [filename], {
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(filename, { force: true });
}
