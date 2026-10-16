import test from "node:test";
import assert from "node:assert/strict";
import { fixture, nativeHeaders } from "./native-media-gateway-fixture.mjs";
import { createNativeResourcePreparer } from "../runtime/native-resource-preparer.ts";
test("authenticated finite media supports exact single ranges, suffix/open ranges, HEAD and If-Range; foreign destinations stay denied", async (t) => {
  const f = await fixture(t),
    { ws, doc } = await f.make(),
    body = Buffer.from("0123456789"),
    meta = f.metadata(doc, body, { kind: "video", mime: "video/webm" });
  ws.send(JSON.stringify(meta));
  assert.equal((await ws.next()).type, "upload-ready");
  ws.send(Buffer.concat([Buffer.from(meta.uploadId), body]));
  ws.send(JSON.stringify({ type: "commit", uploadId: meta.uploadId }));
  const ready = await ws.next(),
    path = new URL(ready.url).pathname,
    cookie = await f.enroll(doc);
  const request = (extra = {}, method = "GET") =>
    f.app.inject({
      url: path,
      method,
      headers: nativeHeaders(f, cookie, {
        "sec-fetch-dest": "video",
        ...extra,
      }),
    });
  const full = await request();
  assert.equal(full.statusCode, 200);
  assert.equal(full.body, "0123456789");
  assert.equal(full.headers["accept-ranges"], "bytes");
  for (const [range, expected, content] of [
    ["bytes=2-4", "234", "bytes 2-4/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=-30", "0123456789", "bytes 0-9/10"],
  ]) {
    const r = await request({ range });
    assert.equal(r.statusCode, 206);
    assert.equal(r.body, expected);
    assert.equal(r.headers["content-range"], content);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
  for (const range of [
    "bytes=10-",
    "bytes=4-1",
    "bytes=-0",
    "bytes=0-1,3-4",
    "bytes=9999999999999999999-",
    "nonsense",
  ]) {
    const r = await request({ range });
    assert.equal(r.statusCode, 416);
    assert.equal(r.headers["content-range"], "bytes */10");
    assert.equal(r.body, "");
  }
  const head = await request({ range: "bytes=2-4" }, "HEAD");
  assert.equal(head.statusCode, 206);
  assert.equal(head.headers["content-length"], "3");
  assert.equal(head.body, "");
  assert.equal(
    (await request({ range: "bytes=2-4", "if-range": "mismatch" })).statusCode,
    200,
  );
  assert.equal(
    (await request({ range: "bytes=2-4", "if-range": full.headers.etag }))
      .statusCode,
    206,
  );
  for (const headers of [
    { cookie: "" },
    { "sec-fetch-dest": "image" },
    { "sec-fetch-dest": "audio" },
    { "sec-fetch-mode": "cors" },
    { "sec-fetch-dest": "document" },
  ])
    assert.equal((await request(headers)).statusCode, 403);
});
test("media preparer enforces media-src, CORP/CORS, complete body and bound byte limits independently of connect/img policy", async () => {
  const calls = [],
    uploads = [];
  let headers = [["content-type", "audio/wav"]],
    status = 200;
  const make = (policies, coep = "unsafe-none") =>
    createNativeResourcePreparer({
      documentId: "finite_media_test_document",
      documentURL: "https://site.test/page",
      topLevelURL: "https://site.test/page",
      frontendOrigin: "https://front.test",
      contentPolicies: policies,
      coep,
      selectedIdentity: () => ({
        nodeId: "selected",
        resourceOrigin: "https://node.test",
        leaseHash: "a".repeat(64),
        generation: 1,
      }),
      fetch: async (req) => {
        calls.push(req);
        return {
          url: req.url,
          status,
          statusText: "OK",
          headers,
          body: new Uint8Array([1, 2, 3]).buffer,
        };
      },
      upload: async (data) => {
        uploads.push(data);
        return (
          "https://node.test/native-resource/v1/resource/" + "b".repeat(43)
        );
      },
    });
  const ok = make([
    "media-src https://media.test/allowed/;connect-src 'none';img-src 'none'",
  ]);
  assert.equal(
    typeof (await ok.prepare({
      kind: "audio",
      url: "https://media.test/allowed/sound.wav",
    })),
    "string",
  );
  assert.equal(calls[0].destination, "audio");
  const prior = calls.length;
  await assert.rejects(
    ok.prepare({ kind: "audio", url: "https://media.test/denied.wav" }),
    { code: "native_resource_csp_denied" },
  );
  assert.equal(calls.length, prior);
  await assert.rejects(
    ok.prepare({
      kind: "audio",
      url: "https://media.test/allowed/sound.wav",
      crossOrigin: "anonymous",
    }),
    { code: "native_resource_cors_denied" },
  );
  const corp = make(["media-src https:"], "require-corp");
  await assert.rejects(
    corp.prepare({ kind: "audio", url: "https://media.test/sound.wav" }),
    { code: "native_resource_corp_denied" },
  );
  status = 206;
  await assert.rejects(
    ok.prepare({ kind: "audio", url: "https://media.test/allowed/sound.wav" }),
    { code: "native_resource_complete_media_required" },
  );
  status = 200;
  headers = [["content-type", "text/html"]];
  await assert.rejects(
    ok.prepare({ kind: "audio", url: "https://media.test/allowed/sound.wav" }),
    { code: "native_resource_mime_denied" },
  );
  for (const p of [ok, corp]) p.dispose();
  assert.equal(uploads.length, 1);
});
