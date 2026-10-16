/** Native Chrome CSP decision comparisons plus real trusted HTML plan tests.
 * Policy checks only: complete opaque document enforcement is a separate gate. */
import Fastify from "fastify";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild"),
  app = Fastify({ logger: false }),
  cases = [],
  requests = [];
let browser;
const bundle = (
  await build({
    stdin: {
      contents:
        "export {createOriginalDocumentPolicy} from './runtime/original-document-policy.ts';export {createOriginalDocumentPlan} from './runtime/original-document-plan.ts';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    platform: "browser",
    logLevel: "silent",
    plugins:
      process.env.ATLAS_DATA_IMAGE_POLICY_BASELINE === "1" ||
      process.env.ATLAS_DESTINATION_POLICY_BASELINE === "1"
        ? [
            {
              name: "preserved-original-data-image-policy",
              setup(builder) {
                builder.onLoad(
                  { filter: /\/runtime\/original-document-policy\.ts$/ },
                  () => ({
                    contents: fs.readFileSync(
                      `evidence/${process.env.ATLAS_DESTINATION_POLICY_BASELINE === "1" ? "original-policy-destinations" : "data-image-policy"}-20261016/before/original-document-policy.ts`,
                      "utf8",
                    ),
                    loader: "ts",
                  }),
                );
              },
            },
          ]
        : [],
  })
).outputFiles[0].text;
app.get("/", (_r, p) =>
  p.type("text/html").send("<!doctype html><title>Original CSP parity</title>"),
);
app.get("/policy.js", (_r, p) => p.type("application/javascript").send(bundle));
app.get("/favicon.ico", (_r, p) => p.code(204).send());
app.get("/frame/:id", (r, p) => {
  const c = cases[Number(r.params.id)];
  if (c.policies.length) p.header("content-security-policy", c.policies);
  return p
    .type("text/html")
    .send("<!doctype html><html><head></head><body></body></html>");
});
app.get("/allowed/payload.js", (r, p) => {
  requests.push(r.url);
  return p.type("application/javascript").send("window.__ran=true");
});
app.get("/forbidden/payload.js", (r, p) => {
  requests.push(r.url);
  return p.type("application/javascript").send("window.__ran=true");
});
app.get("/data", (r, p) => {
  requests.push(r.url);
  return p.type("text/plain").send("yes");
});
app.get("/worker.js", (_r, p) =>
  p.type("application/javascript").send("postMessage(true)"),
);
app.get("/allowed/frame", (_r, p) =>
  p.type("text/html").send('<p id="nested-marker">Child</p>'),
);
const wave = Buffer.alloc(844, 128);
wave.write("RIFF", 0);
wave.writeUInt32LE(836, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(8000, 28);
wave.writeUInt16LE(1, 32);
wave.writeUInt16LE(8, 34);
wave.write("data", 36);
wave.writeUInt32LE(800, 40);
app.get("/tone.wav", (_r, p) => p.type("audio/wav").send(wave));
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://localhost:" + app.server.address().port,
    source = "window.__ran=true",
    hash = createHash("sha256").update(source).digest("base64");
  cases.push(
    {
      name: "inline-none",
      kind: "inline",
      policies: ["script-src 'none'"],
      source,
    },
    {
      name: "inline-unsafe",
      kind: "inline",
      policies: ["script-src 'unsafe-inline'"],
      source,
    },
    {
      name: "nonce-match",
      kind: "inline",
      policies: ["script-src 'nonce-dGVzdA=='"],
      source,
      nonce: "dGVzdA==",
    },
    {
      name: "nonce-mismatch",
      kind: "inline",
      policies: ["script-src 'nonce-dGVzdA=='"],
      source,
      nonce: "different",
    },
    {
      name: "nonce-suppresses-unsafe",
      kind: "inline",
      policies: ["script-src 'unsafe-inline' 'nonce-dGVzdA=='"],
      source,
    },
    {
      name: "hash-match",
      kind: "inline",
      policies: ["script-src 'sha256-" + hash + "'"],
      source,
    },
    {
      name: "hash-whitespace-mismatch",
      kind: "inline",
      policies: ["script-src 'sha256-" + hash + "'"],
      source: source + " ",
    },
    {
      name: "hash-suppresses-unsafe",
      kind: "inline",
      policies: ["script-src 'unsafe-inline' 'sha256-" + hash + "'"],
      source: "window.__ran=true;",
    },
    {
      name: "policy-intersection",
      kind: "inline",
      policies: ["script-src 'unsafe-inline'", "script-src 'none'"],
      source,
    },
    {
      name: "duplicate-first-wins",
      kind: "inline",
      policies: ["script-src 'none';script-src 'unsafe-inline'"],
      source,
    },
    {
      name: "elem-overrides-inline",
      kind: "inline",
      policies: ["script-src 'unsafe-inline';script-src-elem 'none'"],
      source,
    },
    { name: "eval-none", kind: "eval", policies: ["script-src 'none'"] },
    {
      name: "eval-allowed",
      kind: "eval",
      policies: ["script-src 'unsafe-eval'"],
    },
    {
      name: "eval-ignores-elem",
      kind: "eval",
      policies: ["script-src 'unsafe-eval';script-src-elem 'none'"],
    },
    {
      name: "wasm-eval-only",
      kind: "wasm",
      policies: ["script-src 'wasm-unsafe-eval'"],
    },
    {
      name: "javascript-denies-wasm-token",
      kind: "eval",
      policies: ["script-src 'wasm-unsafe-eval'"],
    },
    {
      name: "style-none",
      kind: "style",
      policies: ["style-src 'none'"],
      source: "body{color:rgb(1,2,3)}",
    },
    {
      name: "style-inline",
      kind: "style",
      policies: ["style-src 'unsafe-inline'"],
      source: "body{color:rgb(1,2,3)}",
    },
    {
      name: "style-attribute-deny",
      kind: "attribute",
      policies: ["style-src-attr 'none';style-src 'unsafe-inline'"],
      source: "color:rgb(1,2,3)",
    },
    {
      name: "style-attribute-allow",
      kind: "attribute",
      policies: ["style-src-attr 'unsafe-inline'"],
      source: "color:rgb(1,2,3)",
    },
    {
      name: "external-self",
      kind: "script",
      policies: ["script-src 'self'"],
      url: origin + "/allowed/payload.js",
    },
    {
      name: "external-path-deny",
      kind: "script",
      policies: ["script-src " + origin + "/allowed/"],
      url: origin + "/forbidden/payload.js",
    },
    {
      name: "external-path-allow",
      kind: "script",
      policies: ["script-src " + origin + "/allowed/"],
      url: origin + "/allowed/payload.js",
    },
    {
      name: "connect-none",
      kind: "connect",
      policies: ["connect-src 'none'"],
      url: origin + "/data",
    },
    {
      name: "connect-self",
      kind: "connect",
      policies: ["connect-src 'self'"],
      url: origin + "/data",
    },
    ...[
      ["data-image-allow", "img-src data:"],
      ["data-image-deny-self", "img-src 'self'"],
      ["data-image-deny-wildcard", "img-src *"],
    ].map(([name, policy]) => ({
      name,
      kind: "image",
      policies: [policy],
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8M0AAAAASUVORK5CYII=",
    })),
    ...[
      ["worker-explicit-allow", "worker-src 'self';script-src 'none'"],
      ["worker-explicit-deny", "worker-src 'none';script-src 'self'"],
      ["worker-child-fallback", "child-src 'self';default-src 'none'"],
      ["worker-child-deny", "child-src 'none';script-src 'self'"],
      ["worker-script-fallback", "script-src 'self';script-src-elem 'none'"],
      ["worker-default-deny", "default-src 'none'"],
    ].map(([name, p]) => ({
      name,
      kind: "worker",
      policies: [p],
      url: origin + "/worker.js",
    })),
    ...[
      ["frame-explicit-allow", "frame-src 'self';child-src 'none'"],
      ["frame-explicit-deny", "frame-src 'none';child-src 'self'"],
      ["frame-child-fallback", "child-src 'self';default-src 'none'"],
      ["frame-default-deny", "default-src 'none'"],
    ].map(([name, p]) => ({
      name,
      kind: "frame",
      policies: [p],
      url: origin + "/allowed/frame",
    })),
    ...[
      ["media-explicit-allow", "media-src 'self';default-src 'none'"],
      ["media-explicit-deny", "media-src 'none';default-src 'self'"],
      ["media-default-allow", "default-src 'self'"],
      ["media-default-deny", "default-src 'none'"],
    ].map(([name, p]) => ({
      name,
      kind: "media",
      policies: [p],
      url: origin + "/tone.wav",
    })),
    ...[
      ["base-explicit-allow", "base-uri 'self'", origin + "/new/"],
      ["base-explicit-deny", "base-uri 'none'", origin + "/new/"],
      ["base-no-default-fallback", "default-src 'none'", origin + "/new/"],
    ].map(([name, p, url]) => ({ name, kind: "base", policies: [p], url })),
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async (cases) => {
    const { createOriginalDocumentPolicy, createOriginalDocumentPlan } =
        await import("/policy.js"),
      records = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i],
        frame = document.createElement("iframe");
      frame.src = "/frame/" + i;
      const loaded = new Promise((r) => (frame.onload = r));
      document.body.append(frame);
      await loaded;
      const doc = frame.contentDocument,
        win = frame.contentWindow;
      let native = false,
        predicted = false;
      try {
        if (c.kind === "inline" || c.kind === "style") {
          const e = doc.createElement(c.kind === "inline" ? "script" : "style");
          if (c.nonce) e.nonce = c.nonce;
          e.textContent = c.source;
          doc.head.append(e);
          await new Promise((r) => setTimeout(r, 5));
          native =
            c.kind === "inline"
              ? win.__ran === true
              : win.getComputedStyle(doc.body).color === "rgb(1, 2, 3)";
        } else if (c.kind === "attribute") {
          doc.body.setAttribute("style", c.source);
          native = win.getComputedStyle(doc.body).color === "rgb(1, 2, 3)";
        } else if (c.kind === "eval") {
          win.Function("window.__ran=true")();
          native = win.__ran === true;
        } else if (c.kind === "wasm") {
          new win.WebAssembly.Module(
            new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
          );
          native = true;
        } else if (c.kind === "connect") {
          native = (await win.fetch(c.url)).ok;
        } else if (c.kind === "image") {
          const image = doc.createElement("img");
          native = await new Promise((resolve) => {
            image.onload = () => resolve(image.naturalWidth === 1);
            image.onerror = () => resolve(false);
            image.src = c.url;
            doc.body.append(image);
          });
        } else if (c.kind === "worker") {
          native = await new Promise((resolve) => {
            let worker;
            const timer = setTimeout(() => {
              worker?.terminate();
              resolve(false);
            }, 1000);
            try {
              worker = new win.Worker(c.url);
              worker.onmessage = (e) => {
                clearTimeout(timer);
                worker.terminate();
                resolve(e.data === true);
              };
              worker.onerror = () => {
                clearTimeout(timer);
                worker.terminate();
                resolve(false);
              };
            } catch {
              clearTimeout(timer);
              resolve(false);
            }
          });
        } else if (c.kind === "frame") {
          native = await new Promise((resolve) => {
            const child = doc.createElement("iframe"),
              timer = setTimeout(() => resolve(false), 1000);
            child.onload = () => {
              clearTimeout(timer);
              try {
                resolve(
                  !!child.contentDocument?.getElementById("nested-marker"),
                );
              } catch {
                resolve(false);
              }
            };
            child.src = c.url;
            doc.body.append(child);
          });
        } else if (c.kind === "media") {
          native = await new Promise((resolve) => {
            const media = doc.createElement("audio"),
              timer = setTimeout(() => resolve(false), 1000);
            media.onloadedmetadata = () => {
              clearTimeout(timer);
              resolve(media.duration > 0);
            };
            media.onerror = () => {
              clearTimeout(timer);
              resolve(false);
            };
            media.preload = "metadata";
            media.src = c.url;
            doc.body.append(media);
          });
        } else if (c.kind === "base") {
          const base = doc.createElement("base");
          base.href = c.url;
          doc.head.append(base);
          native = doc.baseURI === c.url;
        } else {
          const s = doc.createElement("script");
          native = await new Promise((r) => {
            s.onload = () => r(true);
            s.onerror = () => r(false);
            s.src = c.url;
            doc.head.append(s);
          });
        }
      } catch {}
      try {
        const p = createOriginalDocumentPolicy({
          documentURL: win.location.href,
          contentPolicies: c.policies,
        });
        if (c.kind === "inline" || c.kind === "style")
          await p.authorizeInline({
            kind: c.kind === "inline" ? "script" : "style",
            source: c.source,
            nonce: c.nonce,
          });
        else if (c.kind === "attribute") p.authorizeStyleAttribute(c.source);
        else if (c.kind === "eval" || c.kind === "wasm")
          p.checkEval(c.kind === "eval" ? "javascript" : "wasm");
        else p.checkURL({ kind: c.kind, url: c.url });
        predicted = true;
      } catch {}
      records.push({
        name: c.name,
        native,
        predicted,
        match: native === predicted,
      });
      frame.remove();
    }
    const original = "window.approved = 1;",
      digest = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(original),
          ),
        ),
      ],
      hash = btoa(String.fromCharCode(...digest)),
      p = createOriginalDocumentPolicy({
        documentURL: "https://website.test/",
        contentPolicies: [
          "default-src 'none';script-src 'self' 'sha256-" +
            hash +
            "';style-src 'none';img-src 'self'",
        ],
      }),
      plan = createOriginalDocumentPlan({
        documentURL: "https://website.test/",
        policy: p,
      });
    const authorized = await plan.prepare(
        '<head><meta http-equiv="Content-Security-Policy" content="default-src none"><script>' +
          original +
          '</script><script>window.denied=1</script><style>body{color:red}</style></head><body style="color:red"><img src="https://other.test/x"><script src="/allowed.js"></script></body>',
      ),
      parsed = new DOMParser().parseFromString(authorized.html, "text/html");
    const unsupported = [];
    for (const html of [
      '<button onclick="x()">x</button>',
      '<iframe src="https://other.test/"></iframe>',
      '<object data="https://other.test/"></object>',
      '<script runtimekit-attr-src="https://other.test/" src="/allowed.js"></script>',
    ]) {
      try {
        await plan.prepare(html);
        unsupported.push("MISSED");
      } catch (e) {
        unsupported.push(e.code);
      }
    }
    const controller = new AbortController();
    // Forms are now a supported, privately brokered navigation path; the
    // original plan must retain them, not classify them as unsupported markup.
    // Submission authority/serialization is tested by the form broker suite.
    const preparedForm = await plan.prepare(
      '<form action="/"><input name="q"></form>',
    );
    const formPrepared = !!new DOMParser()
      .parseFromString(preparedForm.html, "text/html")
      .querySelector('form input[name="q"]');
    controller.abort();
    let aborted = false;
    try {
      await plan.prepare("<p>x</p>", controller.signal);
    } catch (e) {
      aborted = e.code === "original_plan_aborted";
    }
    return {
      cases: records.length,
      passed: records.filter((r) => r.match).length,
      records,
      plan: {
        requiresPhysicalEnforcement: authorized.requiresPhysicalEnforcement,
        allowed: authorized.decisions.filter((r) => r.allowed).length,
        blocked: authorized.decisions.filter((r) => !r.allowed).length,
        metasRemoved: !parsed.querySelector("meta[http-equiv]"),
        blockedScript: parsed.querySelectorAll(
          'script[type="application/x-atlas-csp-blocked"]',
        ).length,
        styleAttributeRemoved: !parsed.body.hasAttribute("style"),
        imageSourceRemoved: !parsed.querySelector("img").hasAttribute("src"),
        exactOriginal:
          authorized.decisions.find((r) => r.source === original)?.receipt
            .source === original,
        unsupported,
        formPrepared,
        aborted,
      },
    };
  }, cases);
  const e = "evidence/combined-update-20261015/original-document-policy";
  fs.mkdirSync(e, { recursive: true });
  fs.writeFileSync(
    e + "/native-comparison.json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failed: result.records.filter((r) => !r.match),
      plan: result.plan,
    }),
  );
  assert.equal(result.passed, result.cases);
  assert.deepEqual(result.plan, {
    requiresPhysicalEnforcement: true,
    allowed: 2,
    blocked: 4,
    metasRemoved: true,
    blockedScript: 1,
    styleAttributeRemoved: true,
    imageSourceRemoved: true,
    exactOriginal: true,
    unsupported: [
      "original_plan_handler_unsupported",
      "original_plan_unsupported_element",
      "original_plan_unsupported_element",
      "original_plan_reserved_attribute",
    ],
    formPrepared: true,
    aborted: true,
  });
} finally {
  await browser?.close();
  await app.close();
}
