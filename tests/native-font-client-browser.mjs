/** Actual opaque Chrome private font channel: native decoding, capture against
 * hostile prototypes, request/document binding, and explicit blob revocation. */
import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { createNativeResourceClient } from "../runtime/native-resource-owner.ts";
const require = createRequire(import.meta.url),
  font = [
    ...(await fs.readFile(
      join(
        require.resolve("katex/dist/katex.min.css"),
        "../fonts/KaTeX_Main-Regular.woff2",
      ),
    )),
  ];
const documentId = "font_client_document_123456",
  protocol = "atlas-native-resource-v1",
  fontId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  selected = "https://selected.test";
const child = `<!doctype html><script>
 const NativeURL=URL,nativeCreate=URL.createObjectURL,nativeRevoke=URL.revokeObjectURL,nativeFetch=fetch.bind(window),fonts=[];
 URL.createObjectURL=function(blob){const url=Reflect.apply(nativeCreate,NativeURL,[blob]);fonts.push(url);return url};
 window.testResult={poisonTouches:0};
 addEventListener('message',function init(event){if(!event.ports[0])return;removeEventListener('message',init);
  const port=event.ports[0];class FakeImage extends EventTarget{set src(_value){queueMicrotask(()=>this.dispatchEvent(new Event('load')))}}
  const client=(${createNativeResourceClient.toString()})({port,documentId:${JSON.stringify(documentId)},resourceOrigin:${JSON.stringify(selected)},Image:FakeImage,timeoutMs:1000});
  const poison=()=>{testResult.poisonTouches++;throw Error('hostile prototype called')};
  Object.defineProperty(MessageEvent.prototype,'data',{configurable:true,get:poison});Map.prototype.get=poison;Map.prototype.set=poison;Map.prototype.delete=poison;Map.prototype.clear=poison;Map.prototype.values=poison;
  EventTarget.prototype.removeEventListener=poison;URL.createObjectURL=poison;URL.revokeObjectURL=poison;window.Blob=poison;
  window.run=async()=>{try{const value=await client.prepare({url:'https://styles.test/root.css',kind:'style'});testResult.prepared=value;testResult.urls=fonts.slice();const face=new FontFace('PrivateBridgeFont','url("'+fonts.at(-1)+'")');await face.load();testResult.decoded=face.status==='loaded';testResult.bytes=(await(await nativeFetch(fonts.at(-1))).arrayBuffer()).byteLength;return testResult}catch(error){testResult.error=error.code||error.message;return testResult}};
  window.revokeResult=async()=>{client.dispose();try{await nativeFetch(fonts.at(-1));testResult.revoked=false}catch{testResult.revoked=true}return testResult};
  window.fontRevoked=async()=>{try{await nativeFetch(fonts.at(-1));return false}catch{return true}};
  parent.postMessage('client-bound','*');
 });
 </script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/child") {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy":
        "sandbox allow-scripts;default-src 'none';script-src 'unsafe-inline';font-src blob:;connect-src blob:",
    });
    res.end(child);
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><main></main>");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage();
  await page.goto(origin);
  for (const mode of ["valid", "unrequested", "extra-authority"]) {
    await page.evaluate(
      ({ origin, documentId, protocol, fontId, selected, font, mode }) =>
        new Promise((resolve) => {
          const frame = document.createElement("iframe");
          frame.sandbox = "allow-scripts";
          frame.src = origin + "/child";
          document.querySelector("main").replaceChildren(frame);
          const channel = new MessageChannel();
          window.fontWire = [];
          window.fontPort = channel.port1;
          channel.port1.onmessage = (event) => {
            const value = event.data;
            fontWire.push({
              type: value.type,
              target: value.target,
              fontId: value.fontId,
            });
            if (value.type === "enrolled") resolve();
            if (value.type === "prepare") {
              const body = new Uint8Array(font).buffer;
              channel.port1.postMessage(
                {
                  protocol,
                  documentId,
                  type: "font-snapshot",
                  sequence:
                    mode === "unrequested"
                      ? value.sequence + 100
                      : value.sequence,
                  fontId,
                  mime: "font/woff2",
                  body,
                  ...(mode === "extra-authority"
                    ? { sourceURL: "https://protected.test/private" }
                    : {}),
                },
                [body],
              );
            }
            if (value.type === "font-bound")
              channel.port1.postMessage({
                protocol,
                documentId,
                type: "resource",
                sequence: value.target,
                url:
                  selected + "/native-resource/v1/resource/" + "a".repeat(43),
              });
          };
          const bound = (event) => {
            if (
              event.source !== frame.contentWindow ||
              event.data !== "client-bound"
            )
              return;
            removeEventListener("message", bound);
            channel.port1.postMessage({
              protocol,
              documentId,
              type: "enroll",
              url: selected + "/native-resource/v1/enroll/" + "b".repeat(43),
              nonce: "n",
            });
          };
          addEventListener("message", bound);
          frame.onload = () =>
            frame.contentWindow.postMessage("bind", "*", [channel.port2]);
        }),
      { origin, documentId, protocol, fontId, selected, font, mode },
    );
    const frame = page.frames().find((f) => f.url() === origin + "/child");
    const result = JSON.parse(
      await frame.evaluate(async () => JSON.stringify(await run())),
    );
    assert.equal(result.poisonTouches, 0);
    if (mode === "valid") {
      assert.equal(result.decoded, true);
      assert.equal(result.bytes, font.length);
      assert.equal(result.urls.length, 1);
      assert.match(result.urls[0], /^blob:null\//);
      await page.evaluate(
        ({ protocol, documentId, fontId }) =>
          fontPort.postMessage({
            protocol,
            documentId,
            type: "font-revoke",
            fontId,
          }),
        { protocol, documentId, fontId },
      );
      let revoked = false;
      for (let n = 0; n < 40 && !revoked; n++) {
        revoked = JSON.parse(
          await frame.evaluate(async () => JSON.stringify(await fontRevoked())),
        );
        if (!revoked) await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(revoked, true);
      const again = JSON.parse(
        await frame.evaluate(async () => JSON.stringify(await run())),
      );
      assert.equal(again.decoded, true);
      assert.equal(again.urls.length, 2);
      const disposed = JSON.parse(
        await frame.evaluate(async () => JSON.stringify(await revokeResult())),
      );
      assert.equal(disposed.revoked, true);
      assert.equal(disposed.poisonTouches, 0);
    } else {
      assert.equal(
        result.error,
        mode === "unrequested"
          ? "native_resource_client_disposed"
          : "native_resource_aborted",
      );
      assert.equal(result.urls, undefined);
      assert.equal(
        (await page.evaluate(() => fontWire)).some(
          (v) => v.type === "font-bound",
        ),
        false,
      );
    }
    await page.evaluate(() => fontPort.close());
  }
  const receipt = {
    opaqueFontDecode: true,
    anonymousCorsAuthorizedSnapshotOnly: true,
    hostilePrototypeTouches: 0,
    requestAndDocumentBound: true,
    extraAuthorityRejected: true,
    targetedRevoke: true,
    disposeRevoke: true,
    qualified: false,
  };
  console.log(JSON.stringify(receipt));
  await fs.writeFile(
    resolve("evidence/native-font-dependency-20261016/CLIENT-BROWSER.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
