/** One combined-release switch. Merely deploying assets or node capabilities
 * does not opt users into an unfinished frontend runtime. No migration/wipe. */
import { resolve } from "node:path";
export function opaqueRuntimeSettings(env = process.env, cwd = process.cwd()) {
  const mode = env.ATLAS_BROWSER_RUNTIME || "held";
  if (!["held", "opaque-v2", "same-origin", "same-origin-profile"].includes(mode))
    throw Error("ATLAS_BROWSER_RUNTIME must be held, opaque-v2, same-origin or same-origin-profile.");
  const active = mode === "opaque-v2";
  const profile = mode === "same-origin-profile";
  if ((active || profile) && env.LOCAL_RELAY_MODE !== "frontend")
    throw Error(
      profile
        ? "The same-origin profile runtime requires LOCAL_RELAY_MODE=frontend."
        : "The combined opaque runtime requires LOCAL_RELAY_MODE=frontend.",
    );
  return Object.freeze({
    opaqueRuntimeEnabled: active,
    opaqueRuntimeActivated: active,
    opaqueAssetsDir: active
      ? resolve(cwd, env.OPAQUE_ASSETS_DIR || "dist/opaque-runtime")
      : null,
    ...(profile ? {
      profileRuntimeEnabled: true,
      profileRuntimeActivated: true,
      profileRuntimeEngine: "scramjet-controller",
      profileAssetsDir: resolve(cwd, env.OPAQUE_ASSETS_DIR || "dist/opaque-runtime"),
    } : {}),
    ...(mode === "same-origin" || profile ? {
      sameOriginRuntime: true,
      runtimePath: "/browse/runtime/",
      runtimeAssetsDir: resolve(cwd, "dist/runtime"),
    } : {}),
  });
}
