import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const file = process.argv[2];
assert.ok(file, "Provide a worker file");
let imported,
  handler,
  routed = 0,
  responded = 0;
vm.runInNewContext(
  readFileSync(file, "utf8"),
  {
    importScripts: (path) => {
      imported = path;
    },
    addEventListener: (event, fn) => {
      assert.equal(event, "fetch");
      handler = fn;
    },
    $scramjetController: {
      shouldRoute: (event) => event.request.url.includes("/~/sj/"),
      route: () => {
        routed++;
        return "PROXIED";
      },
    },
  },
  { filename: file, timeout: 1000 },
);
assert.equal(typeof handler, "function");
handler({
  request: { url: "https://runtime.test/~/sj/test" },
  respondWith: (value) => {
    assert.equal(value, "PROXIED");
    responded++;
  },
});
handler({
  request: { url: "https://runtime.test/health" },
  respondWith: () => assert.fail("Non-proxy request was intercepted"),
});
assert.equal(routed, 1);
assert.equal(responded, 1);
console.log(`IMPORT=${imported}; ROUTED=1; PASSTHROUGH=1`);
