import test from "node:test";
import assert from "node:assert/strict";
import {
  rendererTarget,
  moduleAllowedByPolicy,
} from "../runtime/opaque-renderer.ts";
test("opaque renderer selector is restricted to exact parent origins and the reviewed v14 route", () => {
  const url = "https://cdn.platform.openai.com/deployments/dil/v14/runner.html";
  assert.ok(rendererTarget(url, "https://chatgpt.com/"));
  for (const parent of [
    "http://chatgpt.com/",
    "https://chatgpt.com:444/",
    "https://chatgpt.com.evil.test/",
  ])
    assert.equal(rendererTarget(url, parent), undefined);
  assert.equal(
    rendererTarget(url.replace("v14", "v15"), "https://chatgpt.com/"),
    undefined,
  );
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
