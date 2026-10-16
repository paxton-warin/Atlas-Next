/** Actual private document-port authorization; no website sign-in. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chromium } from "@playwright/test";
import { compileRuntimeFixture } from "./runtime-fixture.mjs";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
const server = Fastify({ logger: false });
let browser;
for (const [name, source] of compileRuntimeFixture([
  "sandbox-controller",
  "sandbox-vault",
]))
  server.get("/" + name + ".js", (_q, r) =>
    r.type("application/javascript").send(source),
  );
server.get("/", (_q, r) =>
  r
    .type("text/html")
    .send("<!doctype html><title>Trusted form owner</title><main></main>"),
);
installSandboxFramePrototype(server, {
  capabilities: true,
  trustedBootstrap: `addEventListener('atlas:document-capabilities',e=>{window.ports=e.detail;window.initializations=[];e.detail.control.onmessage=e=>initializations.push(e.data);e.detail.control.start()})`,
});
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
  const create = () =>
    page.evaluate(async () => {
      const { createSandboxDocument } = await import("/sandbox-controller.js"),
        { SandboxVault } = await import("/sandbox-vault.js");
      window.navigations = [];
      const b = createSandboxDocument({
        website: "https://source.test/document",
        container: document.querySelector("main"),
        factory: indexedDB,
        vault: new SandboxVault(indexedDB),
        forbiddenOrigins: ["https://node.test"],
        fetch: async (request) => ({
          url: request.url,
          status: 200,
          statusText: "OK",
          headers: [],
          body: new ArrayBuffer(0),
        }),
        sourceProvider: {
          prepare: async () => ({
            url: "https://source.test/document",
            html: '<html><head><base href="https://allowed.test/forms/"></head><body><form></form></body></html>',
            contentPolicies: [
              "base-uri https://allowed.test; form-action https://allowed.test https://node.test " +
                location.origin,
            ],
            coep: "unsafe-none",
          }),
        },
        onNavigation(url, form) {
          let redirectDenied = false;
          try {
            form.authorizeURL("https://peer.test/leak", 1);
          } catch {
            redirectDenied = true;
          }
          window.navigations.push({
            url,
            method: form.method,
            body: new TextDecoder().decode(form.body),
            contentType: form.contentType,
            initiatorURL: form.initiatorURL,
            redirectDenied,
          });
        },
      });
      window.binding = b;
      await b.ready;
      return { documentId: b.documentId };
    });
  const binding = await create();
  const frame = page.frames().find((f) => f.url().includes(binding.documentId));
  assert.ok(frame);
  await frame.waitForFunction(() => window.initializations.length === 1);
  assert.equal(
    await frame.evaluate(() => initializations[0].source.baseURL),
    "https://allowed.test/forms/",
  );
  await frame.evaluate(() => {
    const { control, documentId } = ports;
    const send = (navigation, id = documentId) =>
      control.postMessage({
        protocol: 2,
        documentId: id,
        type: "form-navigation",
        navigation,
      });
    parent.postMessage(
      {
        protocol: 2,
        documentId,
        type: "form-navigation",
        navigation: {
          url: "https://allowed.test/window-attack",
          method: "GET",
        },
      },
      "*",
    );
    send(
      { url: "https://allowed.test/wrong-document", method: "GET" },
      "doc_wrong_document_123456",
    );
    send({
      url: "https://allowed.test/forged-headers",
      method: "GET",
      headers: [["cookie", "forged"]],
    });
    send({ url: location.origin + "/api/admin/logout", method: "GET" });
    send({ url: "https://node.test/private", method: "GET" });
    send({
      url: "https://peer.test/csp-denied",
      method: "POST",
      body: new TextEncoder().encode("no=leak").buffer,
      contentType: "text/plain",
    });
  });
  await page.waitForTimeout(30);
  assert.deepEqual(await page.evaluate(() => navigations), []);
  await frame.evaluate(() =>
    ports.control.postMessage({
      protocol: 2,
      documentId: ports.documentId,
      type: "form-navigation",
      navigation: {
        url: "https://allowed.test/submit",
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: new TextEncoder().encode("field=value").buffer,
      },
    }),
  );
  await page.waitForFunction(() => navigations.length === 1);
  assert.deepEqual(await page.evaluate(() => navigations), [
    {
      url: "https://allowed.test/submit",
      method: "POST",
      body: "field=value",
      contentType: "application/x-www-form-urlencoded",
      initiatorURL: "https://source.test/document",
      redirectDenied: true,
    },
  ]);
  await frame.evaluate(() =>
    ports.control.postMessage({
      protocol: 2,
      documentId: ports.documentId,
      type: "form-navigation",
      navigation: { url: "https://allowed.test/replay", method: "GET" },
    }),
  );
  await page.waitForTimeout(25);
  assert.equal(await page.evaluate(() => navigations.length), 1);
  await page.evaluate(() => binding.dispose());
  const stale = await create();
  const staleFrame = page
    .frames()
    .find((f) => f.url().includes(stale.documentId));
  await staleFrame.waitForFunction(() => window.initializations.length === 1);
  // Test bootstrap deliberately exposes the grant for revocation testing only.
  // Retain the actual port outside the realm BEFORE the owner destroys it.
  await page.evaluate(() =>
    addEventListener("message", (event) => {
      if (event.data?.type === "retain-test-control")
        window.retainedControl = event.ports[0];
    }),
  );
  await staleFrame.evaluate(() =>
    parent.postMessage({ type: "retain-test-control" }, "*", [ports.control]),
  );
  await page.waitForFunction(() => window.retainedControl);
  await page.evaluate((documentId) => {
    binding.dispose();
    retainedControl.postMessage({
      protocol: 2,
      documentId,
      type: "form-navigation",
      navigation: { url: "https://allowed.test/stale", method: "GET" },
    });
  }, stale.documentId);
  await page.waitForTimeout(25);
  assert.deepEqual(await page.evaluate(() => navigations), []);
  console.log(
    "FORM_CONTROLLER: private port GET/POST validation, first-base policy, fixed initiator, frontend/node/CSP denial, forged-window/wrong-document rejection, replay/stale-document rejection PASS",
  );
} finally {
  await browser?.close();
  await server.close();
}
