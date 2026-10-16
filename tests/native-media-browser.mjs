/** Actual built default frontend + Main probe + owner/gateway. Only logical
 * website responses are deterministic; real Chrome decodes/plays real bytes.
 * Complete-file snapshots and eager candidate preparation are finite support,
 * not HLS/DASH/MSE/DRM/large streaming or exact lazy-fetch scheduling parity. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(),
  evidence = join(root, "evidence/native-media-responsive-20261016");
await fs.mkdir(evidence, { recursive: true });
const ffmpeg = (args) => {
  const r = spawnSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    ["-hide_banner", "-loglevel", "error", ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};
const movie = ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x24:r=10:d=3",
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "realtime",
    "-threads",
    "1",
    "-f",
    "webm",
    "pipe:1",
  ]),
  large = ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=8x4",
    "-frames:v",
    "1",
    "-vcodec",
    "png",
    "-f",
    "image2pipe",
    "pipe:1",
  ]);
const wav = Buffer.alloc(44 + 32000 * 3);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let n = 0; n < (wav.length - 44) / 2; n++)
  wav.writeInt16LE(
    Math.round(1000 * Math.sin((n * 2 * Math.PI * 440) / 16000)),
    44 + n * 2,
  );
await fs.writeFile(join(evidence, "VIDEO.webm"), movie);
await fs.writeFile(join(evidence, "AUDIO.wav"), wav);
await fs.writeFile(join(evidence, "LARGE.png"), large);
let source = await fs.readFile("tests/frontend-browser-browser.mjs", "utf8");
source = source.replace(
  /(from\s+["'])\.\.\/([^"']+)/g,
  (_m, start, path) => start + pathToFileURL(join(root, path)).href,
);
const replace = (before, after) => {
  assert.equal(
    source.split(before).length,
    2,
    "media fixture seam changed " + before.slice(0, 60),
  );
  source = source.replace(before, after);
};
replace(
  "const sockets = new Set();",
  "const sockets = new Set();const nativeMediaResponses=[];",
);
replace(
  "      res.writeHead(response.statusCode, response.headers);",
  `      if(req.url.startsWith('/native-resource/v1/resource/')&&req.headers.range)nativeMediaResponses.push({range:req.headers.range,status:response.statusCode,contentRange:response.headers['content-range']});
      res.writeHead(response.statusCode, response.headers);`,
);
replace(
  '      "--no-proxy-server",',
  '      "--no-proxy-server", "--autoplay-policy=no-user-gesture-required",',
);
replace(
  '<body><img id="picture" src="https://assets.example/image">',
  `<body><img id="picture" src="https://assets.example/image">
<picture><source media="(min-width:200px)" srcset="https://assets.example/large 1x"><img id="responsive-picture" src="https://assets.example/image"></picture>
<img id="responsive-density" src="https://assets.example/image" srcset="https://assets.example/image 1x, https://assets.example/large 2x">
<link rel="icon" href="https://assets.example/favicon.ico">
<video id="finite-video" muted playsinline preload="auto" poster="https://assets.example/image"><source src="https://assets.example/allowed/movie.webm" type="video/webm"></video>
<audio id="finite-audio" preload="auto" src="https://assets.example/allowed/sound.wav"></audio>
<audio id="cors-audio" crossorigin="anonymous" preload="auto" src="https://peer.example/allowed/sound.wav"></audio>
<audio id="denied-audio" src="https://assets.example/denied/sound.wav"></audio>
<img id="denied-responsive" srcset="https://blocked.example/image 1x">`,
);
replace(
  "<script>\n  (async()=>{let parentFrontendLeak=false;",
  `<script>
  window.mediaPromise=(async()=>{
    const wait=(element)=>element.readyState>=2?Promise.resolve():new Promise((resolve,reject)=>{element.addEventListener('loadeddata',resolve,{once:true});element.addEventListener('error',()=>reject(Error('media decode failed '+element.id)),{once:true})});
    const video=document.getElementById('finite-video'),audio=document.getElementById('finite-audio'),cors=document.getElementById('cors-audio');
    for(const element of [video,audio,cors]){element.muted=true;await wait(element);await element.play();}
    const dynamic=new Audio();dynamic.id='dynamic-audio';dynamic.muted=true;dynamic.src='https://assets.example/allowed/dynamic.wav';document.body.appendChild(dynamic);await wait(dynamic);await dynamic.play();
    const image=new Image();image.id='dynamic-responsive';image.srcset='https://assets.example/image 1x, https://assets.example/large 2x';document.body.append(image);if(!image.complete)await new Promise((r,j)=>{image.onload=r;image.onerror=j});
    while(video.currentTime<0.12||audio.currentTime<0.12||cors.currentTime<0.12||dynamic.currentTime<0.12)await new Promise(r=>setTimeout(r,10));
    let canvas;try{const c=document.createElement('canvas');c.width=32;c.height=24;c.getContext('2d').drawImage(video,0,0);c.toDataURL();canvas='readable'}catch(e){canvas=e.name}
    window.mediaResult={videoWidth:video.videoWidth,videoHeight:video.videoHeight,videoPlayed:video.currentTime>=0.12,audioPlayed:audio.currentTime>=0.12,corsAudioPlayed:cors.currentTime>=0.12,dynamicAudioPlayed:dynamic.currentTime>=0.12,dynamicImageDecoded:image.naturalWidth>0,canvas,pictureWidth:document.getElementById('responsive-picture').naturalWidth,densityDecoded:document.getElementById('responsive-density').naturalWidth>0};
    return window.mediaResult;
  })().catch(error=>{window.mediaFailure={name:error.name,message:error.message};throw error});
  (async()=>{let parentFrontendLeak=false;`,
);
replace(
  "img-src https://assets.example; connect-src 'none'",
  "img-src https://assets.example; media-src https://assets.example/allowed/ https://peer.example/allowed/; connect-src 'none'",
);
replace(
  '      } else throw Error("Synthetic transport denied");',
  `      } else if(request.url==='https://assets.example/large'){
        body=Uint8Array.from(atob(${JSON.stringify(large.toString("base64"))}),c=>c.charCodeAt(0));type='image/png';
      } else if(request.url==='https://assets.example/favicon.ico'){
        body=Uint8Array.from(atob(png),c=>c.charCodeAt(0));type='image/x-icon';
      } else if(request.url==='https://assets.example/allowed/movie.webm'){
        body=Uint8Array.from(atob(${JSON.stringify(movie.toString("base64"))}),c=>c.charCodeAt(0));type='video/webm';
      } else if(request.url==='https://assets.example/allowed/sound.wav'||request.url==='https://assets.example/allowed/dynamic.wav'||request.url==='https://peer.example/allowed/sound.wav'){
        body=Uint8Array.from(atob(${JSON.stringify(wav.toString("base64"))}),c=>c.charCodeAt(0));type='audio/wav';if(request.url.includes('peer.example'))extra=[['access-control-allow-origin','https://site.example']];
      } else throw Error("Synthetic transport denied");`,
);
replace(
  "  const result = await frame.evaluate(() => window.jointResult);",
  `  try{await frame.waitForFunction(()=>window.mediaResult||window.mediaFailure,null,{timeout:25000});}catch(error){console.error(JSON.stringify({errors,mediaBody:await frame.evaluate(()=>document.documentElement.outerHTML.slice(-2000)),calls:await page.evaluate(()=>jointCalls)}));throw error;}
  const mediaResult=await frame.evaluate(()=>window.mediaResult||window.mediaFailure);
  assert.deepEqual(mediaResult,{videoWidth:32,videoHeight:24,videoPlayed:true,audioPlayed:true,corsAudioPlayed:true,dynamicAudioPlayed:true,dynamicImageDecoded:true,canvas:'SecurityError',pictureWidth:8,densityDecoded:true});
  const mediaCalls=await page.evaluate(()=>jointCalls);assert.equal(mediaCalls.some(c=>c.url.includes('/denied/')||c.url.includes('blocked.example')),false);
  assert.ok(nativeMediaResponses.some(r=>r.status===206&&r.contentRange.startsWith('bytes ')));
  await page.evaluate(()=>{frontendBrowser.document.frame.style.width='150px'});
  await frame.waitForFunction(()=>document.getElementById('responsive-picture').naturalWidth===1);
  const responsiveChanged=await frame.evaluate(()=>document.getElementById('responsive-picture').naturalWidth);
  console.log(JSON.stringify({nativeMedia:mediaResult,responsiveChanged,rangeResponses:nativeMediaResponses,qualified:false}));
  await fs.writeFile(${JSON.stringify(join(evidence, "BROWSER.json"))},JSON.stringify({nativeMedia:mediaResult,responsiveChanged,rangeResponses:nativeMediaResponses,websiteTransport:'deterministic',actualBuiltMainRelayProbe:true,qualified:false},null,2)+'\\n');
  const result = await frame.evaluate(() => window.jointResult);`,
);
replace(
  '"evidence/frontend-native-document-20261016/FRONTEND-BROWSER.json"',
  JSON.stringify(join(evidence, "FRONTEND-BROWSER.json")),
);
let copied;
if (
  process.env.ATLAS_MEDIA_BASELINE === "1" ||
  process.env.ATLAS_MEDIA_SOURCE_COPY
) {
  copied = await fs.mkdtemp(join(tmpdir(), "atlas-media-copy-"));
  await fs.mkdir(join(copied, "runtime"));
  for (const file of await fs.readdir(join(root, "runtime")))
    if (file.endsWith(".ts"))
      await fs.copyFile(
        join(root, "runtime", file),
        join(copied, "runtime", file),
      );
  for (const file of [
    "opaque-resource-graph.ts",
    "opaque-dynamic-resources.ts",
    "native-resource-preparer.ts",
    "native-resource-owner.ts",
    "native-resource-provider.ts",
    "frontend-rewriter.ts",
  ])
    await fs.copyFile(
      process.env.ATLAS_MEDIA_SOURCE_COPY
        ? join(resolve(process.env.ATLAS_MEDIA_SOURCE_COPY), "runtime", file)
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
