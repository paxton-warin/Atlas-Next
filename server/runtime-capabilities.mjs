/** Transport support is not frontend runtime activation. A node can accept the
 * new controller tickets while the combined opaque website runtime stays held. */
export const FRONTEND_CONTROLLER_RELAY_V2 = "frontend-controller-relay-v2";
export const LEGACY_FRONTEND_RELAY_V1 = "frontend-relay-v1";
export const FRONTEND_NATIVE_RESOURCES_V1 = "frontend-native-resources-v1";
export const OPAQUE_CORE_SOURCE_SHA256 =
  "cc87e1fd09550a2dc7a9b89f28ed8da84cf7d2be0fa9cdecdd20f3ed44619ca1";
export const OPAQUE_HTTPENGINE_SOURCE_SHA256 =
  "f2a17fa85d71f8a82990650dcf16ba952a86cb90dec1acb1c07413f11d0a94e4";
export const NODE_RUNTIME_CAPABILITIES = Object.freeze([
  LEGACY_FRONTEND_RELAY_V1,
  FRONTEND_CONTROLLER_RELAY_V2,
  FRONTEND_NATIVE_RESOURCES_V1,
]);
export const OPAQUE_RUNTIME_PROTOCOL = Object.freeze({
  version: 2,
  requiredNodeCapabilities: Object.freeze([
    FRONTEND_CONTROLLER_RELAY_V2,
    FRONTEND_NATIVE_RESOURCES_V1,
  ]),
  network: "atlas-network-v2",
  relayWorker: "atlas-relay-worker-v1",
  storageDatabase: "atlas.browsing.v2",
  cookies: "atlas-cookies-v2",
  documentBinding: 2,
  indexedDB: "atlas-idb-v1",
  activated: false,
});
export function acceptedNodeCapabilities(value) {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((capability) =>
            NODE_RUNTIME_CAPABILITIES.includes(capability),
          ),
        ),
      ]
    : [];
}
