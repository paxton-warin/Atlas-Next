/** Versioned, reproducible assets for private combined-runtime qualification.
 * Producing assets does NOT activate the public runtime or mutate the vendor pin.
 */
import { createRequire } from "node:module";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import {
  adaptPinnedRuntimeBundle,
  OPAQUE_CORE_SOURCE_HASH,
} from "./opaque-runtime-core.mjs";
import {
  adaptPinnedHttpEngine,
  OPAQUE_HTTPENGINE_SOURCE_SHA256,
} from "./opaque-httpengine.mjs";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const sha = (v) => createHash("sha256").update(v).digest("hex");
export async function buildOpaqueRuntime({
  outdir = resolve("dist/opaque-runtime"),
} = {}) {
  const pin = JSON.parse(await readFile("scripts/runtime-fork.json", "utf8"));
  const original = await readFile(
      "runtime/public/runtime/runtimekit.js",
      "utf8",
    ),
    core = adaptPinnedRuntimeBundle(original),
    wasm = await readFile("runtime/public/runtime/runtimekit.wasm");
  if (sha(wasm) !== pin.assets["runtimekit.wasm"].sha256)
    throw Error("Opaque rewriter Wasm source hash mismatch");
  const staged = outdir + ".staged-" + process.pid;
  await rm(staged, { force: true, recursive: true });
  await mkdir(staged, { recursive: true });
  try {
    const common = {
      bundle: true,
      absWorkingDir: resolve("."),
      target: "es2022",
      platform: "browser",
      minify: true,
      sourcemap: false,
      logLevel: "silent",
      legalComments: "inline",
    };
    const workerBundle = await build({
      ...common,
      write: false,
      format: "iife",
      entryPoints: ["runtime/opaque-worker-entry.ts"],
    });
    const workerBytes = Buffer.from(
        core + "\n" + workerBundle.outputFiles[0].text,
      ),
      dedicatedWorker = "dedicated-" + sha(workerBytes).slice(0, 16) + ".js";
    await writeFile(join(staged, dedicatedWorker), workerBytes);
    const document = await build({
      ...common,
      write: false,
      format: "iife",
      globalName: "AtlasOpaqueDocument",
      define: {
        __OPAQUE_WORKER_BOOTSTRAP__: JSON.stringify(
          workerBytes.toString("utf8"),
        ),
      },
      entryPoints: ["runtime/opaque-document.ts"],
    });
    const entry = Buffer.from(
      core +
        "\n" +
        document.outputFiles[0].text +
        "\nAtlasOpaqueDocument.installOpaqueDocument({global:window,core:self.$runtimekit,wasm:Uint8Array.from(atob(" +
        JSON.stringify(wasm.toString("base64")) +
        "),c=>c.charCodeAt(0))});\n",
    );
    const bootstrap = "document-" + sha(entry).slice(0, 16) + ".js";
    await writeFile(join(staged, bootstrap), entry);
    const trusted = await build({
      ...common,
      write: false,
      format: "iife",
      globalName: "AtlasFrontendRewriter",
      entryPoints: ["runtime/frontend-rewriter.ts"],
    });
    const trustedBytes = Buffer.from(
      core +
        "\n" +
        trusted.outputFiles[0].text +
        "\nexport function createFrontendResourceRewriter(options){return AtlasFrontendRewriter.createFrontendResourceRewriter({...options,core:self.$runtimekit,wasm:Uint8Array.from(atob(" +
        JSON.stringify(wasm.toString("base64")) +
        "),c=>c.charCodeAt(0))})}\n",
    );
    const trustedFile = "rewriter-" + sha(trustedBytes).slice(0, 16) + ".js";
    await writeFile(join(staged, trustedFile), trustedBytes);
    const originalEngine = await readFile(
      // The held opaque adapter has its own independently qualified source
      // seam; do not feed it the active full-runtime credential adaptation.
      join(pin.directory, "app/vendor/httpengine-client.js"),
    );
    if (
      sha(originalEngine) !== pin.assets["httpengine-client.js"].sha256 ||
      sha(originalEngine) !== OPAQUE_HTTPENGINE_SOURCE_SHA256
    )
      throw Error("Opaque relay engine source hash mismatch");
    // Only this qualification asset is adapted. The vendor source and its
    // declared runtime pin stay byte-identical; native close-send code is
    // exported from the existing Wasm, never replaced by a synthetic ACK.
    const engine = Buffer.from(
      adaptPinnedHttpEngine(originalEngine.toString("utf8")),
    );
    const engineFile = "httpengine-" + sha(engine).slice(0, 16) + ".js";
    await writeFile(join(staged, engineFile), engine);
    const workers = {};
    for (const [name, source] of Object.entries({
      storage: "sandbox-storage-worker",
      cookies: "sandbox-cookie-worker",
      relay: "sandbox-relay-worker",
    })) {
      const result = await build({
        ...common,
        write: false,
        format: "esm",
        define: {
          __OPAQUE_HTTPENGINE_ASSET__: JSON.stringify(
            "/browse/assets/" + engineFile,
          ),
        },
        entryPoints: ["runtime/" + source + ".ts"],
      });
      const bytes = result.outputFiles[0].contents,
        filename = name + "-" + sha(bytes).slice(0, 16) + ".js";
      await writeFile(join(staged, filename), bytes);
      workers[name] = filename;
    }
    const files = {};
    for (const file of await readdir(staged))
      files[file] = { sha256: sha(await readFile(join(staged, file))) };
    const manifest = {
      version: 2,
      activated: false,
      pin: pin.commit,
      coreSourceSHA256: OPAQUE_CORE_SOURCE_HASH,
      adaptedCoreSHA256: sha(core),
      engineSourceSHA256: OPAQUE_HTTPENGINE_SOURCE_SHA256,
      adaptedEngineSHA256: sha(engine),
      bootstrap,
      dedicatedWorker,
      trustedRewriter: trustedFile,
      workers,
      engine: engineFile,
      files,
    };
    await writeFile(
      join(staged, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // A failed build leaves the previous complete asset set untouched.
    const previous = outdir + ".previous-" + process.pid;
    await rm(previous, { force: true, recursive: true });
    try {
      await rename(outdir, previous);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      await rename(staged, outdir);
    } catch (e) {
      try {
        await rename(previous, outdir);
      } catch {}
      throw e;
    }
    await rm(previous, { force: true, recursive: true });
    return manifest;
  } finally {
    await rm(staged, { force: true, recursive: true });
  }
}
if (
  process.argv[1] &&
  basename(process.argv[1]) === "build-opaque-runtime.mjs"
) {
  const manifest = await buildOpaqueRuntime();
  console.log(
    `OPAQUE_ASSETS=${Object.keys(manifest.files).length}; VERSION=${manifest.version}; ACTIVATED=false; CORE_SOURCE=${manifest.coreSourceSHA256}`,
  );
}
