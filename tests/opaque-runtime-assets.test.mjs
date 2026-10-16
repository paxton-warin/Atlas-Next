import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  cp,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { buildOpaqueRuntime } from "../scripts/build-opaque-runtime.mjs";
import { installOpaqueRuntimeAssets } from "../server/opaque-runtime-assets.mjs";
import { createHash } from "node:crypto";
import { OPAQUE_HTTPENGINE_SOURCE_SHA256 } from "../server/runtime-capabilities.mjs";
import { HTTP_ENGINE_ROTATION_SHA256 } from "../scripts/runtime-relay-rotation.mjs";
test("opaque assets are reproducible, pin-checked and hash-allowlisted; dynamic relay CSP is never immutable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "atlas-asset-manifest-"));
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
    await rm(dir, { force: true, recursive: true });
  });
  const one = await buildOpaqueRuntime({ outdir: join(dir, "one") });
  const two = await buildOpaqueRuntime({ outdir: join(dir, "two") });
  assert.deepEqual(one, two);
  assert.equal(Object.keys(one.files).length, 7);
  assert.match(one.dedicatedWorker, /^dedicated-[a-f0-9]{16}\.js$/);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(dir, "one", one.dedicatedWorker)))
      .digest("hex"),
    one.files[one.dedicatedWorker].sha256,
  );
  assert.equal(one.engineSourceSHA256, OPAQUE_HTTPENGINE_SOURCE_SHA256);
  assert.notEqual(one.adaptedEngineSHA256, one.engineSourceSHA256);
  const engine = await readFile(join(dir, "one", one.engine));
  assert.equal(
    createHash("sha256").update(engine).digest("hex"),
    one.adaptedEngineSHA256,
  );
  assert.match(engine.toString(), /atlas_ws_send/);
  assert.equal(
    createHash("sha256")
      .update(await readFile("runtime/public/clients/httpengine-client.js"))
      .digest("hex"),
    HTTP_ENGINE_ROTATION_SHA256,
  );
  let relays = ["https://first.node.example"];
  const assets = installOpaqueRuntimeAssets(app, {
    directory: join(dir, "one"),
    originFor: () => "https://frontend.example",
    relayOrigins: () => relays,
  });
  const worker = await app.inject(assets.workers.relay);
  assert.equal(worker.statusCode, 200);
  assert.equal(worker.headers["cache-control"], "no-store");
  assert.match(
    worker.headers["content-security-policy"],
    /wss:\/\/first.node.example/,
  );
  relays = ["https://second.node.example"];
  const changed = await app.inject(assets.workers.relay);
  assert.equal(changed.headers["cache-control"], "no-store");
  assert.match(
    changed.headers["content-security-policy"],
    /wss:\/\/second.node.example/,
  );
  assert.doesNotMatch(changed.headers["content-security-policy"], /first.node/);
  const doc = await app.inject(assets.bootstrap);
  assert.equal(doc.headers["access-control-allow-origin"], "*");
  assert.equal(
    doc.headers["cache-control"],
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    (await app.inject("/browse/assets/not-present.js")).statusCode,
    404,
  );
  const frame = await app.inject("/browse/frame/manifest_document_0123456789");
  assert.match(
    frame.headers["content-security-policy"],
    /^sandbox allow-scripts;/,
  );
  assert.doesNotMatch(
    frame.headers["content-security-policy"],
    /allow-same-origin/,
  );
  const original = await readFile(join(dir, "two", two.bootstrap));
  await writeFile(
    join(dir, "two", two.bootstrap),
    Buffer.concat([original, Buffer.from("tamper")]),
  );
  const rejected = Fastify();
  t.after(() => rejected.close());
  assert.throws(
    () =>
      installOpaqueRuntimeAssets(rejected, {
        directory: join(dir, "two"),
        originFor: () => "https://frontend.example",
      }),
    /hash mismatch/,
  );
});
test("production-image server tree imports and starts without build-only scripts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-production-shape-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(resolve("server"), join(directory, "server"), { recursive: true });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await symlink(
    resolve("node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const { createApp } = await import(
    pathToFileURL(join(directory, "server/app.mjs")).href
  );
  const app = await createApp({
    dataDir: join(directory, "data"),
    staticDir: "/not-built",
    appOrigin: "http://front.example",
    runtimeOrigin: "http://runtime.example",
  });
  t.after(() => app.close());
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal(
    (await app.inject("/api/config")).json().runtimeProtocols.opaque.activated,
    false,
  );
});
