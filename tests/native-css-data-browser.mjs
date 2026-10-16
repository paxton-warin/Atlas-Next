/** Default actual built Main/frontend/opaque native stylesheet pipeline. Website
 * payload deterministic; actual WOFF2 decoder and anonymous CORS are exercised. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const root = resolve(),
  evidence = join(root, "evidence/native-css-data-20261016");
await fs.mkdir(evidence, { recursive: true });
const require = createRequire(import.meta.url),
  font = await fs.readFile(
    join(
      require.resolve("katex/dist/katex.min.css"),
      "../fonts/KaTeX_Main-Regular.woff2",
    ),
  );
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
const replace = (a, b) => {
  assert.equal(
    source.split(a).length,
    2,
    "font fixture seam changed " + a.slice(0, 70),
  );
  source = source.replace(a, b);
};
replace(
  "<script>\n  (async()=>{let parentFrontendLeak=false;",
  `<script>
  window.fontPromise=(async()=>{const loaded=await document.fonts.load('32px nativeFixtureFont','ABC');const background=getComputedStyle(document.body).backgroundImage;const image=new Image();const loadedImage=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject});image.src=background.slice(5,-2);await loadedImage;const canvas=document.createElement('canvas');canvas.width=canvas.height=1;canvas.getContext('2d').drawImage(image,0,0);window.fontResult={count:loaded.length,loaded:loaded[0]?.status,checked:document.fonts.check('32px nativeFixtureFont','ABC'),family:loaded[0]?.family,imagePixel:Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data)};return window.fontResult})().catch(error=>{window.fontFailure={name:error.name,message:error.message};throw error});
  (async()=>{let parentFrontendLeak=false;`,
);
replace(
  "img-src https://assets.example; connect-src 'none'",
  "img-src https://assets.example data:; font-src data:; connect-src 'none'",
);
replace(
  '        body = "body{background-color:rgb(1, 2, 3)}";',
  `        body='@font-face{font-family:nativeFixtureFont;src:url("data:font/woff2;base64,${font.toString("base64")}") format("woff2")}body{background-color:rgb(1, 2, 3);font-family:nativeFixtureFont;background-image:url("data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%221%22%20height=%221%22%3E%3Crect%20width=%221%22%20height=%221%22%20fill=%22green%22/%3E%3C/svg%3E")}';`,
);
replace(
  '      } else throw Error("Synthetic transport denied");',
  `      } else if(request.url==='https://fonts.example/fixture.woff2'){
        if(request.mode!=='cors'||request.credentials!=='omit'||request.destination!=='font')throw Error('font authority mismatch');
        body=Uint8Array.from(atob(${JSON.stringify(font.toString("base64"))}),c=>c.charCodeAt(0));type='font/woff2';extra=[['access-control-allow-origin','https://site.example']];
      } else throw Error("Synthetic transport denied");`,
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `  await frame.waitForFunction(()=>window.fontResult||window.fontFailure,null,{timeout:10000});
  const fontResult=await frame.evaluate(()=>window.fontResult||window.fontFailure);assert.deepEqual(fontResult,{count:1,loaded:'loaded',checked:true,family:'nativeFixtureFont',imagePixel:[0,128,0,255]});
  const fontCalls=await page.evaluate(()=>jointCalls.filter(c=>c.destination==='font'));assert.equal(fontCalls.length,0);
  console.log(JSON.stringify({nativeDataFontAndImage:fontResult,localBytesOnly:true,stylesheetBodyReadable:false,fontGatewayEndpoint:false,selectedNode:'Main',qualified:false}));
  await fs.writeFile(${JSON.stringify(join(evidence, "BROWSER.json"))},JSON.stringify({fontResult,fontCalls,localBytesOnly:true,websiteTransport:'deterministic',actualBuiltMainRelayProbe:true,qualified:false},null,2)+'\\n');
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(join(evidence, "FRONTEND-BROWSER.json")),
);
if (process.env.ATLAS_CSS_DATA_DENY === "font")
  source = source.replace("font-src data:;", "font-src 'none';");
if (process.env.ATLAS_CSS_DATA_DENY === "image")
  source = source.replace(
    "img-src https://assets.example data:;",
    "img-src https://assets.example;",
  );
let copied;
if (
  process.env.ATLAS_CSS_DATA_BASELINE === "1" ||
  process.env.ATLAS_CSS_DATA_SOURCE_COPY
) {
  copied = await fs.mkdtemp(join(tmpdir(), "atlas-css-data-copy-"));
  await fs.mkdir(join(copied, "runtime"));
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copied, "runtime", file),
      );
  for (const file of [
    "native-resource-preparer.ts",
    "native-css-dependencies.ts",
    "original-document-policy.ts",
    "frontend-rewriter.ts",
  ])
    await fs.copyFile(
      process.env.ATLAS_CSS_DATA_SOURCE_COPY
        ? join(resolve(process.env.ATLAS_CSS_DATA_SOURCE_COPY), "runtime", file)
        : join(evidence, "BASELINE_" + file),
      join(copied, "runtime", file),
    );
  for (const name of ["scripts", "node_modules", "web"])
    await fs.symlink(join(root, name), join(copied, name), "dir");
  await fs.symlink(
    join(root, "runtime/public"),
    join(copied, "runtime/public"),
    "dir",
  );
  replace(
    "manifest = await buildOpaqueRuntime({ outdir: assetDir });",
    `manifest=await(async()=>{const cwd=process.cwd();process.chdir(${JSON.stringify(copied)});try{return await buildOpaqueRuntime({outdir:assetDir})}finally{process.chdir(cwd)}})();`,
  );
  replace(
    'resolveDir: resolve("runtime"),',
    `resolveDir:${JSON.stringify(join(copied, "runtime"))},`,
  );
  replace("      timeout: 25000,", "      timeout: 6000,");
}
const probe = join(evidence, "probe-" + process.pid + ".mjs");
await fs.writeFile(probe, source);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await fs.rm(probe, { force: true });
  if (copied) await fs.rm(copied, { recursive: true, force: true });
}
