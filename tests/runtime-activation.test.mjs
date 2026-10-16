import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opaqueRuntimeSettings } from "../server/runtime-activation.mjs";
import { createApp } from "../server/app.mjs";
import { buildOpaqueRuntime } from "../scripts/build-opaque-runtime.mjs";
test("release mode defaults held; deployment requires an explicit combined switch and frontend relay mode", () => {
  assert.deepEqual(opaqueRuntimeSettings({}), {
    opaqueRuntimeEnabled: false,
    opaqueRuntimeActivated: false,
    opaqueAssetsDir: null,
  });
  assert.deepEqual(
    opaqueRuntimeSettings(
      { ATLAS_BROWSER_RUNTIME: "opaque-v2", LOCAL_RELAY_MODE: "frontend" },
      "/release",
    ),
    {
      opaqueRuntimeEnabled: true,
      opaqueRuntimeActivated: true,
      opaqueAssetsDir: "/release/dist/opaque-runtime",
    },
  );
  assert.equal(
    opaqueRuntimeSettings({
      ATLAS_BROWSER_RUNTIME: "opaque-v2",
      LOCAL_RELAY_MODE: "frontend",
      OPAQUE_ASSETS_DIR: "/verified/assets",
    }).opaqueAssetsDir,
    "/verified/assets",
  );
  assert.throws(() =>
    opaqueRuntimeSettings({ ATLAS_BROWSER_RUNTIME: "opque-v2" }),
  );
  assert.throws(() =>
    opaqueRuntimeSettings({
      ATLAS_BROWSER_RUNTIME: "opaque-v2",
      LOCAL_RELAY_MODE: "isolated",
    }),
  );
});
test("activation rejects partial/misconfigured combinations before opening databases or routes", async () => {
  for (const patch of [
    { opaqueRuntimeEnabled: false },
    { opaqueAssetsDir: null },
    { localRelayMode: "isolated" },
    { appOrigin: "http://front.test" },
  ])
    await assert.rejects(
      createApp({
        dataDir: "/never-created-runtime-activation",
        appOrigin: "https://front.test",
        runtimeOrigin: "https://runtime.test",
        localRelayMode: "frontend",
        opaqueRuntimeEnabled: true,
        opaqueRuntimeActivated: true,
        opaqueAssetsDir: "/not-read",
        ...patch,
      }),
      /Combined runtime activation requires/,
    );
});
test("verified asset deployment alone stays held; explicit activation is advertised by the real config API without response mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-activation-")),
    assets = join(directory, "assets"),
    apps = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = await buildOpaqueRuntime({ outdir: assets });
  assert.equal(
    manifest.activated,
    false,
    "source manifest is not a deployment authorization",
  );
  for (const activated of [false, true]) {
    const app = await createApp({
      dataDir: join(directory, String(activated)),
      staticDir: "/not-built",
      appOrigin: "https://front.test",
      runtimeOrigin: "https://runtime.invalid",
      dynamicOrigins: false,
      localRelayMode: "frontend",
      opaqueRuntimeEnabled: true,
      opaqueRuntimeActivated: activated,
      opaqueAssetsDir: assets,
    });
    apps.push(app);
    const config = (await app.inject("/api/config")).json();
    assert.equal(config.runtimeProtocols.opaque.activated, activated);
    assert.equal(config.runtimeProtocols.opaque.version, 2);
    const runtime = await app.inject({
      method: "POST",
      url: "/api/browse/controller/runtime",
      headers: { origin: "https://front.test" },
      payload: {},
    });
    assert.equal(runtime.statusCode, 200);
    const bootstrap = await app.inject(runtime.json().bootstrap);
    assert.equal(bootstrap.statusCode, 200);
    assert.equal(bootstrap.headers["access-control-allow-origin"], "*");
    assert.doesNotMatch(
      (await app.inject("/browse/frame/activation_document_0123456789"))
        .headers["content-security-policy"],
      /allow-same-origin/,
    );
    assert.equal((await app.inject("/health")).statusCode, 200);
  }
});
