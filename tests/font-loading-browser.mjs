import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import Fastify from "fastify";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2),
  option = (name, fallback) =>
    args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1) ??
    fallback,
  root = resolve("evidence/local-first-backups-20261028/font-fix"),
  families = ["Inter", "Inter Tight", "Lora", "JetBrains Mono"],
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(root, { recursive: true });
const report = {
  command: "node tests/font-loading-browser.mjs " + args.join(" "),
  productionChanged: false,
  scenarios: [],
};
let browser, app;
async function inspect(url, label, expectLoaded) {
  const context = await browser.newContext(),
    page = await context.newPage(),
    requests = [];
  page.on("response", (response) => {
    if (/\/fonts(?:\.css|\/)/.test(response.url()))
      requests.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        type: response.headers()["content-type"],
      });
  });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    const rendered = await page.evaluate(async (families) => {
      const sample = "Atlas AgMWi 0123456789 abcdef";
      for (let i = 0; i < families.length; i++) {
        const span = document.createElement("span");
        span.id = "font-proof-" + i;
        span.textContent = sample;
        span.style.cssText =
          "display:block;width:max-content;font-size:24px;font-weight:400;line-height:1.5;font-family:" +
          JSON.stringify(families[i]) +
          ",sans-serif";
        document.body.append(span);
        await document.fonts.load(
          "24px " + JSON.stringify(families[i]),
          sample,
        );
      }
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return {
        faces: [...document.fonts].map((face) => ({
          family: face.family,
          status: face.status,
        })),
        measurements: families.map((family, i) => ({
          family,
          width: document
            .getElementById("font-proof-" + i)
            .getBoundingClientRect().width,
          computedFamily: getComputedStyle(
            document.getElementById("font-proof-" + i),
          ).fontFamily,
        })),
        stylesheets: [...document.styleSheets].map((sheet) => sheet.href),
      };
    }, families);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root: doc } = await cdp.send("DOM.getDocument");
    const platformFonts = [];
    for (let i = 0; i < families.length; i++) {
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: doc.nodeId,
        selector: "#font-proof-" + i,
      });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", {
        nodeId,
      });
      platformFonts.push({ requested: families[i], fonts });
    }
    const result = {
      label,
      url,
      expected: expectLoaded ? "loaded" : "missing",
      ...rendered,
      platformFonts,
      requests,
    };
    report.scenarios.push(result);
    for (let i = 0; i < families.length; i++) {
      assert.ok(
        rendered.measurements[i].width > 0,
        "rendered width must be positive",
      );
      assert.equal(
        platformFonts[i].fonts.some(
          (font) => font.isCustomFont && font.glyphCount > 0,
        ),
        expectLoaded,
        families[i] + " actual platform font",
      );
      assert.equal(
        rendered.faces.some(
          (face) => face.family === families[i] && face.status === "loaded",
        ),
        expectLoaded,
        families[i] + " registered loaded face",
      );
    }
    result.result = "PASS";
    await page.screenshot({
      path: resolve(root, label + ".png"),
      fullPage: true,
    });
    console.log(
      "FONT_LOADING " +
        label.toUpperCase() +
        " PASS " +
        (expectLoaded
          ? "4/4 loaded custom platform fonts"
          : "4/4 fallback; zero registered custom faces"),
    );
  } finally {
    await context.close();
  }
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  report.browser = browser.version();
  const remote = option("--url");
  if (remote)
    await inspect(
      remote,
      option("--label", "live"),
      option("--expect", "loaded") === "loaded",
    );
  else {
    const original = await readFile(resolve(root, "original/index.html")),
      modified = await readFile(resolve("web/index.html"));
    await mkdir(resolve(root, "rollback-copy"), { recursive: true });
    await copyFile(
      resolve("web/index.html"),
      resolve(root, "rollback-copy/index.html"),
    );
    await copyFile(
      resolve(root, "original/index.html"),
      resolve(root, "rollback-copy/index.html"),
    );
    const rollback = await readFile(resolve(root, "rollback-copy/index.html"));
    assert.equal(hash(rollback), hash(original));
    report.sourceHashes = {
      baseline: hash(original),
      modified: hash(modified),
      rollback: hash(rollback),
    };
    assert.notEqual(hash(original), hash(modified));
    const html = { baseline: original, modified, rollback };
    app = Fastify({ logger: false });
    for (const [label, contents] of Object.entries(html))
      app.get("/" + label, (_q, reply) =>
        reply.type("text/html").send(contents),
      );
    // The exact source HTML and links are retained; unrelated application startup
    // is omitted from this focused font fixture, not replaced by injected faces.
    app.get("/src/main.tsx", (_q, reply) =>
      reply.type("application/javascript").send(""),
    );
    app.get("/fonts.css", async (_q, reply) =>
      reply
        .type("text/css")
        .send(await readFile(resolve("web/public/fonts.css"))),
    );
    app.get("/fonts/*", async (q, reply) => {
      const path = resolve("web/public/fonts", q.params["*"]);
      if (!path.startsWith(resolve("web/public/fonts") + "/"))
        return reply.code(404).send();
      return reply
        .type(extname(path) === ".woff2" ? "font/woff2" : "text/plain")
        .send(await readFile(path));
    });
    app.get("/favicon.svg", (_q, reply) =>
      reply
        .type("image/svg+xml")
        .send("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    );
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    await inspect(base + "/baseline", "baseline", false);
    await inspect(base + "/modified", "modified", true);
    await inspect(base + "/rollback", "rollback", false);
    assert.equal(
      hash(await readFile(resolve("web/index.html"))),
      hash(modified),
      "working modified source must remain changed",
    );
  }
  report.result = "PASS";
} catch (error) {
  report.result = "FAIL";
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  const name = option("--label", option("--url") ? "live" : "local-three-way");
  await writeFile(
    resolve(root, name + ".json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
  await app?.close();
}
