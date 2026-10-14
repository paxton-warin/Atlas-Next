#!/usr/bin/env node
// Local-only, allowlisted summary. Never output header values, cookies, queries,
// tickets, request bodies, conversation text, or raw upstream response bodies.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
function destination(raw) {
  try {
    const url = new URL(raw);
    const part = url.pathname.match(/\/~\/app\/[^/]+\/[^/]+\/(.+)$/)?.[1];
    if (!part) return url;
    if (part.startsWith("v1."))
      return new URL(Buffer.from(part.slice(3), "base64url").toString("utf8"));
    return new URL(decodeURIComponent(part));
  } catch {
    return null;
  }
}
export function summarizeHar(har) {
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw Error("HAR entries required");
  const statuses = {},
    streams = [],
    renderer = [];
  for (const entry of entries) {
    const status = Number(entry.response?.status) || 0;
    statuses[status] = (statuses[status] || 0) + 1;
    const url = destination(entry.request?.url);
    if (!url) continue;
    if (
      url.hostname === "cdn.platform.openai.com" &&
      /^\/deployments\/dil\/[^/]+\/runner\.html$/.test(url.pathname)
    )
      renderer.push({
        status,
        mime: String(entry.response?.content?.mimeType || "").split(";")[0],
        bodySize: Number(entry.response?.content?.size) || 0,
        workerTimingsPresent: Number(entry.timings?._workerStart) >= 0,
      });
    if (
      url.hostname !== "chatgpt.com" ||
      !/\/conversation(?:\/|$)/.test(url.pathname) ||
      entry.response?.content?.mimeType?.split(";")[0] !== "text/event-stream"
    )
      continue;
    let assistantEnvelopes = 0,
      assistantTextCharacters = 0,
      appendEvents = 0,
      completed = false;
    const content = entry.response.content;
    const text =
      content.encoding === "base64"
        ? Buffer.from(content.text || "", "base64").toString("utf8")
        : content.text || "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") {
        completed = true;
        continue;
      }
      try {
        const event = JSON.parse(raw);
        const message = event.message || event.v?.message;
        if (message?.author?.role === "assistant") {
          assistantEnvelopes++;
          assistantTextCharacters += (message.content?.parts || [])
            .filter((x) => typeof x === "string")
            .reduce((n, x) => n + x.length, 0);
        }
        if (
          event.o === "append" ||
          (Array.isArray(event.v) && event.v.some((x) => x.o === "append"))
        )
          appendEvents++;
      } catch {
        /* Do not include unparsable contents. */
      }
    }
    streams.push({
      status,
      assistantEnvelopes,
      assistantTextCharacters,
      appendEvents,
      completed,
    });
  }
  return {
    version: 1,
    entries: entries.length,
    statuses,
    streams,
    renderer,
    findings: {
      assistantDataReceived: streams.some((x) => x.assistantEnvelopes > 0),
      rendererFailure: renderer.some((x) => x.status >= 500),
      exact503BodyVerified: false,
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw Error(
      "Usage: node scripts/analyze-compatibility-har.mjs INPUT.har OUTPUT.json",
    );
  const bytes = readFileSync(input);
  const report = {
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    ...summarizeHar(JSON.parse(bytes)),
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    `HAR_SUMMARY entries=${report.entries} streams=${report.streams.length} renderer=${report.renderer.length}; sensitive_fields=excluded`,
  );
}
