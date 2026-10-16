import { test, expect, type Frame, type Page } from "@playwright/test";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { installSandboxFramePrototype } from "../server/sandbox-frame.mjs";
import type { StorageChange } from "../runtime/sandbox-vault";

const documentId = "sandbox_document_0123456789";
const nonce = "test_document_binding_0123456789";
const website = "https://save.fixture.example/cookieclicker/";
let origin: string;
const server = Fastify({ logger: false });
const privateRequests: { origin?: string; credentialed: boolean }[] = [];

test.beforeAll(async () => {
  installSandboxFramePrototype(server);
  for (const name of ["sandbox-vault", "sandbox-broker"]) {
    const source = readFileSync(
      new URL(`../runtime/${name}.ts`, import.meta.url),
      "utf8",
    );
    const compiled = ts
      .transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      })
      .outputText.replaceAll("./sandbox-vault.ts", "./sandbox-vault.js");
    server.get(`/${name}.js`, (_request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .type("application/javascript")
        .send(compiled),
    );
  }
  const shell = (_request: unknown, reply: any) =>
    reply
      .header("Cache-Control", "no-store")
      .type("text/html")
      .send("<!doctype html><title>Trusted sandbox test controller</title>");
  server.get("/", shell);
  server.get("/controller-a", shell);
  server.get("/controller-b", shell);
  server.get("/frontend-private", (request, reply) => {
    const credentialed = (request.headers.cookie || "").includes(
      "frontend_cookie=not-for-websites",
    );
    privateRequests.push({ origin: request.headers.origin, credentialed });
    if (request.headers.origin && request.headers.origin !== origin)
      return reply.code(403).send({ error: "Origin mismatch" });
    if (!credentialed)
      return reply.code(401).send({ error: "Frontend credentials required" });
    return { frontendOnly: "credential-bearing fixture response" };
  });
  origin = await server.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => server.close());

async function initializeVault(page: Page, limit?: number) {
  await page.evaluate(
    async ({ limit }) => {
      const { SandboxVault } = await import("/sandbox-vault.js");
      (window as any).vault = new SandboxVault(indexedDB, limit);
    },
    { limit },
  );
}

async function snapshot(page: Page, logicalOrigin = website) {
  return page.evaluate(
    (value) => (window as any).vault.snapshot(value),
    logicalOrigin,
  );
}

async function write(
  page: Page,
  change: StorageChange,
  logicalOrigin = website,
) {
  return page.evaluate(
    ({ logicalOrigin, change }) =>
      (window as any).vault.write(logicalOrigin, change),
    { logicalOrigin, change },
  );
}

async function appendSandbox(page: Page): Promise<Frame> {
  await page.evaluate(
    ({ documentId, nonce }) =>
      new Promise<void>((resolve) => {
        const frame = document.createElement("iframe");
        frame.id = "sandbox";
        frame.src = `/browse/frame/${documentId}#${nonce}`;
        frame.onload = () => resolve();
        document.body.append(frame);
      }),
    { documentId, nonce },
  );
  return page.frames().find((frame) => frame.url().includes(documentId))!;
}

async function nativeBoundary(frame: Frame) {
  return frame.evaluate(async () => {
    const read = (callback: () => unknown) => {
      try {
        return callback();
      } catch (error) {
        return (error as Error).name;
      }
    };
    return {
      urlOrigin: location.origin,
      effectiveOrigin: window.origin,
      parentDOM: read(() => parent.document.title),
      storage: read(() => localStorage.getItem("frontend-secret")),
      indexedDB: read(() => indexedDB.open("frontend-only")),
      cookies: read(() => document.cookie),
      worker: read(() => navigator.serviceWorker.controller),
      workerRegistration: await (async () => {
        try {
          await navigator.serviceWorker.register("/sandbox-test-sw.js");
          return "unexpected_registration";
        } catch (error) {
          return (error as Error).name;
        }
      })(),
    };
  });
}

async function bindDocument(page: Page, frame: Frame, pauseWrites = false) {
  await frame.evaluate(() => {
    (window as any).capabilityReplies = [];
    addEventListener("message", (event) => {
      if (
        event.source === parent &&
        event.data?.type === "bind" &&
        event.ports.length === 1
      ) {
        const port = event.ports[0];
        (window as any).capabilityPort = port;
        port.addEventListener("message", ({ data }) => {
          (window as any).capabilityReplies.push(data);
        });
        port.start();
      }
    });
  });
  await page.evaluate(
    async ({ documentId, nonce, website, pauseWrites }) => {
      const { bindSandboxDocument } = await import("/sandbox-broker.js");
      const channel = new MessageChannel();
      const vault = (window as any).vault;
      const capabilityVault = pauseWrites
        ? {
            snapshot: (value: string) => vault.snapshot(value),
            async write(value: string, change: StorageChange) {
              (window as any).writeWaiting = true;
              // A busy broker may not reach its native transaction before unload.
              // Deliberately hold that boundary to make the failure reproducible.
              await new Promise<void>((resolve) => {
                (window as any).releasePendingWrite = resolve;
              });
              return vault.write(value, change);
            },
          }
        : vault;
      await new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
          if (event.data?.type !== "bound") return;
          channel.port1.onmessage = null;
          (window as any).binding = bindSandboxDocument({
            documentId,
            website,
            frontendOrigin: location.origin,
            port: channel.port1,
            vault: capabilityVault,
          });
          resolve();
        };
        channel.port1.start();
        document
          .querySelector<HTMLIFrameElement>("#sandbox")!
          .contentWindow!.postMessage(
            { protocol: 2, type: "bind", documentId, nonce },
            "*",
            [channel.port2],
          );
      });
    },
    { documentId, nonce, website, pauseWrites },
  );
}

async function request(frame: Frame, payload: Record<string, unknown>) {
  const before = await frame.evaluate(
    () => (window as any).capabilityReplies.length,
  );
  await frame.evaluate(
    ({ payload, documentId }) =>
      (window as any).capabilityPort.postMessage({
        protocol: 2,
        documentId,
        ...payload,
      }),
    { payload, documentId },
  );
  await expect
    .poll(() => frame.evaluate(() => (window as any).capabilityReplies.length))
    .toBe(before + 1);
  return frame.evaluate(
    (index) => (window as any).capabilityReplies[index],
    before,
  );
}

test("same-frontend frame URLs retain an opaque browser security boundary, including direct visits", async ({
  page,
  context,
}) => {
  privateRequests.length = 0;
  await page.goto(origin);
  await page.evaluate(() => {
    localStorage.setItem("frontend-secret", "not-for-websites");
    document.cookie =
      "frontend_cookie=not-for-websites; Path=/; SameSite=Strict";
    (window as any).readyMessages = [];
    addEventListener("message", (event) => {
      if (event.data?.type === "sandbox-ready")
        (window as any).readyMessages.push({
          origin: event.origin,
          documentId: event.data.documentId,
        });
    });
  });
  expect(
    await page.evaluate(async () =>
      fetch("/frontend-private", { credentials: "include" }).then((response) =>
        response.json(),
      ),
    ),
  ).toEqual({ frontendOnly: "credential-bearing fixture response" });
  expect(privateRequests).toEqual([{ credentialed: true, origin: undefined }]);
  const frame = await appendSandbox(page);
  expect(new URL(frame.url()).origin).toBe(origin);
  expect(await page.locator("#sandbox").getAttribute("sandbox")).toBeNull();
  expect(await nativeBoundary(frame)).toEqual({
    urlOrigin: origin,
    effectiveOrigin: "null",
    parentDOM: "SecurityError",
    storage: "SecurityError",
    indexedDB: "SecurityError",
    cookies: "SecurityError",
    worker: "SecurityError",
    workerRegistration: "SecurityError",
  });
  const privateFetch = await frame.evaluate(async () => {
    try {
      await fetch("/frontend-private", { credentials: "include" });
      return "unexpected_frontend_response";
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(privateFetch).toBe("TypeError");
  expect(privateRequests).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).readyMessages)).toEqual([
    { origin: "null", documentId },
  ]);
  const direct = await context.newPage();
  const response = await direct.goto(`${origin}/browse/frame/${documentId}`);
  expect(response!.headers()["content-security-policy"]).toMatch(
    /^sandbox allow-scripts;/,
  );
  expect(response!.headers()["content-security-policy"]).not.toContain(
    "allow-same-origin",
  );
  const directBoundary = await nativeBoundary(direct.mainFrame());
  expect(directBoundary).toMatchObject({
    urlOrigin: origin,
    effectiveOrigin: "null",
    storage: "SecurityError",
    indexedDB: "SecurityError",
    cookies: "SecurityError",
    worker: "SecurityError",
    workerRegistration: "SecurityError",
  });
  expect(
    await page.evaluate(() => localStorage.getItem("frontend-secret")),
  ).toBe("not-for-websites");
});

test("the browser-local vault follows the frontend and website origin, not a node-specific controller URL", async ({
  page,
  context,
}) => {
  await page.goto(origin + "/controller-a");
  await initializeVault(page);
  expect(
    await write(page, { op: "set", key: "save", value: "777 cookies" }),
  ).toEqual({ revision: 1, entries: [["save", "777 cookies"]] });
  for (const other of [
    "https://other.fixture.example/",
    "http://save.fixture.example/",
    "https://save.fixture.example:444/",
  ])
    expect(await snapshot(page, other)).toEqual({ revision: 0, entries: [] });
  const anotherController = await context.newPage();
  await anotherController.goto(origin + "/controller-b");
  await initializeVault(anotherController);
  expect(
    await snapshot(anotherController, "https://save.fixture.example/new-path"),
  ).toEqual({ revision: 1, entries: [["save", "777 cookies"]] });
  // These tests exercise local persistence, not a running proxy or relay switch.
  console.log(
    "SANDBOX_VAULT_SCOPE=frontend-origin+website-origin; RELAY_TRAFFIC_TESTED=false",
  );
});

test("native vault transactions serialize competing controller tabs without lost writes", async ({
  page,
  context,
}) => {
  await page.goto(origin);
  await initializeVault(page);
  const second = await context.newPage();
  await second.goto(origin);
  await initializeVault(second);
  await Promise.all(
    [page, second].flatMap((tab, source) =>
      Array.from({ length: 16 }, (_, index) =>
        write(tab, {
          op: "set",
          key: `${source}:${index}`,
          value: String(index),
        }),
      ),
    ),
  );
  const result = await snapshot(page);
  expect(result.revision).toBe(32);
  expect(result.entries).toHaveLength(32);
  expect(
    new Set(result.entries.map(([key]: [string, string]) => key)).size,
  ).toBe(32);
  expect(await snapshot(second)).toEqual(result);
});

test("quota rejection aborts the whole native transaction without changing persisted state", async ({
  page,
}) => {
  await page.goto(origin);
  await initializeVault(page, 64);
  const before = await write(page, {
    op: "set",
    key: "save",
    value: "retained",
  });
  const failure = await page.evaluate(async (website) => {
    try {
      await (window as any).vault.write(website, {
        op: "set",
        key: "oversized",
        value: "x".repeat(100),
      });
      return "unexpected_commit";
    } catch (error) {
      return (error as Error).name;
    }
  }, website);
  expect(failure).toBe("QuotaExceededError");
  expect(await snapshot(page)).toEqual(before);
  await page.reload();
  await initializeVault(page, 64);
  expect(await snapshot(page)).toEqual(before);
});

test("document MessagePort capabilities reject origin, document, sequence and operation spoofing", async ({
  page,
}) => {
  await page.goto(origin);
  await initializeVault(page);
  await write(
    page,
    { op: "set", key: "peer-secret", value: "another website's data" },
    "https://victim.fixture.example",
  );
  const privateRequestsBefore = privateRequests.length;
  const frame = await appendSandbox(page);
  await bindDocument(page, frame);
  expect(await request(frame, { type: "snapshot", sequence: 1 })).toMatchObject(
    {
      type: "ack",
      sequence: 1,
      snapshot: { revision: 0, entries: [] },
    },
  );
  for (const spoof of [
    { type: "snapshot", sequence: 2, origin: "https://victim.fixture.example" },
    { type: "snapshot", sequence: 2, documentId: "other_document_012345" },
    { type: "snapshot", sequence: 999 },
    { type: "fetch", sequence: 2, url: origin + "/frontend-private" },
  ])
    expect(await request(frame, spoof)).toMatchObject({
      type: "error",
      code: "invalid_capability_message",
    });
  expect(
    await request(frame, {
      type: "mutate",
      sequence: 2,
      change: { op: "set", key: "save", value: "authorized" },
    }),
  ).toMatchObject({ type: "ack", sequence: 2, snapshot: { revision: 1 } });
  expect(
    await request(frame, {
      type: "mutate",
      sequence: 3,
      change: { op: "clear", origin: "https://victim.fixture.example" },
    }),
  ).toMatchObject({
    type: "error",
    sequence: 3,
    code: "invalid_storage_operation",
  });
  expect(await request(frame, { type: "snapshot", sequence: 4 })).toMatchObject(
    {
      type: "ack",
      sequence: 4,
      snapshot: { revision: 1, entries: [["save", "authorized"]] },
    },
  );
  // Window-wide messages carry no capability; only the granted port is bound.
  await frame.evaluate(
    ({ documentId }) => {
      parent.postMessage(
        {
          protocol: 2,
          documentId,
          type: "mutate",
          sequence: 5,
          change: { op: "clear" },
        },
        "*",
      );
    },
    { documentId },
  );
  await page.evaluate(() => (window as any).binding.flush());
  expect(await snapshot(page)).toEqual({
    revision: 1,
    entries: [["save", "authorized"]],
  });
  expect(await snapshot(page, "https://victim.fixture.example")).toEqual({
    revision: 1,
    entries: [["peer-secret", "another website's data"]],
  });
  expect(privateRequests).toHaveLength(privateRequestsBefore);
  const frontendBinding = await page.evaluate(async () => {
    const { bindSandboxDocument } = await import("/sandbox-broker.js");
    const channel = new MessageChannel();
    try {
      bindSandboxDocument({
        documentId: "forbidden_frontend_0123",
        website: location.origin,
        frontendOrigin: location.origin,
        port: channel.port1,
        vault: (window as any).vault,
      });
      return "unexpected_binding";
    } catch (error) {
      return (error as Error).name;
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
  expect(frontendBinding).toBe("TypeError");
  await page.evaluate(() => (window as any).binding.dispose());
});

test("acknowledged capability writes survive a whole-controller browser reload", async ({
  page,
}) => {
  await page.goto(origin);
  await initializeVault(page);
  const frame = await appendSandbox(page);
  await bindDocument(page, frame);
  const committed = await request(frame, {
    type: "mutate",
    sequence: 1,
    change: { op: "set", key: "save", value: "committed cookies" },
  });
  expect(committed).toMatchObject({ type: "ack", sequence: 1 });
  await page.reload();
  await initializeVault(page);
  expect(await snapshot(page)).toEqual(committed.snapshot);
});

test("FEASIBILITY CONSTRAINT: a synchronous async-mirror return cannot promise persistence before browser reload", async ({
  page,
}) => {
  await page.goto(origin);
  await initializeVault(page);
  const frame = await appendSandbox(page);
  await bindDocument(page, frame, true);
  const beforeReload = await frame.evaluate(
    ({ documentId }) => {
      const entries = new Map<string, string>();
      const mirror = {
        setItem(key: string, value: string) {
          entries.set(key, value);
          (window as any).capabilityPort.postMessage({
            protocol: 2,
            documentId,
            type: "mutate",
            sequence: 1,
            change: { op: "set", key, value },
          });
        },
        getItem(key: string) {
          return entries.get(key) ?? null;
        },
      };
      return {
        returnValue: String(mirror.setItem("save", "unacknowledged cookies")),
        readableInMirror: mirror.getItem("save"),
      };
    },
    { documentId },
  );
  expect(beforeReload).toEqual({
    returnValue: "undefined",
    readableInMirror: "unacknowledged cookies",
  });
  await page.waitForFunction(() => (window as any).writeWaiting === true);
  expect(await snapshot(page)).toEqual({ revision: 0, entries: [] });
  expect(await frame.evaluate(() => (window as any).capabilityReplies)).toEqual(
    [],
  );
  await page.reload();
  await initializeVault(page);
  expect(await snapshot(page)).toEqual({ revision: 0, entries: [] });
  console.log(
    JSON.stringify({
      kind: "FEASIBILITY_CONSTRAINT",
      runtimeQualified: false,
      condition: "reload before broker commit acknowledgement",
      mirrorReadBeforeReload: "unacknowledged cookies",
      durableReadAfterReload: null,
      nativeLocalStorageParity: false,
    }),
  );
});
