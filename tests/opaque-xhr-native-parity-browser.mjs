/** Independent native Chrome XHR versus document facade comparison. Native
 * fetch is used ONLY as this controlled fixture's transport, never shipped. */
import Fastify from "fastify";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const app = Fastify({ logger: false });
let browser;
const source = (
  await build({
    entryPoints: ["runtime/opaque-xhr.ts"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    platform: "browser",
    logLevel: "silent",
  })
).outputFiles[0].text;
app.get("/opaque-xhr.js", (_r, reply) =>
  reply.type("application/javascript").send(source),
);
app.get("/", (_r, reply) =>
  reply
    .type("text/html")
    .send("<!doctype html><title>Native XHR parity</title>"),
);
app.get("/data", (req, reply) => {
  const kind = req.query.kind;
  const values = {
    text: ["text/plain", "hello é"],
    json: ["application/json", '{"ok":1}'],
    badjson: ["application/json", "broken"],
    xml: ["application/xml", "<root><child/></root>"],
    html: ["text/html", "<!doctype html><title>hello</title>"],
    latin: ["text/plain;charset=windows-1252", Buffer.from([0xe9])],
    empty: ["text/plain", ""],
  };
  if (kind === "204") return reply.code(204).send();
  const [type, value] = values[kind] || values.text;
  return reply.header("x-visible", "yes").type(type).send(value);
});
app.get("/slow", async (_r, reply) => {
  await new Promise((r) => setTimeout(r, 100));
  return reply.send("late");
});
app.addContentTypeParser(
  "text/plain",
  { parseAs: "string" },
  (_r, body, done) => done(null, body),
);
app.post("/upload", (req, reply) => reply.type("text/plain").send(req.body));
app.get("/favicon.ico", (_r, reply) => reply.code(204).send());
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = "http://127.0.0.1:" + app.server.address().port;
  browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const { createOpaqueXMLHttpRequest } = await import("/opaque-xhr.js");
    const NativeXHR = XMLHttpRequest,
      nativeFetch = fetch.bind(window);
    const api = createOpaqueXMLHttpRequest({
      window,
      documentURL: () => location.href,
      fetch: nativeFetch,
      request: async (r, signal) => {
        const v = await nativeFetch(r.url, {
          method: r.method,
          headers: r.headers,
          body: r.body,
          credentials: r.credentials,
          signal,
        });
        return {
          url: v.url,
          status: v.status,
          statusText: v.statusText,
          headers: [...v.headers],
          body: await v.arrayBuffer(),
        };
      },
    });
    const run = (Ctor, c) =>
      new Promise((resolve, reject) => {
        const x = new Ctor(),
          events = [],
          states = [],
          upload = [];
        x.onreadystatechange = () => states.push(x.readyState);
        for (const t of [
          "loadstart",
          "progress",
          "load",
          "error",
          "abort",
          "timeout",
          "loadend",
        ])
          x.addEventListener(t, (e) =>
            events.push({
              type: t,
              loaded: e.loaded,
              total: e.total,
              length: e.lengthComputable,
              target: e.target === x,
            }),
          );
        for (const t of [
          "loadstart",
          "progress",
          "load",
          "error",
          "abort",
          "timeout",
          "loadend",
        ])
          x.upload.addEventListener(t, (e) =>
            upload.push({
              type: t,
              loaded: e.loaded,
              total: e.total,
              length: e.lengthComputable,
            }),
          );
        x.open(c.method || "GET", c.url);
        if (c.responseType) x.responseType = c.responseType;
        if (c.mime) x.overrideMimeType(c.mime);
        if (c.timeout) x.timeout = c.timeout;
        x.onloadend = async () => {
          try {
            const value = x.response;
            const stable = value === x.response;
            let response = value;
            if (value instanceof ArrayBuffer)
              response = [...new Uint8Array(value)];
            else if (value instanceof Blob)
              response = { text: await value.text(), type: value.type };
            else if (value instanceof Document)
              response = {
                tag: value.documentElement.tagName,
                contentType: value.contentType,
              };
            let text;
            try {
              text = x.responseText;
            } catch (e) {
              text = e.name;
            }
            let xml;
            try {
              xml = x.responseXML?.documentElement.tagName || null;
            } catch (e) {
              xml = e.name;
            }
            resolve({
              status: x.status,
              statusText: x.statusText,
              url: x.responseURL,
              readyState: x.readyState,
              states,
              events,
              upload,
              response,
              text,
              xml,
              stable,
            });
          } catch (e) {
            reject(e);
          }
        };
        x.send(c.body ?? null);
        if (c.abort) setTimeout(() => x.abort(), 5);
      });
    const cases = [
      { name: "text", url: "/data?kind=text" },
      { name: "json", url: "/data?kind=json", responseType: "json" },
      { name: "badjson", url: "/data?kind=badjson", responseType: "json" },
      {
        name: "arraybuffer",
        url: "/data?kind=text",
        responseType: "arraybuffer",
      },
      { name: "blob", url: "/data?kind=text", responseType: "blob" },
      { name: "xml", url: "/data?kind=xml", responseType: "document" },
      { name: "html", url: "/data?kind=html", responseType: "document" },
      { name: "latin", url: "/data?kind=latin" },
      {
        name: "mime",
        url: "/data?kind=latin",
        mime: "text/plain;charset=windows-1252",
      },
      { name: "empty", url: "/data?kind=empty" },
      { name: "204", url: "/data?kind=204" },
      { name: "post", url: "/upload", method: "POST", body: "uploaded é" },
      { name: "timeout", url: "/slow", timeout: 10 },
      { name: "abort", url: "/slow", abort: true },
    ];
    const records = [];
    for (const c of cases) {
      const native = await run(NativeXHR, c),
        facade = await run(api.XMLHttpRequest, c);
      records.push({
        name: c.name,
        native,
        facade,
        match: JSON.stringify(native) === JSON.stringify(facade),
      });
    }
    api.dispose();
    return {
      cases: records.length,
      passed: records.filter((r) => r.match).length,
      failed: records.filter((r) => !r.match).length,
      records,
    };
  });
  result.inlineJSONIdentity = await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.__nativeJSONProbeDone = resolve;
        const script = document.createElement("script");
        script.textContent = `(()=>{const x=new XMLHttpRequest();x.open('GET','/data?kind=json');x.responseType='json';x.onload=()=>{const a=x.response;window.__nativeJSONProbeDone({consecutive:x.response===x.response,held:a===x.response,content:a})};x.send()})()`;
        document.head.append(script);
      }),
  );
  const dir = new URL(
    "../evidence/combined-update-20261015/opaque-xhr-websocket/",
    import.meta.url,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    new URL("xhr-native-parity.json", dir),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failed: result.failed,
      mismatches: result.records.filter((r) => !r.match).map((r) => r.name),
    }),
  );
  assert.equal(
    result.failed,
    0,
    "native XHR shape mismatch (inspect evidence)",
  );
} finally {
  await browser?.close();
  await app.close();
}
