/** One combined-release switch. Merely deploying assets or node capabilities
 * does not opt users into an unfinished frontend runtime. No migration/wipe. */
import { resolve } from "node:path";
export function opaqueRuntimeSettings(env = process.env, cwd = process.cwd()) {
  const mode = env.ATLAS_BROWSER_RUNTIME || "held";
  if (!["held", "opaque-v2", "same-origin"].includes(mode))
    throw Error("ATLAS_BROWSER_RUNTIME must be held, opaque-v2 or same-origin.");
  const active = mode === "opaque-v2";
  if (active && env.LOCAL_RELAY_MODE !== "frontend")
    throw Error(
      "The combined opaque runtime requires LOCAL_RELAY_MODE=frontend.",
    );
  return Object.freeze({
    opaqueRuntimeEnabled: active,
    opaqueRuntimeActivated: active,
    opaqueAssetsDir: active
      ? resolve(cwd, env.OPAQUE_ASSETS_DIR || "dist/opaque-runtime")
      : null,
    ...(mode === "same-origin" ? {
      sameOriginRuntime: true,
      runtimePath: "/browse/runtime/",
      runtimeAssetsDir: resolve(cwd, "dist/runtime"),
    } : {}),
  });
}
