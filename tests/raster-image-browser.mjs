/** Actual native Chrome vs default built opaque Main resource image paths. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
const root = resolve(),
  evidence = join(root, "evidence/raster-mime-20261016");
await fs.mkdir(evidence, { recursive: true });
const encoderBrowser = await chromium.launch({
  headless: true,
  channel: "chrome",
});
let webp;
try {
  const page = await encoderBrowser.newPage();
  webp = Buffer.from(
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 8;
      canvas.getContext("2d").fillStyle = "red";
      canvas.getContext("2d").fillRect(0, 0, 16, 8);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/webp", 1),
      );
      if (!blob || blob.type !== "image/webp")
        throw Error("native WebP encoder unavailable");
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }),
  );
} finally {
  await encoderBrowser.close();
}
await fs.writeFile(join(evidence, "FIXTURE.webp"), webp);
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
const replace = (a, b) => {
  assert.equal(
    source.split(a).length,
    2,
    "raster fixture seam changed " + a.slice(0, 70),
  );
  source = source.replace(a, b);
};
replace(
  '<body><img id="picture" src="https://assets.example/image">',
  '<body><img id="picture" src="https://assets.example/image"><img id="readable-raster" src="https://site.example/readable-image">',
);
replace(
  "img-src https://assets.example;",
  "img-src https://assets.example 'self';",
);
replace(
  '        body = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));\n        type = "image/png";',
  `        body=Uint8Array.from(atob(${JSON.stringify(webp.toString("base64"))}),c=>c.charCodeAt(0));type='application/octet-stream';extra=[['x-content-type-options','nosniff']];`,
);
replace(
  '      } else throw Error("Synthetic transport denied");',
  `      } else if(request.url==='https://site.example/readable-image'){
        body=Uint8Array.from(atob(${JSON.stringify(webp.toString("base64"))}),c=>c.charCodeAt(0));type='application/octet-stream';extra=[['x-content-type-options','nosniff']];
      } else throw Error("Synthetic transport denied");`,
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `  await frame.waitForFunction(()=>document.getElementById('readable-raster').naturalWidth===16,null,{timeout:5000});
  const images=await frame.evaluate(()=>{const native=document.getElementById('picture'),readable=document.getElementById('readable-raster');const canvas=document.createElement('canvas');canvas.width=canvas.height=1;canvas.getContext('2d').drawImage(readable,0,0);return{nativeWidth:native.naturalWidth,nativeHeight:native.naturalHeight,readableWidth:readable.naturalWidth,readableHeight:readable.naturalHeight,readablePixel:Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data)}});
  assert.equal(images.nativeWidth,16);assert.equal(images.nativeHeight,8);assert.equal(images.readableWidth,16);assert.equal(images.readableHeight,8);assert.ok(images.readablePixel[0]>240&&images.readablePixel[1]<10&&images.readablePixel[2]<10&&images.readablePixel[3]===255);
  console.log(JSON.stringify({octetStreamWebP:images,nosniff:true,signatureNotExtension:true,qualified:false}));await fs.writeFile(${JSON.stringify(join(evidence, "BROWSER.json"))},JSON.stringify({images,nosniff:true,websiteTransport:'deterministic',actualBuiltMainRelayProbe:true,qualified:false},null,2)+'\\n');
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(join(evidence, "FRONTEND-BROWSER.json")),
);
let copied;
if (
  process.env.ATLAS_RASTER_BASELINE === "1" ||
  process.env.ATLAS_RASTER_SOURCE_COPY
) {
  copied = await fs.mkdtemp(join(tmpdir(), "atlas-raster-copy-"));
  await fs.mkdir(join(copied, "runtime"));
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copied, "runtime", file),
      );
  for (const file of [
    "opaque-resource-graph.ts",
    "native-resource-preparer.ts",
  ])
    await fs.copyFile(
      process.env.ATLAS_RASTER_SOURCE_COPY
        ? join(resolve(process.env.ATLAS_RASTER_SOURCE_COPY), "runtime", file)
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
