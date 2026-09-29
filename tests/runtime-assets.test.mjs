import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { createRuntime } from "../server/runtime.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-runtime-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "upstream/fixture/app/vendor"), { recursive: true });
  copyFileSync(
    new URL("../scripts/prepare-runtime.mjs", import.meta.url),
    join(root, "scripts/prepare-runtime.mjs"),
  );
  const bytes = Buffer.from(
    "/* fixture asset for browser startup */\n".repeat(1000),
  );
  const fork = {
    directory: "upstream/fixture",
    source: "fixture",
    commit: "fixture",
    assets: {},
  };
  const setAsset = (file, path, content) => {
    writeFileSync(join(root, "upstream/fixture/app/vendor", file), content);
    fork.assets[file] = {
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
    writeFileSync(
      join(root, "scripts/runtime-fork.json"),
      JSON.stringify(fork),
    );
  };
  setAsset("main.js", "runtime/main.js", bytes);
  setAsset("main.wasm", "runtime/main.wasm", bytes);
  setAsset("worker.js", "controller/worker.js", bytes);
  setAsset("small.js", "runtime/small.js", Buffer.from("/* small */"));
  return {
    root,
    bytes,
    setAsset,
    dir: join(root, "runtime/public"),
    build: () =>
      execFileSync(process.execPath, ["scripts/prepare-runtime.mjs"], {
        cwd: root,
        encoding: "utf8",
      }),
  };
}

test("runtime preparation makes smaller lossless variants without changing pinned source hashes", (t) => {
  const f = fixture(t);
  f.build();
  for (const path of [
    "runtime/main.js",
    "runtime/main.wasm",
    "controller/worker.js",
  ]) {
    const raw = readFileSync(join(f.dir, path));
    assert.deepEqual(raw, f.bytes);
    for (const [suffix, decode] of [
      [".gz", gunzipSync],
      [".br", brotliDecompressSync],
    ]) {
      const compressed = readFileSync(join(f.dir, path + suffix));
      assert.ok(compressed.length < raw.length);
      assert.deepEqual(decode(compressed), raw);
    }
  }
  const manifest = JSON.parse(
    readFileSync(join(f.dir, "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.hashes["runtime/main.js"],
    createHash("sha256").update(f.bytes).digest("hex"),
  );
  assert.equal(existsSync(join(f.dir, "runtime/small.js.gz")), false);
  f.setAsset("main.js", "runtime/main.js", Buffer.from("/* now small */"));
  f.build();
  assert.equal(existsSync(join(f.dir, "runtime/main.js.gz")), false);
  assert.equal(existsSync(join(f.dir, "runtime/main.js.br")), false);
});

test("runtime negotiates Brotli/gzip or raw assets, retains worker revalidation and uncached authorization", async (t) => {
  const f = fixture(t);
  f.build();
  const runtime = await createRuntime({
    appOrigin: "https://app.test",
    runtimeOrigin: "https://node.test",
    staticDir: f.dir,
    authorize: (ticket) => {
      if (ticket !== "fixture")
        throw Object.assign(Error("Invalid ticket"), { statusCode: 401 });
      return { appOrigin: "https://app.test" };
    },
  });
  t.after(() => runtime.close());
  for (const [encoding, decode] of [
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
    ["identity", (value) => value],
  ]) {
    for (const path of ["/runtime/main.js", "/runtime/main.wasm"]) {
      const response = await runtime.inject({
        url: path,
        headers: { "accept-encoding": encoding },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.headers["content-encoding"],
        encoding === "identity" ? undefined : encoding,
      );
      assert.equal(response.headers.vary, "Accept-Encoding");
      assert.match(
        response.headers["content-type"],
        path.endsWith(".wasm") ? /application\/wasm/ : /javascript/,
      );
      assert.deepEqual(decode(response.rawPayload), f.bytes);
    }
  }
  const worker = await runtime.inject({
    url: "/controller/worker.js",
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(worker.headers["cache-control"], "no-cache");
  assert.equal(worker.headers["service-worker-allowed"], "/");
  assert.equal(worker.headers["content-encoding"], "gzip");
  const denied = await runtime.inject("/runtime-config");
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers["cache-control"], "no-store");
  const config = await runtime.inject({
    url: "/runtime-config",
    headers: { authorization: "Bearer fixture", "accept-encoding": "br" },
  });
  assert.equal(config.statusCode, 200);
  assert.equal(config.headers["cache-control"], "no-store");
  assert.equal(config.headers["content-encoding"], undefined);
});
