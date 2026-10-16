/** Compare scripting-enabled native Chrome to inert-parser authorization. */
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { compileRuntimeFixture } from "./runtime-fixture.mjs";
const server = Fastify({ logger: false }),
  requests = [];
let browser;
const html = `<!doctype html><html><head><noscript><meta http-equiv="refresh" content="0;url=/fallback-navigation"><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></noscript></head><body><noscript><script>window.fallbackRan=true</script><img src="/fallback-image"></noscript><script>window.activeRan=true</script><h1>Active content</h1></body></html>`;
server.addHook("onRequest", async (req) => requests.push(req.url));
for (const [name, source] of compileRuntimeFixture([
  "original-document-plan",
  "original-document-policy",
  "frontend-document-source",
]))
  server.get("/" + name + ".js", (_q, r) => {
    const before =
      process.env.ATLAS_NOSCRIPT_BASELINE &&
      ["original-document-plan", "frontend-document-source"].includes(name)
        ? ts
            .transpileModule(
              fs.readFileSync(
                "evidence/base-form-navigation-20261016/before-noscript/runtime/" +
                  name +
                  ".ts",
                "utf8",
              ),
              {
                compilerOptions: {
                  module: ts.ModuleKind.ESNext,
                  target: ts.ScriptTarget.ES2022,
                },
              },
            )
            .outputText.replaceAll(/\.\/([^"']+)\.ts/g, "./$1.js")
        : source;
    return r.type("application/javascript").send(before);
  });
server.get("/", (_q, r) => r.type("text/html").send(html));
server.get("/fallback-navigation", (_q, r) =>
  r.type("text/html").send("<h1>Wrong navigation</h1>"),
);
server.get("/fallback-image", (_q, r) =>
  r.type("image/png").send(Buffer.alloc(0)),
);
try {
  const origin = await server.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.waitForTimeout(100);
  assert.equal(page.url(), origin + "/");
  assert.equal(await page.evaluate(() => activeRan), true);
  assert.equal(await page.evaluate(() => window.fallbackRan), undefined);
  assert.equal(
    requests.some((url) => url.startsWith("/fallback-")),
    false,
  );
  const result = await page.evaluate(async (html) => {
    const { createOriginalDocumentPlan } = await import(
        "/original-document-plan.js"
      ),
      { createOriginalDocumentPolicy } = await import(
        "/original-document-policy.js"
      ),
      { createFrontendDocumentSource } = await import(
        "/frontend-document-source.js"
      );
    const policy = createOriginalDocumentPolicy({
      documentURL: "https://site.test/page",
      contentPolicies: [],
    });
    const plan = await createOriginalDocumentPlan({
      documentURL: "https://site.test/page",
      policy,
    }).prepare(html);
    const parsed = new DOMParser().parseFromString(plan.html, "text/html");
    let activeRefreshDenied = false;
    try {
      await createOriginalDocumentPlan({
        documentURL: "https://site.test/page",
        policy,
      }).prepare('<meta http-equiv=refresh content="0;url=/active">');
    } catch (e) {
      activeRefreshDenied = e.code === "original_plan_navigation_unsupported";
    }
    let activeCSP;
    async function sourceFor(text) {
      const source = createFrontendDocumentSource({
        frontendOrigin: "https://front.test",
        selectedNodeOrigin: () => "https://node.test",
        fetch: async (request) => ({
          url: request.url,
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/html"]],
          body: new TextEncoder().encode(text).buffer,
        }),
      });
      try {
        return await source.prepare({
          documentId: "scripting_fallback_doc_123",
          website: "https://site.test/page",
          signal: new AbortController().signal,
        });
      } finally {
        source.dispose();
      }
    }
    const inertPolicy = (await sourceFor(html)).contentPolicies;
    activeCSP = (
      await sourceFor(
        `<html><head><noscript><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></noscript><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head><body></body></html>`,
      )
    ).contentPolicies;
    return {
      noscriptRemaining: parsed.querySelectorAll("noscript").length,
      activeScript: parsed.querySelector("script").textContent,
      decisions: plan.decisions.length,
      inertPolicy,
      activeCSP,
      activeRefreshDenied,
    };
  }, html);
  assert.deepEqual(result, {
    noscriptRemaining: 0,
    activeScript: "window.activeRan=true",
    decisions: 1,
    inertPolicy: [],
    activeCSP: ["script-src 'self'"],
    activeRefreshDenied: true,
  });
  console.log(
    "SCRIPTING_FALLBACK: native enabled scripts ignore noscript refresh/script/image/CSP; trusted plan excludes only fallback trees; active refresh denied and active CSP retained PASS",
  );
} finally {
  await browser?.close();
  await server.close();
}
