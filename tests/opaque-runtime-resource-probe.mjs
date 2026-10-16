import http from "node:http";
import { chromium } from "@playwright/test";
const server = http.createServer((_request, reply) =>
  reply.end("<!doctype html><title>Blob resource boundary</title>"),
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(async () => {
    const js = URL.createObjectURL(
      new Blob(['parent.postMessage({js:true},"*")'], {
        type: "application/javascript",
      }),
    );
    const img = URL.createObjectURL(
      new Blob(
        ['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'],
        { type: "image/svg+xml" },
      ),
    );
    return await new Promise((resolve) => {
      const result = {};
      const frame = document.createElement("iframe");
      frame.sandbox = "allow-scripts";
      frame.srcdoc = `<img src="${img}" onload="parent.postMessage({img:true},'*')" onerror="parent.postMessage({img:false},'*')"><script src="${js}" onerror="parent.postMessage({js:false},'*')"></script><script>fetch('${js}').then(r=>parent.postMessage({fetch:r.type},'*')).catch(e=>parent.postMessage({fetch:e.message},'*'))</script>`;
      addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        Object.assign(result, event.data);
        if (Object.keys(result).length === 3) resolve(result);
      });
      document.body.append(frame);
      setTimeout(() => resolve(result), 2000);
    });
  });
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
