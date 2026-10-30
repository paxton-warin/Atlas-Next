import { test, expect, type Page } from "@playwright/test";
import Fastify from "fastify";
import { compileRuntimeFixture } from "./runtime-fixture.mjs";
import {
  installSandboxFramePrototype,
  SANDBOX_CSP,
  SANDBOX_CAPABILITY_BOOTSTRAP,
} from "../server/sandbox-frame.mjs";

const server = Fastify({ logger: false });
let origin: string;
let streamInitial = false;
const streams: any[] = [];
test.beforeAll(async () => {
  server.addHook("onRequest", async (request, reply) => {
    if (streamInitial && request.url.startsWith("/browse/frame/")) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": SANDBOX_CSP,
      });
      reply.raw.write(
        // Deliberately offer before load in this adversarial streaming fixture.
        // Production now waits for load, but an early original-document offer
        // must still not transfer its private endpoints to a replacement realm.
        "<!doctype html><script>" + SANDBOX_CAPABILITY_BOOTSTRAP.replace(
          "if(document.readyState==='complete')ready();else addEventListener('load',ready,{once:true});",
          "ready();",
        ) + "</script>",
      );
      streams.push(reply.raw);
    }
  });
  for (const [name,compiled] of compileRuntimeFixture([
    "sandbox-controller",
    "page-controls-protocol",
    // The transpile-only fixture must serve the controller's static policy
    // closure as real modules, exactly as the built runtime resolves it.
    "original-document-policy",
    "original-document-plan",
    "sandbox-network",
    "sandbox-vault",
    "sandbox-broker",
    "sandbox-idb",
  ])) {
    server.get(`/${name}.js`, (_request, reply) =>
      reply.type("application/javascript").send(compiled),
    );
  }
  server.get("/", (_request, reply) =>
    reply
      .type("text/html")
      .send("<!doctype html><title>Trusted Atlas fixture</title><main></main>"),
  );
  server.get("/replacement", (_request, reply) =>
    reply
      .type("text/html")
      .send(
        `<!doctype html><script>window.replacement=true;window.captured=false;addEventListener('message',event=>{if(event.data?.type!=='bind-capabilities')return;window.captured=true;const port=event.ports[0];port.onmessage=event=>window.oldSnapshot=event.data.snapshot;port.start();port.postMessage({protocol:2,documentId:event.data.documentId,type:'bound'});});</script>`,
      ),
  );
  installSandboxFramePrototype(server, {
    capabilities: true,
    trustedBootstrap: `
    window.grants=0;window.initializations=[];
    addEventListener('atlas:document-capabilities',event=>{
      window.grants++;window.ports=event.detail;
      event.detail.control.onmessage=event=>window.initializations.push(event.data);
      event.detail.control.start();
      for(const key of ['storage','network']){
        const port=event.detail[key];window[key+'Replies']=[];
        port.onmessage=event=>window[key+'Replies'].push(event.data);port.start();
      }
    });
  `,
  });
  origin = await server.listen({ host: "127.0.0.1", port: 0 });
});
test.afterAll(() => {
  for (const stream of streams) stream.end();
  return server.close();
});

async function create(page: Page, slow = false, timeoutMs = 10000) {
  await page.goto(origin);
  return page.evaluate(
    async ({ slow, timeoutMs }) => {
      const { SandboxVault } = await import("/sandbox-vault.js");
      const { createSandboxDocument } = await import("/sandbox-controller.js");
      const vault = new SandboxVault(indexedDB);
      await vault.write("https://website.example", {
        op: "set",
        key: "save",
        value: "hydrated",
      });
      (window as any).snapshotCalls = 0;
      (window as any).transportCalls = 0;
      (window as any).navigation = [];
      const binding = createSandboxDocument({
        website: "https://website.example/game",
        container: document.querySelector("main")!,
        factory: indexedDB,
        timeoutMs,
        vault: {
          write: vault.write.bind(vault),
          async snapshot(value: string) {
            (window as any).snapshotCalls++;
            if (slow)
              await new Promise<void>((resolve) => {
                (window as any).hydrate = resolve;
              });
            return vault.snapshot(value);
          },
        },
        fetch: async (request: any, context: any) => {
          (window as any).transportCalls++;
          (window as any).lastOrigin = context.origin;
          return {
            url: request.url,
            status: 200,
            statusText: "OK",
            headers: [],
            body: new TextEncoder().encode("site bytes").buffer,
          };
        },
        onNavigation: (url: string) => (window as any).navigation.push(url),
      });
      (window as any).binding = binding;
      (window as any).vault = vault;
      (window as any).bindingReady = false;
      binding.ready
        .then(() => {
          (window as any).bindingReady = true;
        })
        .catch(() => {});
      return { documentId: binding.documentId, src: binding.frame.src };
    },
    { slow, timeoutMs },
  );
}
async function initialized(page: Page, id: string) {
  await page.waitForFunction(() => (window as any).bindingReady);
  const frame = page.frames().find((frame) => frame.url().includes(id))!;
  await frame.waitForFunction(
    () => (window as any).initializations.length === 1,
  );
  return frame;
}

test("one-shot document grants preserve opaque origin and prehydrate before execution", async ({
  page,
}) => {
  const created = await create(page);
  const frame = await initialized(page, created.documentId);
  expect(new URL(frame.url()).origin).toBe(origin);
  expect(
    await frame.evaluate(() => ({
      effective: window.origin,
      grants: (window as any).grants,
      initial: (window as any).initializations[0].snapshot,
    })),
  ).toEqual({
    effective: "null",
    grants: 1,
    initial: { revision: 1, entries: [["save", "hydrated"]] },
  });
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe(
    "allow-scripts allow-popups",
  );
  expect(await page.locator("iframe").getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(await page.locator("iframe").getAttribute("sandbox")).not.toContain("allow-popups-to-escape-sandbox");
  expect(
    await frame.evaluate(() => {
      try {
        return parent.document.title;
      } catch (error) {
        return (error as Error).name;
      }
    }),
  ).toBe("SecurityError");
  await frame.evaluate(() =>
    (window as any).ports.storage.postMessage({
      protocol: 2,
      documentId: (window as any).ports.documentId,
      sequence: 1,
      type: "mutate",
      change: { op: "set", key: "save", value: "committed" },
    }),
  );
  await frame.waitForFunction(
    () => (window as any).storageReplies.length === 1,
  );
  expect(
    await page.evaluate(() =>
      (window as any).vault.snapshot("https://website.example"),
    ),
  ).toEqual({ revision: 2, entries: [["save", "committed"]] });
  await frame.evaluate(() =>
    (window as any).ports.network.postMessage({
      protocol: "atlas-network-v2",
      documentId: (window as any).ports.documentId,
      sequence: 1,
      type: "fetch",
      request: { url: "/resource", method: "GET", headers: [] },
    }),
  );
  await frame.waitForFunction(
    () => (window as any).networkReplies.length === 1,
  );
  expect(await page.evaluate(() => (window as any).lastOrigin)).toBe(
    "https://website.example",
  );
  expect(
    (await frame.evaluate(() => (window as any).networkReplies[0])).type,
  ).toBe("response");
});

test("an unfinished original document cannot grant old-site ports to its first-load replacement during hydration", async ({
  page,
}) => {
  streamInitial = true;
  try {
    await create(page, true, 1000);
    await page.waitForFunction(() => (window as any).snapshotCalls === 1);
    await page.evaluate(() => {
      (window as any).binding.frame.src = "/replacement";
    });
    await expect
      .poll(() =>
        page.frames().some((value) => value.url().endsWith("/replacement")),
      )
      .toBe(true);
    const replacement = page
      .frames()
      .find((value) => value.url().endsWith("/replacement"))!;
    await replacement.waitForFunction(() => (window as any).replacement);
    await page.evaluate(() => (window as any).hydrate());
    await page.waitForTimeout(50);
    expect(
      await replacement.evaluate(() => ({
        captured: (window as any).captured,
        snapshot: (window as any).oldSnapshot,
      })),
    ).toEqual({ captured: false, snapshot: undefined });
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).binding.live)).toBe(false);
  } finally {
    streamInitial = false;
    for (const stream of streams.splice(0)) stream.end();
  }
});

test("copied IDs and nonces from another window cannot consume or reactivate a grant", async ({
  page,
}) => {
  const created = await create(page, true);
  await page.waitForFunction(() => (window as any).snapshotCalls === 1);
  await page.evaluate(({ src, documentId }) => {
    const nonce = new URL(src).hash.slice(1);
    window.postMessage(
      { protocol: 2, documentId, nonce, type: "sandbox-ready" },
      location.origin,
    );
  }, created);
  expect(await page.evaluate(() => (window as any).snapshotCalls)).toBe(1);
  await page.evaluate(() => (window as any).hydrate());
  const frame = await initialized(page, created.documentId);
  await frame.evaluate(
    ({ src, documentId }) =>
      parent.postMessage(
        {
          protocol: 2,
          documentId,
          nonce: new URL(src).hash.slice(1),
          type: "sandbox-ready",
        },
        location.origin,
      ),
    created,
  );
  await page.waitForTimeout(30);
  expect(await frame.evaluate(() => (window as any).grants)).toBe(1);
  expect(await page.evaluate(() => (window as any).snapshotCalls)).toBe(1);
});

test("unexpected document navigation revokes all ports instead of inheriting website identity", async ({
  page,
}) => {
  const created = await create(page);
  const frame = await initialized(page, created.documentId);
  // Keep a port in another live JS context to model an old document forwarding
  // it. Owner revocation must close the broker even if a recipient retains it.
  await page.evaluate(() => {
    addEventListener("message", (event) => {
      if (event.data === "retain-test-port") {
        (window as any).retained = event.ports[0];
        (window as any).retained.start();
      }
    });
  });
  await frame.evaluate(() =>
    parent.postMessage("retain-test-port", location.origin, [
      (window as any).ports.network,
    ]),
  );
  await page.waitForFunction(() => !!(window as any).retained);
  await page.evaluate(() => {
    (window as any).binding.frame.src = "about:blank";
  });
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).binding.live)).toBe(false);
  await page.evaluate(() =>
    (window as any).retained.postMessage({
      protocol: "atlas-network-v2",
      documentId: (window as any).binding.documentId,
      sequence: 1,
      type: "fetch",
      request: { url: "https://website.example", method: "GET", headers: [] },
    }),
  );
  await page.waitForTimeout(30);
  expect(await page.evaluate(() => (window as any).transportCalls)).toBe(0);
});

test("disposing during hydration never grants ports and controlled navigation uses bound channel", async ({
  page,
}) => {
  const pending = await create(page, true);
  await page.waitForFunction(() => (window as any).snapshotCalls === 1);
  await page.evaluate(() => {
    (window as any).binding.dispose();
    (window as any).hydrate();
  });
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).bindingReady)).toBe(false);
  expect(pending.documentId).toMatch(/^doc_/);
  const created = await create(page);
  const frame = await initialized(page, created.documentId);
  await frame.evaluate(() => {
    const { control, documentId } = (window as any).ports;
    control.postMessage({
      protocol: 2,
      documentId,
      type: "navigate",
      url: "/next",
    });
    control.postMessage({
      protocol: 2,
      documentId,
      type: "navigate",
      url: location.origin + "/api/admin",
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).navigation))
    .toEqual(["https://website.example/next"]);
});
