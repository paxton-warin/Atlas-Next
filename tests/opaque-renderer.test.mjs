import test from "node:test";
import assert from "node:assert/strict";
import {
  rendererTarget,
  moduleAllowedByPolicy,
} from "../runtime/opaque-renderer.ts";
test("opaque renderer selector is restricted to exact parent origins and the reviewed v14/v15 routes", () => {
  const url = "https://cdn.platform.openai.com/deployments/dil/v14/runner.html";
  assert.ok(rendererTarget(url, "https://chatgpt.com/"));
  assert.ok(rendererTarget(url.replace("v14", "v15"), "https://chatgpt.com/"));
  assert.ok(rendererTarget(url.replace("v14", "v15"), "https://chat.openai.com/"));
  for (const version of ["v14", "v15"])
    for (const parent of [
      "http://chatgpt.com/",
      "https://chatgpt.com:444/",
      "https://chatgpt.com.evil.test/",
      "https://unrelated.example/",
    ])
      assert.equal(rendererTarget(url.replace("v14", version), parent), undefined);
  assert.equal(
    rendererTarget(url.replace("v14", "v16"), "https://chatgpt.com/"),
    undefined,
  );
  for (const path of ["/deployments/dil/v15/runner.html/extra", "/deployments/dil/v150/runner.html", "/deployments/dil/v15/not-runner.html"])
    assert.equal(rendererTarget("https://cdn.platform.openai.com" + path, "https://chatgpt.com/"), undefined);
  assert.equal(
    rendererTarget(
      url.replace(
        "cdn.platform.openai.com",
        "cdn.platform.openai.com.evil.test",
      ),
      "https://chatgpt.com/",
    ),
    undefined,
  );
});
test("renderer policy matching preserves script restrictions and exact path boundaries", () => {
  const base = new URL(
      "https://cdn.platform.openai.com/deployments/dil/v14/runner.html",
    ),
    asset = new URL(
      "https://cdn.platform.openai.com/assets/dil/runner-12345678.js",
    );
  assert.equal(
    moduleAllowedByPolicy("default-src 'none'; script-src 'self'", asset, base),
    true,
  );
  assert.equal(
    moduleAllowedByPolicy(
      "script-src 'self'; script-src-elem 'none'",
      asset,
      base,
    ),
    false,
  );
  assert.equal(
    moduleAllowedByPolicy(
      "script-src https://cdn.platform.openai.com/assets/dil/",
      asset,
      base,
    ),
    true,
  );
  assert.equal(
    moduleAllowedByPolicy(
      "script-src " + asset.href,
      new URL(asset.href + "extra"),
      base,
    ),
    false,
  );
  assert.equal(
    moduleAllowedByPolicy(
      "script-src https://cdn.platform.openai.com.evil.test/",
      asset,
      base,
    ),
    false,
  );
});
