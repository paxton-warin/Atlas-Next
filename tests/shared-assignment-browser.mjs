/** Actual coordinator API -> actual default createSandboxRelay -> unchanged
 * HttpEngine in trusted workers -> real paired Wisp nodes. Probe/lifecycle only;
 * this does not claim public-site or full opaque document compatibility. */
import assert from "node:assert/strict";
import {adaptRelayCredentialRotation} from "../scripts/runtime-relay-rotation.mjs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createApp } from "../server/app.mjs";
import { createNodeService } from "../server/node-service.mjs";
import { token, digest } from "../server/store.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const directory = await mkdtemp(join(tmpdir(), "atlas-assignment-browser-"));
const module = await build({
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  stdin: { contents: "export {createFrontendAssignmentCoordinator} from './runtime/frontend-assignment.ts';export {acquireSharedAssignmentCoordinator} from './runtime/shared-assignment-coordinator.ts'", resolveDir: process.cwd() },
});
const worker = await build({
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  define: {
    __OPAQUE_HTTPENGINE_ASSET__: JSON.stringify("/qualification-httpengine.js"),
  },
  entryPoints: ["runtime/sandbox-relay-worker.ts"],
});
const engine = await readFile("runtime/public/clients/httpengine-client.js");
const pin = JSON.parse(await readFile("scripts/runtime-fork.json", "utf8"));
const originalEngine=await readFile(join(pin.directory,'app/vendor/httpengine-client.js'));
assert.equal(createHash('sha256').update(originalEngine).digest('hex'),pin.assets['httpengine-client.js'].sha256);
assert.equal(createHash('sha256').update(engine).digest('hex'),createHash('sha256').update(adaptRelayCredentialRotation(originalEngine)).digest('hex'));

const app = await createApp({
  dataDir: join(directory, "data"),
  staticDir: "/not-built",
  appOrigin: "http://127.0.0.1:0",
  runtimeOrigin: "https://runtime.invalid",
  localRelayMode: "frontend",
  opaqueRuntimeEnabled: true,
});
const nodes = [],
  upgrades = [],
  commits = [],
  errors = [];
let browser;
app.get("/", (_req, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><title>Trusted coordinator</title><main id="unchanged">owner survives credential rotation</main>',
    ),
);
app.get("/qualification-coordinator.js", (_req, reply) =>
  reply.type("application/javascript").send(module.outputFiles[0].contents),
);
app.get("/qualification-relay-worker.js", (_req, reply) =>
  reply
    .header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${nodes.map((n) => "ws://127.0.0.1:" + n.service.server.address().port).join(" ")}`,
    )
    .header("Cache-Control", "no-store")
    .type("application/javascript")
    .send(worker.outputFiles[0].contents),
);
app.get("/qualification-httpengine.js", (_req, reply) =>
  reply.type("application/javascript").send(engine),
);
app.get("/favicon.ico", (_req, reply) => reply.code(204).send());
app.addHook("preHandler", async (req) => {
  if (req.url === "/api/browse/controller/commit")
    commits.push({ candidate: req.body.session, time: Date.now() });
});
await app.listen({ host: "127.0.0.1", port: 0 });
const origin = "http://127.0.0.1:" + app.server.address().port;
try {
  for (let i = 0; i < 2; i++) {
    const service = await createNodeService({
      fixture: true,
      pairing: { verify: () => true, save: () => {} },
    });
    await service.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = "http://127.0.0.1:" + service.server.address().port;
    const attached = await app.nodePool.attach(
      { endpoint, name: "Assignment node " + i, code: "fixture" },
      origin,
    );
    service.server.on("upgrade", (req) => {
      if (req.url.startsWith("/relay/"))
        upgrades.push({ node: attached.id, time: Date.now() });
    });
    nodes.push({ id: attached.id, endpoint, service });
  }
  app.nodePool.update("local", { state: "disabled", weight: 1 });
  const administrator = token(),
    csrf = token(),
    now = Date.now();
  app.store.db
    .prepare("INSERT INTO sessions(hash,csrf,created,seen) VALUES(?,?,?,?)")
    .run(digest(administrator), csrf, now, now);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "atlas-admin",
      value: administrator,
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  // Lose the first successful allocation body before its raw capability is
  // visible. Only the signed bootstrap intent is durable in the frontend.
  const initialLost = await page.evaluate(async () => {
    const { createFrontendAssignmentCoordinator } = await import(
      "/qualification-coordinator.js"
    );
    const native = fetch.bind(window);
    let drop = true;
    const owner = createFrontendAssignmentCoordinator({
      workerURL: "/qualification-relay-worker.js",
      events: false,
      fetch: async (...args) => {
        const response = await native(...args);
        if (
          String(args[0]).endsWith("/session") &&
          JSON.parse(args[1].body).intent === "new" &&
          drop
        ) {
          drop = false;
          throw new TypeError("fixture lost initial allocation reply");
        }
        return response;
      },
    });
    try {
      await owner.start();
      throw Error("initial loss not reached");
    } catch (error) {
      if (!error.message.includes("fixture lost initial")) throw error;
    }
    const record = JSON.parse(
      localStorage.getItem("atlas.frontendAssignment.v2"),
    );
    owner.stop();
    return { hasInitial: !!record.initial?.requestId, active: record.active };
  });
  assert.equal(initialLost.hasInitial, true);
  assert.equal(initialLost.active, null);
  const initialRows = app.store.db
    .prepare("SELECT hash,node FROM browse_leases")
    .all();
  assert.equal(initialRows.length, 1);
  assert.equal(upgrades.length, 0);
  await page.reload();
  const first = await page.evaluate(async () => {
    const { createFrontendAssignmentCoordinator } = await import(
      "/qualification-coordinator.js"
    );
    window.createCoordinator = createFrontendAssignmentCoordinator;
    window.changes = [];
    window.ownerMarker = document.getElementById("unchanged");
    window.coordinator = createFrontendAssignmentCoordinator({
      workerURL: "/qualification-relay-worker.js",
      events: false,
      onAssignment: (e) =>
        window.changes.push({
          reason: e.reason,
          identityChanged: e.identityChanged,
        }),
    });
    const lease = await window.coordinator.start();
    return {
      node: lease.node.id,
      session: lease.session,
      hash: lease.sessionHash,
    };
  });
  assert.equal(first.hash, initialRows[0].hash);
  assert.equal(first.node, initialRows[0].node);
  assert.equal(
    app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,
    1,
  );
  assert.ok(upgrades.some((x) => x.node === first.node));
  const renewed = await page.evaluate(async () => {
    const lease = await coordinator.check({ authoritative: true });
    return {
      node: lease.node.id,
      session: lease.session,
      marker: ownerMarker === document.getElementById("unchanged"),
      change: changes.at(-1),
    };
  });
  assert.equal(renewed.node, first.node);
  assert.equal(renewed.session, first.session);
  assert.equal(renewed.marker, true);
  assert.equal(renewed.change.identityChanged, false);
  const target = nodes.find((n) => n.id !== first.node);
  const upgradeStart = upgrades.length;
  const selected = await page.evaluate(
    async ({ node, csrf }) => {
      const lease = await coordinator.selectNode(node, csrf);
      return {
        node: lease.node.id,
        session: lease.session,
        hash: lease.sessionHash,
        transport: coordinator.transport.assignment.sessionHash,
        marker: ownerMarker === document.getElementById("unchanged"),
      };
    },
    { node: target.id, csrf },
  );
  assert.equal(selected.node, target.id);
  assert.equal(selected.transport, selected.hash);
  assert.equal(selected.marker, true);
  assert.notEqual(selected.session, first.session);
  assert.ok(upgrades.slice(upgradeStart).some((x) => x.node === target.id));
  assert.ok(commits.some((x) => x.candidate === selected.session));
  assert.equal(
    app.store.db
      .prepare("SELECT reason FROM browse_lease_tombstones WHERE hash=?")
      .get(first.hash).reason,
    "revoked",
  );
  // Deliberately lose only the successful COMMIT response. The durable journal
  // must let a fresh trusted frontend recover the real committed candidate.
  const other = nodes.find((n) => n.id !== selected.node);
  const ambiguous = await page.evaluate(
    async ({ node, csrf }) => {
      coordinator.stop();
      const native = fetch.bind(window);
      let drop = true;
      window.coordinator = createCoordinator({
        workerURL: "/qualification-relay-worker.js",
        events: false,
        fetch: async (...args) => {
          const response = await native(...args);
          if (String(args[0]).endsWith("/commit") && drop) {
            drop = false;
            throw new TypeError("fixture dropped committed response");
          }
          return response;
        },
      });
      await coordinator.start();
      try {
        await coordinator.selectNode(node, csrf);
        throw Error("drop not reached");
      } catch (error) {
        if (!error.message.includes("fixture dropped")) throw error;
      }
      const record = JSON.parse(
        localStorage.getItem("atlas.frontendAssignment.v2"),
      );
      const result = {
        candidate: record.pending.candidate.session,
        node: record.pending.candidate.node.id,
        stage: record.pending.stage,
      };
      coordinator.stop();
      return result;
    },
    { node: other.id, csrf },
  );
  assert.equal(ambiguous.node, other.id);
  assert.equal(ambiguous.stage, "commit-intent");
  await page.reload();
  const recovered = await page.evaluate(async () => {
    const { createFrontendAssignmentCoordinator } = await import(
      "/qualification-coordinator.js"
    );
    window.coordinator = createFrontendAssignmentCoordinator({
      workerURL: "/qualification-relay-worker.js",
      events: false,
    });
    const lease = await coordinator.start();
    return {
      session: lease.session,
      node: lease.node.id,
      pending: JSON.parse(localStorage.getItem("atlas.frontendAssignment.v2"))
        .pending,
    };
  });
  assert.equal(recovered.session, ambiguous.candidate);
  assert.equal(recovered.node, other.id);
  assert.equal(recovered.pending, null);
  await page.evaluate(() => coordinator.stop());
  const rowsBeforeShared = app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n;
  const shared = await page.evaluate(async () => {
    const {acquireSharedAssignmentCoordinator} = await import('/qualification-coordinator.js');
    const scope = {}, events = [[], []], options = {workerURL:'/qualification-relay-worker.js',events:false,channelName:'atlas-profile-lifecycle-proof'};window.sharedScope=scope;window.sharedOptions=options;window.peerMessages=0;window.assignmentPeer=new BroadcastChannel(options.channelName);assignmentPeer.onmessage=()=>peerMessages++;
    window.sharedEvents = events;
    window.sharedLeases = [0,1].map(i=>acquireSharedAssignmentCoordinator(window,scope,{...options,onAssignment:event=>events[i].push({identityChanged:event.identityChanged,node:event.assignment.node.id,reason:event.reason})}));
    await Promise.all(sharedLeases.map(l=>l.start()));
    return {sameOwner:sharedLeases[0].current.sessionHash===sharedLeases[1].current.sessionHash,events:events.map(e=>e.length)};
  });
  assert.equal(shared.sameOwner,true);assert.deepEqual(shared.events,[1,1]);
  assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM browse_leases").get().n,rowsBeforeShared);
  const devtools = await browser.newBrowserCDPSession();await page.waitForTimeout(100);
  const countWorkers = async()=> (await devtools.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').length;
  assert.equal(await countWorkers(),1);
  const sharedTarget = nodes.find(n=>n.id!==recovered.node);
  const together = await page.evaluate(async({node,csrf})=>{await sharedLeases[0].selectNode(node,csrf);return {nodes:sharedLeases.map(l=>l.current.node.id),sameTransport:sharedLeases.every(l=>l.current.sessionHash===l.transport.assignment.sessionHash),events:sharedEvents.map(e=>e.at(-1)),marker:document.getElementById('unchanged')?.textContent}},{node:sharedTarget.id,csrf});
  assert.deepEqual(together.nodes,[sharedTarget.id,sharedTarget.id]);assert.equal(together.sameTransport,true);assert.ok(together.events.every(e=>e.identityChanged&&e.reason==='selection'));
  await page.evaluate(async()=>{sharedLeases[0].stop();await sharedLeases[1].check({authoritative:true});});await page.waitForTimeout(100);assert.equal(await countWorkers(),1);
  await page.evaluate(()=>sharedLeases[1].stop());await page.waitForTimeout(100);assert.equal(await countWorkers(),0);
  const reopened=await page.evaluate(async()=>{const before=peerMessages;const{acquireSharedAssignmentCoordinator}=await import('/qualification-coordinator.js');const next=acquireSharedAssignmentCoordinator(window,sharedScope,sharedOptions);await next.start();await new Promise(r=>setTimeout(r,100));const result={before,after:peerMessages,node:next.current.node.id};next.stop();assignmentPeer.close();return result;});assert.ok(reopened.after>reopened.before,'Reopened final tab gets a fresh functional profile BroadcastChannel');
  assert.deepEqual(errors, []);
  const receipt = {
    result: "frontend_assignment_real_wisp_lifecycle_verified",
    nodeCount: 2,
    sharedCoordinator: { subscribers:2, nativeRelayWorkers:1, noExtraAllocationOnConcurrentStartup:true, selectionBroadcastToBoth:true, firstCloseRetainsWorker:true, lastCloseRetiresWorker:true,reopenRetainsWorkingProfileChannel:true },
    realWispProbes: upgrades.length,
    renewSameOwner: true,
    selectionProbeBeforeCommit: true,
    ambiguousCommitReload: true,
    ambiguousInitialAllocationReload: true,
    initialAllocationCount: 1,
    frontendOwnerRetained: true,
    transport:
      "real unchanged HttpEngine dedicated workers and paired Wisp nodes; no website payload requested",
  };
  await writeFile(
    "evidence/client-lag-followup-20261022/TRUSTED_SHARED_COORDINATOR_BROWSER.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
  await page.evaluate(() => coordinator.stop());
} finally {
  await browser?.close();
  await Promise.all(nodes.map((n) => n.service.close()));
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
