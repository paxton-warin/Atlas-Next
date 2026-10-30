import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createReplicaControlV2 } from "../web/src/replica-control-v2.ts";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
test("native-only catalog worker imports no legacy migration, journal, permission, Hub or backup code", async () => {
  const result = await build({
    entryPoints: ["runtime/replica-native-control-worker-v2.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.deepEqual(
    inputs.filter((name) =>
      /legacy|profile-journal|profile-permissions|profile-sync|hub-contracts|backup-v2/.test(
        name,
      ),
    ),
    [],
  );
  assert.equal(
    /fetch\(|new WebSocket\(|navigator\.onLine|encodePortableValue|assertProfileWrite|appendProfileJournal/.test(
      result.outputFiles[0].text,
    ),
    false,
  );
});
test("native-only wrapper sends explicit authority mode and distinguishes unavailable discovery from empty cloud", async () => {
  const sent = [],
    worker = {
      postMessage(value) {
        sent.push(value);
        queueMicrotask(() =>
          this.onmessage({
            data: {
              protocol: value.protocol,
              id: value.id,
              ok: true,
              value: { accepted: true },
            },
          }),
        );
      },
      terminate() {},
    };
  const control = createReplicaControlV2({
    nativeOnly: true,
    createWorker: () => worker,
  });
  await control.initialize(
    "11111111-1111-4111-8111-111111111111",
    "native-only-v1",
    true,
  );
  await control.cloudUnavailable();
  assert.equal(sent[0].args.nativeOnly, true);
  assert.equal(sent[0].args.selection, "native-only-v1");
  assert.equal(sent[1].operation, "cloud-unavailable");
  assert.equal(
    sent.some((m) => m.operation === "cloud-empty"),
    false,
  );
  control.dispose();
});
