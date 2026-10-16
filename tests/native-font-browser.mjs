/** Default actual built Main/frontend/opaque native stylesheet pipeline. Website
 * payload deterministic; actual WOFF2 decoder and anonymous CORS are exercised. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const root = resolve(),
  evidence = join(root, "evidence/native-font-dependency-20261016");
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
  window.fontPromise=(async()=>{const loaded=await document.fonts.load('32px nativeFixtureFont','ABC');window.fontResult={count:loaded.length,loaded:loaded[0]?.status,checked:document.fonts.check('32px nativeFixtureFont','ABC'),family:loaded[0]?.family};return window.fontResult})().catch(error=>{window.fontFailure={name:error.name,message:error.message};throw error});
  (async()=>{let parentFrontendLeak=false;`,
);
replace(
  "img-src https://assets.example; connect-src 'none'",
  "img-src https://assets.example; font-src https://fonts.example; connect-src 'none'",
);
replace(
  '        body = "body{background-color:rgb(1, 2, 3)}";',
  `        body='@font-face{font-family:nativeFixtureFont;src:url("https://fonts.example/fixture.woff2") format("woff2")}body{background-color:rgb(1, 2, 3);font-family:nativeFixtureFont}';`,
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
  const fontResult=await frame.evaluate(()=>window.fontResult||window.fontFailure);assert.deepEqual(fontResult,{count:1,loaded:'loaded',checked:true,family:'nativeFixtureFont'});
  const fontCalls=await page.evaluate(()=>jointCalls.filter(c=>c.destination==='font'));assert.equal(fontCalls.length,1);assert.equal(fontCalls[0].documentURL,'https://site.example/page');
  console.log(JSON.stringify({nativeFont:fontResult,anonymousCors:true,stylesheetBodyReadable:false,fontGatewayEndpoint:false,selectedNode:'Main',qualified:false}));
  await fs.writeFile(${JSON.stringify(join(evidence, "BROWSER.json"))},JSON.stringify({fontResult,fontCalls,anonymousCors:true,websiteTransport:'deterministic',actualBuiltMainRelayProbe:true,qualified:false},null,2)+'\\n');
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(join(evidence, "FRONTEND-BROWSER.json")),
);
let copied;
if (
  process.env.ATLAS_FONT_BASELINE === "1" ||
  process.env.ATLAS_FONT_SOURCE_COPY
) {
  copied = await fs.mkdtemp(join(tmpdir(), "atlas-font-copy-"));
  await fs.mkdir(join(copied, "runtime"));
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copied, "runtime", file),
      );
  for (const file of [
    "native-resource-preparer.ts",
    "native-resource-owner.ts",
    "native-resource-provider.ts",
    "frontend-rewriter.ts",
  ])
    await fs.copyFile(
      process.env.ATLAS_FONT_SOURCE_COPY
        ? join(resolve(process.env.ATLAS_FONT_SOURCE_COPY), "runtime", file)
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
