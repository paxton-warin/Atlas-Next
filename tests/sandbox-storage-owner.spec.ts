import { test, expect, type Page } from "@playwright/test";
import Fastify from "fastify";
import { compileRuntimeFixture } from "./runtime-fixture.mjs";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
import { installSandboxStorageRendezvous } from "../server/sandbox-storage-rendezvous.mjs";

const server = Fastify({ logger: false });
let origin: string;
const wire: string[] = [];
test.beforeAll(async () => {
  const compiled = compileRuntimeFixture([
    "sandbox-controller",
    // The transpile-only fixture must serve the controller's static policy
    // closure as real modules, exactly as the built runtime resolves it.
    "original-document-policy",
    "original-document-plan",
    "page-controls-protocol",
    "sandbox-storage-owner",
    "sandbox-storage-worker",
    "sandbox-local-storage",
    "sandbox-vault",
    "sandbox-broker",
    "sandbox-network",
    "sandbox-idb",
  ]);
  for (const [name,text] of compiled) {
    server.get(`/${name}.js`, (_request, reply) =>
      reply.type("application/javascript").send(text),
    );
  }
  server.get("/", (_request, reply) =>
    reply
      .type("text/html")
      .send("<!doctype html><title>Trusted controller</title><main></main>"),
  );
  installSandboxStorageRendezvous(server, {
    originFor: (req: any) => "http://" + req.headers.host,
    authorizeOwner: (req: any) =>
      req.headers["x-test-owner"] === "valid" ? { session: "fixture" } : null,
    validateOwner: () => true,
    timeoutMs: 1000,
  });
  server.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/browse/storage/commit/"))
      wire.push(
        JSON.stringify({
          body: req.body,
          cookie: req.headers.cookie || "",
          auth: req.headers.authorization || "",
        }),
      );
  });
  const facade = compiled
    .get("sandbox-local-storage")!
    .replaceAll(/^export /gm, "");
  installSandboxFramePrototype(server, {
    capabilities: true,
    storageEndpointOrigin: () => origin,
    trustedBootstrap:
      facade +
      `
    addEventListener('atlas:document-capabilities',event=>{
      const grant=event.detail;
      grant.control.onmessage=async event=>{
        if(event.data.type!=='initialize')return;
        try{window.storage=await createSandboxStorageFacades({documentId:grant.documentId,endpoint:event.data.storageEndpoint,port:grant.storage});window.storageReady=true;}
        catch(error){window.storageError=error.name+':'+error.message;}
      };grant.control.start();
    });
  `,
  });
  origin = await server.listen({ host: "127.0.0.1", port: 0 });
});
test.afterAll(() => server.close());

async function initialize(
  page: Page,
  website = "https://cookie.fixture.example/cookieclicker/",
  sessionId = "stable_browser_tab_0123456",
) {
  await page.goto(origin);
  const id = await page.evaluate(
    async ({ website, sessionId }) => {
      const { createSandboxStorageOwner } = await import(
        "/sandbox-storage-owner.js"
      );
      const { createSandboxDocument } = await import("/sandbox-controller.js");
      const storage = await createSandboxStorageOwner({
        workerURL: "/sandbox-storage-worker.js",
        registrationHeaders: () => ({ "x-test-owner": "valid" }),
      });
      const binding = createSandboxDocument({
        website,
        container: document.querySelector("main")!,
        storageProvider: storage,
        sessionId,
        factory: indexedDB,
        fetch: async () => {
          throw Error("unused fixture network");
        },
      });
      (window as any).owner = storage;
      (window as any).binding = binding;
      await binding.ready;
      return binding.documentId;
    },
    { website, sessionId },
  );
  const frame = page.frames().find((value) => value.url().includes(id))!;
  await frame.waitForFunction(
    () => (window as any).storageReady || (window as any).storageError,
  );
  expect(
    await frame.evaluate(() => (window as any).storageError),
  ).toBeUndefined();
  return frame;
}

test("real owner/controller/worker integration commits opaque manual saves before immediate whole-shell reload", async ({
  page,
}) => {
  wire.length = 0;
  let frame = await initialize(page);
  expect(await frame.evaluate(() => window.origin)).toBe("null");
  expect(new URL(frame.url()).origin).toBe(origin);
  expect(
    await frame.evaluate(() => {
      const store = (window as any).storage.localStorage;
      const result = store.setItem(
        "CookieClickerGame",
        "manual save committed in frontend database",
      );
      return {
        result: result === undefined,
        value: store.getItem("CookieClickerGame"),
      };
    }),
  ).toEqual({
    result: true,
    value: "manual save committed in frontend database",
  });
  // No flush, sleep, MessagePort acknowledgement or parent task before reload.
  await page.reload();
  frame = await initialize(page);
  expect(
    await frame.evaluate(() =>
      (window as any).storage.localStorage.getItem("CookieClickerGame"),
    ),
  ).toBe("manual save committed in frontend database");
  expect(wire).toHaveLength(1);
  expect(wire[0]).not.toContain("CookieClickerGame");
  expect(wire[0]).not.toContain("manual save");
  expect(JSON.parse(wire[0])).toEqual({
    body: '{"sequence":1}',
    cookie: "",
    auth: "",
  });
});

test("website namespaces and session namespaces stay separate while committed local data survives a new owner", async ({
  page,
}) => {
  let frame = await initialize(page);
  await frame.evaluate(() => {
    (window as any).storage.localStorage.setItem("save", "site-a");
    (window as any).storage.sessionStorage.setItem("tab", "tab-a");
  });
  frame = await initialize(
    page,
    "https://other.fixture.example/",
    "other_browser_tab_0123456",
  );
  expect(
    await frame.evaluate(() => ({
      local: (window as any).storage.localStorage.getItem("save"),
      session: (window as any).storage.sessionStorage.getItem("tab"),
    })),
  ).toEqual({ local: null, session: null });
  frame = await initialize(
    page,
    "https://cookie.fixture.example/",
    "other_browser_tab_0123456",
  );
  expect(
    await frame.evaluate(() => ({
      local: (window as any).storage.localStorage.getItem("save"),
      session: (window as any).storage.sessionStorage.getItem("tab"),
    })),
  ).toEqual({ local: "site-a", session: null });
  frame = await initialize(page);
  expect(
    await frame.evaluate(() =>
      (window as any).storage.sessionStorage.getItem("tab"),
    ),
  ).toBe("tab-a");
});
