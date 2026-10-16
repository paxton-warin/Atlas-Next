import test from "node:test";
import assert from "node:assert/strict";
import { installDiscordScriptSelector } from "../runtime/discord-script-selector.ts";

test("OneTrust literal-src lookup returns the actual script by original source without faking currentScript", () => {
  const script = {
    original:
      "https://discord.com/assets/oneTrust/v8/scripttemplates/otSDKStub.js",
  };
  const win = { document: {} };
  let proxy;
  const client = {
    url: new URL("https://discord.com/"),
    Proxy(path, hooks) {
      assert.equal(path, "Document.prototype.querySelector");
      proxy = hooks.apply;
    },
    natives: {
      call(path, target, argument) {
        if (path === "Document.prototype.querySelectorAll") {
          assert.equal(target, win.document);
          assert.equal(argument, "script[src]");
          return [script];
        }
        assert.equal(path, "Element.prototype.getAttribute");
        assert.equal(target, script);
        assert.equal(argument, "runtimekit-attr-src");
        return target.original;
      },
    },
  };
  installDiscordScriptSelector(win, client);
  for (const selector of [
    "script[src*='otSDKStub']",
    'script[src*="otSDKStub"]',
  ]) {
    let result;
    proxy({
      this: win.document,
      args: [selector],
      return: (value) => {
        result = value;
      },
    });
    assert.equal(result, script);
  }
  for (const [document, selector] of [
    [{}, "script[src*='otSDKStub']"],
    [win.document, "script[src*='anotherScript']"],
    [win.document, "script[data-domain-script]"],
    [win.document, "script[src*='otSDKStub'],div"],
  ])
    proxy({
      this: document,
      args: [selector],
      return: () => assert.fail("unrelated selectors must be untouched"),
    });
  assert.equal(Object.hasOwn(win.document, "currentScript"), false);
});

test("the selector compatibility hook does not install on login, app, or unrelated origins", () => {
  for (const url of [
    "https://discord.com/login",
    "https://discord.com/app",
    "https://discord.com.evil.test/",
    "http://discord.com/",
  ])
    installDiscordScriptSelector(
      { document: {} },
      {
        url: new URL(url),
        Proxy() {
          assert.fail("unrelated page");
        },
      },
    );
});
