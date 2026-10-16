import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createOriginalDocumentPolicy,
  originalExecutionCSP,
} from "../runtime/original-document-policy.ts";
const policy = (...contentPolicies) =>
  createOriginalDocumentPolicy({
    documentURL: "https://website.test/path/page",
    contentPolicies,
  });
const denied = (e) => e.code === "original_policy_denied",
  digest = (s, a = "sha256") => createHash(a).update(s).digest("base64");
test("standard local scheme declarations parse; data images require original img-src and never become script/connect grants", () => {
  const data = "data:image/png;base64,AAAA",
    p = policy(
      "default-src 'none';img-src data:;script-src blob:;connect-src https:",
    );
  assert.doesNotThrow(() => p.checkURL({ kind: "image", url: data }));
  assert.equal(p.upgradeURL(data), data);
  assert.throws(() => p.checkURL({ kind: "font", url: data }), denied);
  for (const kind of ["script", "style", "connect"])
    assert.throws(
      () => p.checkURL({ kind, url: data }),
      (e) => e.code === "original_policy_destination_denied",
    );
  assert.throws(
    () => policy("img-src 'self'").checkURL({ kind: "image", url: data }),
    denied,
  );
  assert.throws(
    () => policy("img-src *").checkURL({ kind: "image", url: data }),
    denied,
  );
  assert.throws(
    () => p.checkURL({ kind: "script", url: "blob:https://website.test/id" }),
    (e) => e.code === "original_policy_destination_denied",
  );
});
test("physical execution policy intersects native eval/Wasm privileges and reserves only selected resource prefix", () => {
  const denied = originalExecutionCSP(
    policy("script-src 'self'"),
    "https://node.test",
  );
  assert.equal(
    denied,
    "script-src 'unsafe-inline'; script-src-elem 'unsafe-inline' blob: https://node.test/native-resource/v1/resource/; script-src-attr 'none'",
  );
  const wasm = originalExecutionCSP(policy("script-src 'wasm-unsafe-eval'"));
  assert.match(wasm, /script-src 'unsafe-inline' 'wasm-unsafe-eval';/);
  assert.equal(wasm.includes("'unsafe-eval'"), false);
  assert.equal(
    originalExecutionCSP(
      policy("script-src 'unsafe-eval'", "default-src 'none'"),
    ).includes("'unsafe-eval'"),
    false,
  );
  assert.equal(originalExecutionCSP(policy()).includes("'unsafe-eval'"), true);
  for (const origin of [
    "https://node.test/path",
    "https://node.test/",
    "https://user@node.test",
    "http://node.test",
  ])
    assert.throws(
      () => originalExecutionCSP(policy(), origin),
      (e) => e.code === "original_policy_invalid_native_origin",
    );
});
test("logical self, secure upgrades, wildcard subdomains, decoded paths and ports match supported source syntax", () => {
  const p = policy(
    "script-src 'self' https://*.cdn.test/assets/ http://legacy.test:80",
  );
  for (const url of [
    "https://website.test/script",
    "https://a.cdn.test/assets/a.js",
    "https://a.cdn.test/assets/%61.js",
    "https://legacy.test/a",
  ])
    assert.doesNotThrow(() => p.checkURL({ kind: "script", url }));
  for (const url of [
    "https://cdn.test/assets/a",
    "https://a.cdn.test/other/a",
    "https://a.cdn.test:444/assets/a",
  ])
    assert.throws(() => p.checkURL({ kind: "script", url }), denied);
  assert.throws(
    () => p.checkURL({ kind: "script", url: "http://website.test/" }),
    (e) => e.code === "original_policy_destination_denied",
  );
});
test("all policies intersect and duplicate directives use the first occurrence", () => {
  const p = policy(
    "script-src https:; script-src 'none'",
    "default-src 'none';script-src 'self'",
  );
  assert.doesNotThrow(() =>
    p.checkURL({ kind: "script", url: "https://website.test/" }),
  );
  assert.throws(
    () => p.checkURL({ kind: "script", url: "https://other.test/" }),
    denied,
  );
  assert.throws(
    () => p.checkURL({ kind: "image", url: "https://website.test/" }),
    denied,
  );
});
test("element fallback and connect policy cannot be replaced by a script destination", () => {
  const p = policy(
    "default-src 'none';script-src 'self';script-src-elem https://cdn.test;connect-src https://api.test;img-src https:",
  );
  assert.doesNotThrow(() =>
    p.checkURL({ kind: "script", url: "https://cdn.test/" }),
  );
  assert.throws(
    () => p.checkURL({ kind: "script", url: "https://website.test/" }),
    denied,
  );
  assert.throws(
    () => p.checkURL({ kind: "connect", url: "https://cdn.test/" }),
    denied,
  );
  assert.doesNotThrow(() =>
    p.checkURL({ kind: "connect", url: "https://api.test/" }),
  );
});
test("nonce and exact ORIGINAL inline hashes authorize before rewrite; nonce/hash presence disables unsafe-inline", async () => {
  const text = "window.exact = 1;\n",
    p = policy(
      "script-src 'unsafe-inline' 'nonce-dGVzdA==' 'sha256-" +
        digest(text) +
        "'",
    );
  await p.authorizeInline({ kind: "script", source: text });
  await p.authorizeInline({
    kind: "script",
    source: "other",
    nonce: "dGVzdA==",
  });
  await assert.rejects(
    p.authorizeInline({ kind: "script", source: text + " " }),
    denied,
  );
  await assert.rejects(
    p.authorizeInline({ kind: "script", source: "other", nonce: "dGVzdA" }),
    denied,
  );
  assert.doesNotThrow(() =>
    p.checkURL({
      kind: "script",
      url: "https://otherwise-denied.test/a.js",
      nonce: "dGVzdA==",
    }),
  );
});
test("sha256/384/512 and base64url hashes remain exact across policy intersection", async () => {
  const text = 'const value="é";';
  for (const a of ["sha256", "sha384", "sha512"]) {
    const h = digest(text, a)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const r = await policy("style-src '" + a + "-" + h + "'").authorizeInline({
      kind: "style",
      source: text,
    });
    assert.equal(r.hashes[a], digest(text, a));
    assert.equal(Object.isFrozen(r.hashes), true);
  }
});
test("JavaScript/Wasm eval use script-src/default-src rather than script-src-elem", () => {
  const p = policy("script-src 'unsafe-eval';script-src-elem 'none'");
  assert.doesNotThrow(() => p.checkEval("javascript"));
  assert.doesNotThrow(() => p.checkEval("wasm"));
  const wasm = policy("script-src 'wasm-unsafe-eval'");
  assert.doesNotThrow(() => wasm.checkEval("wasm"));
  assert.throws(
    () => wasm.checkEval("javascript"),
    (e) => e.code === "original_policy_eval_denied",
  );
  assert.throws(
    () => policy("default-src 'none'").checkEval("javascript"),
    (e) => e.code === "original_policy_eval_denied",
  );
});
test("source destination policies parse independently of runtime feature support and keep exact fallback chains", () => {
  const self = "https://website.test/payload",
    other = "https://other.test/payload";
  const p = policy(
    "default-src 'none';media-src 'self';worker-src 'self';frame-src 'self';manifest-src 'self';object-src 'self';base-uri 'self';form-action 'self'",
  );
  for (const kind of [
    "media",
    "worker",
    "frame",
    "manifest",
    "object",
    "base",
    "form",
  ]) {
    assert.doesNotThrow(() => p.checkURL({ kind, url: self }));
    assert.throws(() => p.checkURL({ kind, url: other }), denied);
    assert.throws(
      () =>
        policy(
          `${kind === "base" ? "base-uri" : kind === "form" ? "form-action" : kind + "-src"} 'none'`,
        ).checkURL({ kind, url: self }),
      denied,
    );
  }
  // Neither script-src-elem nor default-src rewrites these distinct rules.
  assert.doesNotThrow(() =>
    policy("script-src 'self';script-src-elem 'none'").checkURL({
      kind: "worker",
      url: self,
    }),
  );
  assert.throws(
    () =>
      policy("worker-src 'none';child-src 'self';script-src 'self'").checkURL({
        kind: "worker",
        url: self,
      }),
    denied,
  );
  for (const kind of ["worker", "frame"])
    assert.throws(
      () =>
        policy(
          "child-src 'none';script-src 'self';default-src 'self'",
        ).checkURL({ kind, url: self }),
      denied,
    );
  assert.doesNotThrow(() =>
    policy("child-src 'self';default-src 'none'").checkURL({
      kind: "frame",
      url: self,
    }),
  );
  for (const kind of ["media", "worker", "frame", "manifest", "object"])
    assert.throws(
      () => policy("default-src 'none'").checkURL({ kind, url: self }),
      denied,
    );
  for (const kind of ["base", "form"])
    assert.doesNotThrow(() =>
      policy("default-src 'none'").checkURL({ kind, url: other }),
    );
  assert.throws(
    () =>
      policy("worker-src 'nonce-dGVzdA=='").checkURL({
        kind: "worker",
        url: self,
        nonce: "dGVzdA==",
      }),
    denied,
  );
  assert.throws(
    () =>
      policy("media-src 'self'", "default-src 'none'").checkURL({
        kind: "media",
        url: self,
      }),
    denied,
  );
  assert.throws(
    () =>
      policy("frame-src https://[invalid").checkURL({
        kind: "frame",
        url: self,
      }),
    (e) => e.code === "original_policy_unsupported_source",
  );
});
test("style attributes support all-inline only; handlers and unsafe-hashes remain explicit gates", () => {
  assert.doesNotThrow(() =>
    policy("style-src-attr 'unsafe-inline'").authorizeStyleAttribute(
      "color:red",
    ),
  );
  assert.throws(
    () =>
      policy(
        "style-src 'nonce-dGVzdA==' 'unsafe-inline'",
      ).authorizeStyleAttribute("color:red"),
    denied,
  );
  for (const p of ["script-src 'unsafe-hashes'"])
    assert.throws(
      () => policy(p),
      (e) => e.code.startsWith("original_policy_unsupported"),
    );
  assert.throws(
    () => policy().assertAttribute("script"),
    (e) => e.code === "original_policy_attribute_unsupported",
  );
});
test("Trusted Types physical directives preserve required sinks and intersect policy names", () => {
  assert.deepEqual(
    policy(
      "require-trusted-types-for 'script'; trusted-types google default 'allow-duplicates'",
    ).trustedTypes,
    {
      required: true,
      csp: "require-trusted-types-for 'script'; trusted-types google default 'allow-duplicates'",
    },
  );
  assert.deepEqual(
    policy(
      "trusted-types * 'allow-duplicates'",
      "trusted-types google other",
      "trusted-types google",
    ).trustedTypes,
    { required: false, csp: "trusted-types google" },
  );
  assert.deepEqual(
    policy("trusted-types one", "trusted-types two").trustedTypes,
    { required: false, csp: "trusted-types 'none'" },
  );
  assert.throws(
    () => policy("require-trusted-types-for 'style'"),
    (e) => e.code === "original_policy_unsupported_source",
  );
  assert.throws(
    () => policy('trusted-types "invalid"'),
    (e) => e.code === "original_policy_unsupported_source",
  );
});
test("redirect matching skips only CSP path, not host/port/scheme; upgrade policy is explicit", () => {
  const p = policy("script-src https://cdn.test/a/");
  assert.throws(
    () => p.checkURL({ kind: "script", url: "https://cdn.test/other" }),
    denied,
  );
  assert.doesNotThrow(() =>
    p.checkURL({
      kind: "script",
      url: "https://cdn.test/other",
      redirectCount: 1,
    }),
  );
  assert.throws(
    () =>
      p.checkURL({
        kind: "script",
        url: "https://other.test/other",
        redirectCount: 1,
      }),
    denied,
  );
  assert.equal(
    policy("upgrade-insecure-requests;img-src https:").upgradeURL(
      "http://images.test/a",
    ),
    "https://images.test/a",
  );
});
test("WebSocket self follows CSP self secure scheme/port rules; star is not an implicit WS scheme grant", () => {
  assert.doesNotThrow(() =>
    policy("connect-src 'self'").checkURL({
      kind: "connect",
      url: "wss://website.test/socket",
    }),
  );
  assert.throws(
    () =>
      policy("connect-src *").checkURL({
        kind: "connect",
        url: "wss://other.test/socket",
      }),
    denied,
  );
  assert.doesNotThrow(() =>
    policy("connect-src ws:").checkURL({
      kind: "connect",
      url: "wss://other.test/socket",
    }),
  );
});
test("snapshots are immutable and source/inline resource bounds reject before hashing", async () => {
  const values = ["default-src 'none'"],
    p = createOriginalDocumentPolicy({
      documentURL: "https://website.test/",
      contentPolicies: values,
    });
  values[0] = "default-src *";
  assert.equal(p.snapshot[0], "default-src 'none'");
  assert.equal(Object.isFrozen(p.snapshot), true);
  await assert.rejects(
    p.authorizeInline({
      kind: "script",
      source: "x".repeat(2 * 1024 * 1024 + 1),
    }),
    (e) => e.code === "original_policy_invalid_inline",
  );
  assert.throws(
    () =>
      createOriginalDocumentPolicy({
        documentURL: "https://website.test/",
        contentPolicies: ["x".repeat(65537)],
      }),
    (e) => e.code === "original_policy_invalid",
  );
});


test("Google-shaped strict-dynamic policy accepts nonced roots and inherited-nonce imports, never parser host fallback", async () => {
  const p = createOriginalDocumentPolicy({
    documentURL: "https://www.google.com/search?q=atlas",
    contentPolicies: ["object-src 'none';base-uri 'self';script-src 'nonce-dGVzdA==' 'strict-dynamic' 'report-sample' 'unsafe-eval' 'unsafe-inline' https: http:;report-uri https://csp.test/report"],
  });
  await p.authorizeInline({kind:"script",source:"window.root = true",nonce:"dGVzdA=="});
  for (const url of ["https://www.google.com/bootstrap.js", "https://otherwise-unlisted.test/import.js"])
    assert.doesNotThrow(() => p.checkURL({kind:"script",url,nonce:"dGVzdA=="}));
  for (const url of ["https://www.google.com/host-only.js", "https://otherwise-unlisted.test/import.js"])
    for (const nonce of [undefined,"wrong-nonce"])
      assert.throws(() => p.checkURL({kind:"script",url,nonce}),denied);
  await assert.rejects(p.authorizeInline({kind:"script",source:"window.injected=true"}),denied);
  assert.doesNotThrow(() => p.checkEval("javascript"));
  assert.throws(() => p.checkURL({kind:"object",url:"https://www.google.com/object"}),denied);
  assert.throws(() => p.checkURL({kind:"base",url:"https://outside.test/"}),denied);
});
test("strict-dynamic without a nonce/hash suppresses unsafe-inline and URL allowlists", async () => {
  const p=policy("script-src 'strict-dynamic' 'unsafe-inline' https: 'self'");
  assert.throws(() => p.checkURL({kind:"script",url:"https://website.test/a.js"}),denied);
  await assert.rejects(p.authorizeInline({kind:"script",source:"window.injected=true"}),denied);
});
test("strict-dynamic retains exact inline hash roots without granting unauthenticated URL descendants", async () => {
  const source="window.hashRoot=true",p=policy("script-src 'strict-dynamic' 'sha256-"+digest(source)+"' 'unsafe-inline' https:");
  await p.authorizeInline({kind:"script",source});
  await assert.rejects(p.authorizeInline({kind:"script",source:source+";"}),denied);
  assert.throws(() => p.checkURL({kind:"script",url:"https://website.test/child.js"}),denied);
});
test("strict-dynamic intersects all enforced policies and keeps script-src-elem precedence", async () => {
  const p=policy("script-src 'nonce-dGVzdA==' 'strict-dynamic' https:","script-src 'self'");
  assert.doesNotThrow(() => p.checkURL({kind:"script",url:"https://website.test/a.js",nonce:"dGVzdA=="}));
  assert.throws(() => p.checkURL({kind:"script",url:"https://other.test/a.js",nonce:"dGVzdA=="}),denied);
  const explicit=policy("script-src 'nonce-dGVzdA==' 'strict-dynamic';script-src-elem 'self'");
  assert.doesNotThrow(() => explicit.checkURL({kind:"script",url:"https://website.test/a.js"}));
  assert.throws(() => explicit.checkURL({kind:"script",url:"https://other.test/a.js",nonce:"dGVzdA=="}),denied);
});

test("script attributes permit only original all-inline policies, with exact fallback and intersections", () => {
  const source = "window.clicked=true";
  for (const p of [policy(), policy("script-src 'unsafe-inline'"), policy("default-src 'unsafe-inline'"), policy("script-src 'none'; script-src-attr 'unsafe-inline'")]) {
    const receipt = p.authorizeScriptAttribute(source);
    assert.deepEqual(receipt,{kind:"script-attribute",source});
    assert.equal(Object.isFrozen(receipt),true);
    assert.match(originalExecutionCSP(p), /script-src-attr 'unsafe-inline'(?:;|$)/);
  }
  for (const p of [policy("script-src 'self'"), policy("default-src 'none'"), policy("script-src 'unsafe-inline';script-src-attr 'none'"), policy("script-src 'unsafe-inline'", "script-src-attr 'none'"), policy("script-src 'unsafe-inline' 'nonce-dGVzdA=='"), policy("script-src 'unsafe-inline' 'sha256-"+digest(source)+"'"), policy("script-src 'unsafe-inline' 'strict-dynamic'")]) {
    assert.throws(()=>p.authorizeScriptAttribute(source), denied);
    assert.match(originalExecutionCSP(p), /script-src-attr 'none'(?:;|$)/);
  }
  assert.throws(()=>policy().authorizeScriptAttribute(null),e=>e.code==='original_policy_invalid_inline');
  assert.throws(()=>policy().authorizeScriptAttribute('x'.repeat(2*1024*1024+1)),e=>e.code==='original_policy_invalid_inline');
  assert.throws(()=>policy("script-src-attr 'unsafe-hashes'"),e=>e.code==='original_policy_unsupported_source');
});
