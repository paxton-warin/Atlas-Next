/** Native-document identity and self-boot lifecycle boundary only. The child is
 * a minimal trusted bootstrap exercising the REAL controller/identity helper;
 * no claim of website, relay, or storage compatibility is made by this test. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const controllerSource = process.env.ATLAS_ATTESTATION_CONTROLLER_SOURCE;
const controller = await build({
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  ...(controllerSource
    ? {
        stdin: {
          contents: await readFile(controllerSource, "utf8"),
          resolveDir: resolve("runtime"),
          loader: "ts",
        },
      }
    : { entryPoints: ["runtime/sandbox-controller.ts"] }),
});
const identity = await build({
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "IdentityProbe",
  target: "es2022",
  logLevel: "silent",
  stdin: {
    contents:
      "export {captureOpaqueDocumentIdentity} from './opaque-document.ts';",
    resolveDir: resolve("runtime"),
  },
});
const bootstrap =
  identity.outputFiles[0].text +
  `
(()=>{
 const active=IdentityProbe.captureOpaqueDocumentIdentity(window), original=document;
 const open=Document.prototype.open.bind(document),write=Document.prototype.write.bind(document),close=Document.prototype.close.bind(document);
 const nativeReplace=location.replace.bind(location), URLCtor=URL;
 let claimed=false, written=false, started=false, mode='';
 addEventListener('atlas:document-capabilities',event=>{
  if(claimed)return;claimed=true;const grant=event.detail,port=grant.control,id=grant.documentId,send=port.postMessage.bind(port);
  const post=(type,extra={})=>send({protocol:2,documentId:id,type,...extra});
  port.onmessage=({data})=>{
   if(data?.protocol!==2||data.documentId!==id)return;
   if(data.type==='initialize'){
    mode=new URLCtor(data.website).searchParams.get('mode')||'legitimate';
    if(mode==='preparation-error'){post('document-content',{phase:'error'});return}
    started=true;
    post('document-content',{phase:'start'});
    if(mode==='unexpected-navigation'){
     post('document-content',{phase:'ready'});
     nativeReplace('/navigation-target');
    }
   }else if(data.type==='permit-document-content'&&started&&!written&&mode!=='unexpected-navigation'){
    open();write('<!doctype html><title>Written document</title><h1>Same opaque document</h1>');close();written=true;
    post('document-content',{phase:'ready'});
   }else if(data.type==='attest-document'){
    if(mode==='forged-reply'){
     parent.postMessage({protocol:2,documentId:id,type:'document-attestation',nonce:data.nonce,active:true},'*');
     post('document-attestation',{nonce:'0'.repeat(32)===data.nonce?'1'.repeat(32):'0'.repeat(32),active:true});
    }else post('document-attestation',{nonce:data.nonce,active:mode==='negative-reply'?false:written&&active()});
   }
  };port.start();
 });
})();`;
const app = Fastify({ logger: false });
app.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send(
      "<!doctype html><title>Trusted lifecycle fixture</title><main></main>",
    ),
);
app.get("/controller.js", (_req, reply) =>
  reply.type("application/javascript").send(controller.outputFiles[0].contents),
);
app.get("/identity.js", (_req, reply) =>
  reply
    .type("application/javascript")
    .send(
      identity.outputFiles[0].text +
        "\nexport const capture=IdentityProbe.captureOpaqueDocumentIdentity;",
    ),
);
app.get("/navigation-target", async (_req, reply) => {
  await new Promise((r) => setTimeout(r, 80));
  return reply
    .type("text/html")
    .send(
      "<!doctype html><title>Different document</title><h1>Navigation target</h1>",
    );
});
installSandboxFramePrototype(app, {
  capabilities: true,
  trustedBootstrap: bootstrap,
});
await app.listen({ host: "127.0.0.1", port: 0 });
const origin = "http://127.0.0.1:" + app.server.address().port;
let browser;
const receipts = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  const open = async (mode) => {
    await page.goto(origin);
    await page.evaluate(async (mode) => {
      const { createSandboxDocument } = await import("/controller.js");
      window.states = [];
      window.binding = createSandboxDocument({
        website: "https://logical.example/page?mode=" + mode,
        container: document.querySelector("main"),
        factory: indexedDB,
        vault: {
          snapshot: async () => ({ revision: 0, entries: [] }),
          write: async () => {
            throw Error("unused storage fixture");
          },
        },
        selfBootContent: true,
        contentAttestationTimeoutMs: 200,
        timeoutMs: 3000,
        onContentState: (state) => window.states.push(state),
        fetch: async () => {
          throw Error("unused network fixture");
        },
      });
      await window.binding.ready;
    }, mode);
  };
  const only = process.env.ATLAS_ATTESTATION_CASE;
  if (!only || only === "legitimate") {
    await open("legitimate");
    await page.waitForFunction(() => window.states.includes("ready"));
    assert.deepEqual(
      await page.evaluate(() => ({ live: binding.live, states })),
      { live: true, states: ["ready"] },
    );
    const child = page.frames().find((f) => f.url().includes("/browse/frame/"));
    assert.equal(await child.locator("h1").innerText(), "Same opaque document");
    const isolation = await child.evaluate(() => {
      let parentDenied = false,
        storageDenied = false;
      try {
        void parent.document;
      } catch {
        parentDenied = true;
      }
      try {
        void localStorage;
      } catch {
        storageDenied = true;
      }
      return { origin: window.origin, parentDenied, storageDenied };
    });
    assert.deepEqual(isolation, {
      origin: "null",
      parentDenied: true,
      storageDenied: true,
    });
    await page.evaluate(() => {
      binding.frame.src = "/navigation-target";
    });
    await page.waitForFunction(() => !window.binding.live);
    receipts.push({
      case: "same_document_write_attests_then_later_navigation_revokes",
      result: "pass",
      isolation,
    });
  }
  for (const mode of [
    "unexpected-navigation",
    "forged-reply",
    "negative-reply",
    "preparation-error",
  ]) {
    if (only && only !== mode) continue;
    await open(mode);
    // Observe the invariant, not a tight wall-clock delay. The old boolean-only
    // implementation exhausts this deadline with live=true/ready retained.
    await page
      .waitForFunction(() => !window.binding.live, null, { timeout: 3000 })
      .catch(() => {});
    const result = await page.evaluate(() => ({ live: binding.live, states }));
    assert.deepEqual(
      result,
      { live: false, states: ["error"] },
      mode + " must not retain its private binding",
    );
    receipts.push({ case: mode, result: "pass" });
  }
  if (!only || only === "native-getter") {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { capture } = await import("/identity.js");
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const sameProxy = frame.contentWindow,
        identity = capture(sameProxy),
        before = identity();
      await new Promise((resolve) => {
        frame.onload = resolve;
        frame.srcdoc =
          "<!doctype html><title>Replacement native Document</title>";
      });
      const after = identity(),
        proxyUnchanged = frame.contentWindow === sameProxy;
      frame.remove();
      return { before, after, proxyUnchanged };
    });
    assert.deepEqual(result, {
      before: true,
      after: false,
      proxyUnchanged: true,
    });
    receipts.push({
      case: "captured_native_getter_rejects_reused_windowproxy",
      result: "pass",
    });
  }
  const receipt = {
    result: "opaque_document_attestation_verified",
    cases: receipts,
    transport: "unused fixed fixture; lifecycle boundary only",
  };
  await writeFile(
    "evidence/opaque-document-attestation-20261016/MODIFIED.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await app.close();
}
