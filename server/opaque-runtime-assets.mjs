/** Exact manifest allowlist; never serve arbitrary files or private frontend
 * state to an opaque document. Loaded only by the explicit qualification seam. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installSandboxFramePrototype } from "./sandbox-frame.mjs";
import {
  OPAQUE_CORE_SOURCE_SHA256,
  OPAQUE_HTTPENGINE_SOURCE_SHA256,
} from "./runtime-capabilities.mjs";
const sha = (v) => createHash("sha256").update(v).digest("hex");
export function installOpaqueRuntimeAssets(
  app,
  { directory, originFor, relayOrigins = () => [], nativeResourceOrigin, rendererHelperPrefix },
) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.version !== 2 ||
    manifest.activated !== false ||
    manifest.coreSourceSHA256 !== OPAQUE_CORE_SOURCE_SHA256 ||
    manifest.engineSourceSHA256 !== OPAQUE_HTTPENGINE_SOURCE_SHA256 ||
    !/^[a-f0-9]{64}$/.test(manifest.adaptedEngineSHA256) ||
    !/^[a-f0-9]{64}$/.test(manifest.adaptedCoreSHA256) ||
    !/^document-[a-f0-9]{16}\.js$/.test(manifest.bootstrap) ||
    !manifest.files ||
    Object.keys(manifest.files).length !== 7 ||
    !/^dedicated-[a-f0-9]{16}\.js$/.test(manifest.dedicatedWorker)
  )
    throw Error("Invalid opaque runtime manifest");
  const assets = new Map();
  for (const [name, metadata] of Object.entries(manifest.files)) {
    if (
      !/^(?:document|dedicated|storage|cookies|relay|httpengine|rewriter)-[a-f0-9]{16}\.js$/.test(
        name,
      ) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)
    )
      throw Error("Invalid opaque runtime asset");
    const bytes = readFileSync(join(directory, name));
    if (
      bytes.length > 16 * 1024 * 1024 ||
      sha(bytes) !== metadata.sha256 ||
      !name.includes(metadata.sha256.slice(0, 16))
    )
      throw Error("Opaque runtime asset hash mismatch");
    assets.set(name, bytes);
  }
  if (
    !assets.has(manifest.bootstrap) ||
    !assets.has(manifest.dedicatedWorker) ||
    !assets.has(manifest.engine) ||
    !assets.has(manifest.trustedRewriter) ||
    !manifest.trustedRewriter.startsWith("rewriter-") ||
    !manifest.engine.startsWith("httpengine-") ||
    manifest.files[manifest.engine]?.sha256 !== manifest.adaptedEngineSHA256 ||
    !["storage", "cookies", "relay"].every(
      (kind) =>
        assets.has(manifest.workers?.[kind]) &&
        manifest.workers[kind].startsWith(kind + "-"),
    )
  )
    throw Error("Incomplete opaque runtime assets");
  app.get("/browse/assets/:name", (req, reply) => {
    const bytes = assets.get(req.params.name);
    if (!bytes) return reply.code(404).send();
    const dynamicRelayPolicy = req.params.name.startsWith("relay-");
    const relays = (dynamicRelayPolicy ? relayOrigins(req) : []).map((raw) => {
      const url = new URL(raw);
      if (!/^https?:$/.test(url.protocol) || url.href !== url.origin + "/")
        throw Error("Invalid trusted relay origin");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.origin;
    });
    return (
      reply
        // The relay worker's CSP depends on the attached-node roster, not just
        // script bytes. Never retain a year-old roster under a content-only hash.
        .header(
          "Cache-Control",
          dynamicRelayPolicy
            ? "no-store"
            : "public, max-age=31536000, immutable",
        )
        .header(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${relays.join(" ")}`,
        )
        .header("Access-Control-Allow-Origin", "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("X-Content-Type-Options", "nosniff")
        .type("application/javascript; charset=utf-8")
        .send(bytes)
    );
  });
  installSandboxFramePrototype(app, {
    capabilities: true,
    bootstrapURL: (req) =>
      new URL("/browse/assets/" + manifest.bootstrap, originFor(req)).href,
    storageEndpointOrigin: originFor,
    cookieEndpointOrigin: originFor,
    nativeResourceOrigin,
    rendererHelperPrefix,
  });
  return Object.freeze({
    version: 2,
    bootstrap: "/browse/assets/" + manifest.bootstrap,
    trustedRewriter: "/browse/assets/" + manifest.trustedRewriter,
    workers: Object.fromEntries(
      Object.entries(manifest.workers).map(([name, file]) => [
        name,
        "/browse/assets/" + file,
      ]),
    ),
  });
}
