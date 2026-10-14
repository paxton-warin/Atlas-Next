#!/usr/bin/env node
// Explicit, logged-out qualification only; no HAR, cookies or authenticated browser state.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const url = "https://cdn.platform.openai.com/deployments/dil/v14/runner.html";
const response = await fetch(url, {
  credentials: "omit",
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
if (
  response.status !== 200 ||
  !response.headers.get("content-type")?.startsWith("text/html")
)
  throw Error("Public renderer response not qualified");
const reader = response.body.getReader();
const chunks = [];
let size = 0;
try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256000) throw Error("Public renderer exceeds fixture limit");
    chunks.push(Buffer.from(value));
  }
} finally {
  await reader.cancel().catch(() => {});
}
const html = Buffer.concat(chunks);
const output = "evidence/goal-compatibility-20261013/renderer-public.html";
mkdirSync("evidence/goal-compatibility-20261013", { recursive: true });
writeFileSync(output, html);
console.log(
  JSON.stringify({
    status: response.status,
    bytes: html.length,
    sha256: createHash("sha256").update(html).digest("hex"),
    output,
  }),
);
