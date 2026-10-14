#!/usr/bin/env node
// Offline data-only audit. Does not install or execute extension code.
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, join, extname, dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
export function csvRows(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (c === "\n" && !quoted) {
      row.push(field.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw Error("Unclosed CSV quote");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift();
  return rows.map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, r[i] || ""])),
  );
}
export function category(row) {
  if (
    /quick signatures|runtime$|transport fingerprinting|obfuscated resource/i.test(
      row.family,
    )
  )
    return "engine-signature";
  if (/utilities|utility/i.test(row.family)) return "ordinary-utility";
  if (/game|AI chat/i.test(row.family)) return "destination-content";
  return "contextual-heuristic";
}
export function compileLiteral(literal) {
  const end = literal.lastIndexOf("/");
  if (!literal.startsWith("/") || end < 1) throw Error("Invalid literal");
  return new RegExp(literal.slice(1, end), literal.slice(end + 1));
}
async function scan(row, surfaces) {
  return new Promise((resolveScan) => {
    let done = false;
    const worker = new Worker(
      new URL("./fingerprint-scan-worker.mjs", import.meta.url),
      {
        workerData: { literal: row.regex_literal, surfaces },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    );
    const end = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolveScan(result);
    };
    const timer = setTimeout(() => end({ status: "timeout", hits: [] }), 750);
    worker.once("message", (hits) => end({ status: "scanned", hits }));
    worker.once("error", () => end({ status: "error", hits: [] }));
    worker.once("exit", () => {
      if (!done) end({ status: "error", hits: [] });
    });
  });
}
export async function audit(roots) {
  const surfaces = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "source" || name === "node_modules") continue;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (
        [".js", ".html", ".wasm"].includes(extname(path)) &&
        stat.size <= 8 * 1024 * 1024
      ) {
        const text = readFileSync(path).toString(
          extname(path) === ".wasm" ? "latin1" : "utf8",
        );
        surfaces.push({
          file: path,
          surface:
            extname(path) === ".wasm"
              ? "wasm-bytes"
              : extname(path) === ".html"
                ? "html-source"
                : "script-text",
          text,
        });
        surfaces.push({
          file: path,
          surface: "resource-path",
          text: "/" + path.replaceAll("\\", "/"),
        });
      }
    }
  }
  for (const root of roots) if (existsSync(root)) walk(root);
  return auditSurfaces(surfaces);
}
export async function auditSurfaces(surfaces) {
  const rows = csvRows(
    readFileSync(
      new URL("./audit-data/regex-inventory.csv", import.meta.url),
      "utf8",
    ),
  );
  const rules = [];
  for (const row of rows) {
    compileLiteral(row.regex_literal);
    rules.push({
      id: row.id,
      category: category(row),
      family: row.family,
      pattern: row.regex_literal,
      ...(await scan(row, surfaces)),
    });
  }
  return {
    version: 1,
    inventory: rows.length,
    surfaces: surfaces.length,
    method: "regex surface scan; not a live classifier verdict",
    imageCanvasClassification: "not evaluated",
    rules,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output =
    process.argv[2] || "evidence/client-compatibility-20261013/audit.json";
  const roots = process.argv.slice(3);
  const result = await audit(
    roots.length ? roots : ["dist/runtime", "dist/web"],
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      inventory: result.inventory,
      surfaces: result.surfaces,
      matched: result.rules.filter((r) => r.hits.length).length,
      timeouts: result.rules.filter((r) => r.status !== "scanned").length,
      output,
    }),
  );
}
