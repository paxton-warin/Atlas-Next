/** Real native HTML parser qualification; assigned transport is simulated here.
 * No website parsing may execute script or issue native frontend HTTP requests.
 * Separate actual assigned-node integration is the controller's joint gate. */
import Fastify from "fastify";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild"),
  app = Fastify({ logger: false }),
  requests = [];
let browser;
const bundle = (
  await build({
    entryPoints: ["runtime/frontend-document-source.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  })
).outputFiles[0].text;
app.addHook("onRequest", (req, _rep, done) => {
  requests.push(req.url);
  done();
});
app.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Trusted document source test</title>"),
);
app.get("/source.js", (_req, reply) =>
  reply.type("application/javascript").send(bundle),
);
app.get("/favicon.ico", (_req, reply) => reply.code(204).send());
app.get("/probe-image", (_req, reply) =>
  reply.type("image/png").send(Buffer.from([137, 80, 78, 71])),
);
app.get("/probe-frame", (_req, reply) =>
  reply.type("text/html").send("<script>parent.__bad=true</script>"),
);
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://localhost:" + app.server.address().port;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const { createFrontendDocumentSource } = await import("/source.js"),
      transport = [];
    let html =
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src &#39;none&#39;; img-src https://images.test"><meta http-equiv="Content-Security-Policy-Report-Only" content="default-src none"></head><body><meta http-equiv="Content-Security-Policy" content="ignored-body-meta"><img src="' +
      location.origin +
      '/probe-image"><iframe src="' +
      location.origin +
      '/probe-frame"></iframe><script>window.__bad=true</script></body></html>';
    const api = createFrontendDocumentSource({
      frontendOrigin: location.origin,
      selectedNodeOrigin: () => "https://node.test",
      fetch: async (req, ctx) => {
        transport.push({
          mode: req.mode,
          navigation: ctx.topLevelNavigation,
          referrer: ctx.referrerURL,
        });
        return {
          url: req.url,
          status: 200,
          statusText: "OK",
          headers: [
            ["content-type", "text/html"],
            ["content-security-policy", "connect-src 'self'"],
            ["content-security-policy-report-only", "default-src 'none'"],
          ],
          body: new TextEncoder().encode(html).buffer,
        };
      },
    });
    const get = Element.prototype.getAttribute,
      query = Document.prototype.querySelectorAll,
      parse = DOMParser.prototype.parseFromString;
    Element.prototype.getAttribute = () => {
      throw Error("website replacement");
    };
    Document.prototype.querySelectorAll = () => {
      throw Error("website replacement");
    };
    DOMParser.prototype.parseFromString = () => {
      throw Error("website replacement");
    };
    let value;
    try {
      value = await api.prepare({
        documentId: "real_native_parser_document",
        website: "https://website.test/",
        signal: new AbortController().signal,
      });
    } finally {
      Element.prototype.getAttribute = get;
      Document.prototype.querySelectorAll = query;
      DOMParser.prototype.parseFromString = parse;
    }
    await new Promise((r) => setTimeout(r, 150));
    api.dispose();
    return {
      policies: value.contentPolicies,
      coep: value.coep,
      url: value.url,
      executed: window.__bad === true,
      transport,
    };
  });
  assert.deepEqual(result.policies, [
    "connect-src 'self'",
    "script-src 'none'; img-src https://images.test",
  ]);
  assert.equal(result.executed, false);
  assert.equal(
    requests.some((p) => p === "/probe-image" || p === "/probe-frame"),
    false,
  );
  assert.deepEqual(result.transport, [
    { mode: "no-cors", navigation: true, referrer: null },
  ]);
  const receipt = {
    groups: 4,
    realDOMParser: true,
    entitiesDecoded: true,
    bodyMetaIgnored: true,
    reportOnlyIgnored: true,
    capturedIntrinsics: true,
    nativeResourceRequests: 0,
    websiteScriptExecuted: false,
    assignedTransport: "simulated; real joint controller gate separate",
    result,
  };
  const dir = "evidence/combined-update-20261015/frontend-document-source";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    dir + "/native-parser.json",
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await app.close();
}
