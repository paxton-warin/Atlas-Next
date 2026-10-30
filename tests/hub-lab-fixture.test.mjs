import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixtureWave, serveLabFixture } from "../scripts/hub-lab-fixture.mjs";

test("normal controller review routes retain compatibility and profile-worker fixture contracts", async () => {
  const app = createServer(serveLabFixture);
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const compat = await (await fetch(base + "/controller-compat")).text();
    assert.match(compat, /<template id="compat-template"><span id="template-value">Template ready<\/span>/);
    assert.match(compat, /<math id="compat-math">/);
    assert.match(compat, /title="Srcdoc fixture"[^>]*srcdoc="[^"]*Srcdoc ready/);
    for (const id of ["history-push", "history-replace", "history-result"]) assert.ok(compat.includes(`id="${id}"`));
    assert.ok(compat.includes("History push complete"));
    assert.ok(compat.includes("History replace complete"));
    const meta = await (await fetch(base + "/controller-meta")).text();
    assert.match(meta, /http-equiv="refresh" content="0;url=\/controller-meta-done"/);
    assert.match(await (await fetch(base + "/controller-meta-done")).text(), /<h1>Meta refresh complete<\/h1>/);
    const workerResponse = await fetch(base + "/controller-profile-worker.js");
    assert.match(workerResponse.headers.get("content-type"), /javascript/);
    const worker = await workerResponse.text();
    assert.match(worker, /indexedDB\.open\('atlas-controller-worker-review',1\)/);
    assert.match(worker, /createObjectStore\('proof'\)/);
    assert.match(worker, /new Blob\(\['Worker blob '\+message.value\]/);
    assert.match(worker, /self\.onconnect/);
    assert.match(worker, /blobText:/);
    assert.doesNotThrow(() => new Function(worker));
  } finally {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
test("deterministic fixture wave is valid PCM with stable bytes", () => {
  const wave = fixtureWave();
  assert.equal(wave.toString("ascii", 0, 4), "RIFF");
  assert.equal(wave.toString("ascii", 8, 12), "WAVE");
  assert.equal(wave.readUInt32LE(4), wave.length - 8);
  assert.equal(wave.readUInt32LE(40), wave.length - 44);
  assert.deepEqual(wave, fixtureWave());
});
test("fixture serves exact script, frame, JSON and media MIME types without external resources", async () => {
  const app = createServer(serveLabFixture);
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try {
    const origin = "http://127.0.0.1:" + app.address().port;
    for (const [path, type] of [
      ["/", "text/html"],
      ["/storage", "text/html"],
      ["/frames", "text/html"],
      ["/module.js", "text/javascript"],
      ["/worker.js", "text/javascript"],
      ["/module-worker.js", "text/javascript"],
      ["/api", "application/json"],
      ["/child", "text/html"],
      ["/popup", "text/html"],
      ["/tone.wav", "audio/wav"],
    ]) {
      const r = await fetch(origin + path);
      assert.equal(r.status, 200, path);
      assert.ok(r.headers.get("content-type").startsWith(type), path);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    const page = await (await fetch(origin)).text();
    for (const id of [
      "count",
      "save",
      "idb-save",
      "idb-read",
      "idb-abort",
      "cookie-save",
      "cookie-read",
      "worker",
      "module-worker",
      "popup",
      "fetch",
      "media",
    ])
      assert.match(page, new RegExp('id="' + id + '"'));
    assert.doesNotMatch(page, /https?:\/\//);
    const storage = await (await fetch(origin + "/storage")).text();
    assert.doesNotMatch(storage, /<iframe\b/);
    assert.match(storage, /Nested-frame loading is excluded/);
    assert.match(await (await fetch(origin + "/frames")).text(), /<iframe\b/);
    assert.equal((await fetch(origin + "/missing")).status, 404);
  } finally {
    await new Promise((r) => app.close(r));
  }
});
