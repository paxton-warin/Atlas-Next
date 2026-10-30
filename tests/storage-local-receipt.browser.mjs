/** Actual legacy filesystem + strict-IDB-complete receipt proof, synthetic data only. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
let app,
  browser,
  origin,
  requests = 0;
before(async () => {
  const code = (
    await build({
      entryPoints: [
        resolve(
          process.env.ATLAS_LOCAL_RECEIPT_SOURCE_ROOT || ".",
          "runtime/storage-local-receipt.ts",
        ),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  app = Fastify({ logger: false });
  app.addHook("onRequest", (_q, _r, done) => {
    requests++;
    done();
  });
  app.get("/receipt.js", (_q, r) =>
    r.type("application/javascript").send(code),
  );
  app.get("/writer.js", (_q, r) =>
    r
      .type("application/javascript")
      .send(
        `import{createStorageLocalReceiptWriter}from'/receipt.js';let writer,db;const doc='browser_receipt_document_123';onmessage=async({data})=>{try{if(data.type==='init'){writer=createStorageLocalReceiptWriter(self,doc);if(!writer)return postMessage({type:'unsupported'});db=await new Promise((resolve,reject)=>{const q=indexedDB.open('atlas-receipt-proof',1);q.onupgradeneeded=()=>q.result.createObjectStore('proof');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});postMessage({type:'ready',grant:writer.grant})}if(data.type==='write'){const tx=db.transaction('proof','readwrite',{durability:'strict'});tx.objectStore('proof').put({sequence:data.sequence,synthetic:true},'head');tx.oncomplete=()=>{try{writer.write(data.sequence,{ok:true,revision:data.sequence})}catch(e){postMessage({type:'error',name:e.name,message:e.message,stack:e.stack})}};tx.onabort=()=>postMessage({type:'error',name:tx.error?.name})}if(data.type==='tamper'){writer.write(data.sequence,{ok:true,revision:data.sequence});const fs=webkitRequestFileSystemSync(TEMPORARY,1024*1024);const directory=fs.root.getDirectory('atlas-storage-receipts',{create:false}).getDirectory(writer.grant.directory,{create:false});const file=directory.getFile('r'+data.sequence%8,{create:false}),w=file.createWriter();w.truncate(0);w.write(new Blob(['tampered']));postMessage({type:'tampered'})}if(data.type==='cleanup'){writer?.dispose();db?.close();postMessage({type:'cleaned'})}}catch(e){postMessage({type:'error',name:e.name,message:e.message,stack:e.stack})}};`,
      ),
  );
  app.get("/host.js", (_q, r) =>
    r
      .type("application/javascript")
      .send(
        `import{createStorageLocalReceiptReader}from'/receipt.js';window.initialize=()=>new Promise((resolve,reject)=>{window.receiptWorker=new Worker('/writer.js',{type:'module'});receiptWorker.onmessage=({data})=>{if(data.type==='ready'){window.receiptReader=createStorageLocalReceiptReader({host:window,documentId:'browser_receipt_document_123',grant:data.grant});resolve({supported:true,reader:!!receiptReader})}else if(data.type==='unsupported')resolve({supported:false});else if(data.type==='error')reject(Error(data.name+': '+data.message+' '+data.stack))};receiptWorker.onerror=e=>reject(Error(e.message));receiptWorker.postMessage({type:'init'})});window.ready=true;`,
      ),
  );
  app.get("/", (_q, r) =>
    r
      .type("text/html")
      .send(
        '<!doctype html><title>Local receipt proof</title><script type="module" src="/host.js"></script>',
      ),
  );
  app.get("/blocked", (_q, r) =>
    r
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'none'",
      )
      .type("text/html")
      .send(
        '<!doctype html><title>CSP fallback proof</title><script type="module" src="/host.js"></script>',
      ),
  );
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});
after(async () => {
  await browser?.close();
  await app?.close();
});
async function setup(path = "/") {
  const context = await browser.newContext(),
    page = await context.newPage();
  await page.goto(origin + path);
  await page.waitForFunction(() => window.ready);
  const feature = await page.evaluate(() => initialize());
  assert.deepEqual(feature, { supported: true, reader: true });
  await page.waitForTimeout(40);
  return { context, page };
}
test("actual worker IDB completion precedes authenticated filesystem ACKs, with zero HTTP receipt traffic", async () => {
  const { context, page } = await setup();
  try {
    const before = requests;
    const proof = await page.evaluate(async () => {
      const rows = [];
      for (let sequence = 1; sequence <= 20; sequence++) {
        receiptWorker.postMessage({ type: "write", sequence });
        const start = performance.now();
        const value = receiptReader.read(sequence);
        rows.push({
          sequence,
          milliseconds: performance.now() - start,
          ok: value?.ok === true,
          revision: value?.revision ?? null,
        });
        if (!value?.ok) break;
      }
      const replayRejected = receiptReader.read(20) === undefined;
      const head = await new Promise((resolve, reject) => {
        const q = indexedDB.open("atlas-receipt-proof");
        q.onsuccess = () => {
          const db = q.result,
            tx = db.transaction("proof"),
            g = tx.objectStore("proof").get("head");
          tx.oncomplete = () => {
            db.close();
            resolve(g.result);
          };
          tx.onabort = () => reject(tx.error);
        };
        q.onerror = () => reject(q.error);
      });
      await new Promise((resolve, reject) => {
        receiptWorker.onmessage = ({ data }) =>
          data.type === "tampered"
            ? resolve()
            : data.type === "error"
              ? reject(
                  Error(data.name + ": " + data.message + " " + data.stack),
                )
              : undefined;
        receiptWorker.postMessage({ type: "tamper", sequence: 21 });
      });
      const tamperRejected = receiptReader.read(21) === undefined;
      receiptReader.dispose();
      await new Promise((resolve) => {
        receiptWorker.onmessage = () => resolve();
        receiptWorker.postMessage({ type: "cleanup" });
      });
      receiptWorker.terminate();
      return { rows, replayRejected, tamperRejected, nativeHead: head };
    });
    const result = {
      browser: browser.version(),
      synthetic: true,
      ...proof,
      HTTPRequestsDuringReceipts: requests - before,
    };
    await writeFile(
      "evidence/instagram-typing-20261027/STORAGE_LOCAL_RECEIPT_BROWSER.json",
      JSON.stringify(result, null, 2) + "\n",
    );
    assert.equal(proof.rows.length, 20);
    assert.ok(proof.rows.every((r) => r.ok && r.revision === r.sequence));
    assert.equal(proof.nativeHead.sequence, 20);
    assert.equal(result.HTTPRequestsDuringReceipts, 0);
    assert.equal(proof.replayRejected, true);
    assert.equal(proof.tamperRejected, true);
  } finally {
    await context.close();
  }
});
test("real CSP rejection yields a transport miss, not an acknowledgement", async () => {
  const { context, page } = await setup("/blocked");
  try {
    const proof = await page.evaluate(() => {
      receiptWorker.postMessage({ type: "write", sequence: 1 });
      const values = [];
      for (let i = 1; i <= 4; i++)
        values.push(receiptReader.read(i) === undefined);
      receiptReader.dispose();
      receiptWorker.terminate();
      return values;
    });
    assert.deepEqual(proof, [true, true, true, true]);
  } finally {
    await context.close();
  }
});
