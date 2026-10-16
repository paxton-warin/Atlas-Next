/** Native Chrome image-context comparator, including nosniff and malformed data. */
import http from "node:http";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { imageResourceMIME } from "../runtime/raster-image-mime.ts";
const evidence = resolve("evidence/raster-mime-20261016"),
  webp = await fs.readFile(evidence + "/FIXTURE.webp");
const bodies = {
  good: webp,
  bad: Buffer.from("RIFFxxxxWEBPVP"),
  svg: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  ),
  html: Buffer.from("<html><script>globalThis.rasterExecuted=true</script>"),
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture");
  if (u.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html>");
    return;
  }
  if (u.pathname !== "/image") {res.writeHead(404);res.end();return;}
  const headers = {
    "content-length": bodies[u.searchParams.get("body")].length,
  };
  if (u.searchParams.get("mime") !== "missing")
    headers["content-type"] = u.searchParams.get("mime");
  if (u.searchParams.get("nosniff") === "1")
    headers["x-content-type-options"] = "nosniff";
  res.writeHead(200, headers);
  res.end(bodies[u.searchParams.get("body")]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const rows = [];
  for (const body of ["good", "bad", "svg", "html"])
    for (const mime of ["application/octet-stream", "missing"])
      for (const nosniff of [0, 1]) {
        const native = await page.evaluate(
          async ({ body, mime, nosniff }) => {
            const image = new Image();
            const loaded = new Promise((resolve) => {
              image.onload = () => resolve(true);
              image.onerror = () => resolve(false);
            });
            image.src =
              "/image?" +
              new URLSearchParams({ body, mime, nosniff: String(nosniff) });
            const decoded = await loaded;
            return {
              decoded,
              width: image.naturalWidth,
              height: image.naturalHeight,
              executed: globalThis.rasterExecuted === true,
            };
          },
          { body, mime, nosniff },
        );
        if (body === "good")
          assert.deepEqual(native, {
            decoded: true,
            width: 16,
            height: 8,
            executed: false,
          });
        else assert.equal(native.decoded, false);
        assert.equal(native.executed, false);
        rows.push({
          body,
          mime,
          nosniff,
          ...native,
          inferred:
            imageResourceMIME(mime === "missing" ? "" : mime, bodies[body]) ??
            null,
        });
      }
  console.log(
    JSON.stringify({
      nativeComparator: rows,
      scriptablePromotion: false,
      signatureIsNotDecoderValidation: true,
    }),
  );
  await fs.writeFile(
    evidence + "/NATIVE-BROWSER.json",
    JSON.stringify(
      {
        rows,
        scriptablePromotion: false,
        signatureIsNotDecoderValidation: true,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
