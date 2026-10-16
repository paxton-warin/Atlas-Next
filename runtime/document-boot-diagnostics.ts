/** Fixed metadata only. Never forward exception messages, URLs, stack traces,
 * headers, resource bytes or website-selected arbitrary error strings. */
const stages = new Set([
  "storage",
  "cookies",
  "indexeddb",
  "network",
  "native-enrollment",
  "policy",
  "source",
  "graph",
  "runtime",
  "write",
] as const);
export type DocumentBootStage =
  | "storage"
  | "cookies"
  | "indexeddb"
  | "network"
  | "native-enrollment"
  | "policy"
  | "source"
  | "graph"
  | "runtime"
  | "write";
const codes = new Set([
  "ORIGINAL_POLICY_DENIED",
  "ORIGINAL_POLICY_UNSUPPORTED",
  "ORIGINAL_PLAN_UNSUPPORTED",
  "NATIVE_RESOURCE_PREPARATION_FAILED",
  "NATIVE_FONT_DEPENDENCY_UNSUPPORTED",
  "CSS_CONDITIONAL_IMPORT_UNSUPPORTED",
  "UNSUPPORTED_RESOURCE_PATH",
  "STORAGE_INITIALIZATION_FAILED",
  "COOKIE_INITIALIZATION_FAILED",
  "NETWORK_INITIALIZATION_FAILED",
  "POLICY_INITIALIZATION_FAILED",
  "RESOURCE_GRAPH_FAILED",
  "RUNTIME_INITIALIZATION_FAILED",
  "DOCUMENT_WRITE_FAILED",
  "DOCUMENT_INITIALIZATION_FAILED",
  "RESOURCE_MIME_REJECTED",
  "RESOURCE_INTEGRITY_REJECTED",
  "RESOURCE_LIMIT_EXCEEDED",
  "RESOURCE_TRANSPORT_FAILED",
  "TRUSTED_TYPES_REJECTED",
  "RESOURCE_GRAPH_RESOURCE_LIMIT",
  "RESOURCE_GRAPH_CONTEXT_LIMIT",
  "RESOURCE_GRAPH_BYTE_LIMIT",
  "CSS_LOCAL_DEPENDENCY_UNSUPPORTED",
  "RESOURCE_RESPONSE_UNREADABLE",
  "RESOURCE_SCHEME_REJECTED",
] as const);
export type DocumentBootFailure = Readonly<{
  stage: DocumentBootStage;
  code: string;
}>;
export function cleanDocumentBootFailure(
  value: unknown,
): DocumentBootFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== 2 ||
    !descriptors.stage ||
    !descriptors.code ||
    !("value" in descriptors.stage) ||
    !("value" in descriptors.code)
  )
    return;
  const stage = descriptors.stage.value,
    code = descriptors.code.value;
  if (!stages.has(stage) || !codes.has(code)) return;
  return Object.freeze({ stage, code });
}
export function describeDocumentBootFailure(
  stage: DocumentBootStage,
  error: unknown,
): DocumentBootFailure {
  let rawCode: unknown, name: unknown, message: unknown;
  try {
    rawCode = (error as any)?.code;
    name = (error as any)?.name;
    message = (error as any)?.message;
  } catch {}
  let code =
    typeof rawCode === "string" && codes.has(rawCode as any)
      ? rawCode
      : undefined;
  if (!code && typeof rawCode === "string") {
    if (rawCode === "original_policy_denied") code = "ORIGINAL_POLICY_DENIED";
    else if (rawCode.startsWith("original_policy_"))
      code = "ORIGINAL_POLICY_UNSUPPORTED";
    else if (rawCode.startsWith("original_plan_"))
      code = "ORIGINAL_PLAN_UNSUPPORTED";
    else if (rawCode.startsWith("native_resource_"))
      code = "NATIVE_RESOURCE_PREPARATION_FAILED";
  }
  if (!code) {
    if (
      message ===
      "Native font dependency destination requires its bound gateway"
    )
      code = "NATIVE_FONT_DEPENDENCY_UNSUPPORTED";
    else if (
      message ===
      "Conditional CSS imports require native fetch-activation authority"
    )
      code = "CSS_CONDITIONAL_IMPORT_UNSUPPORTED";
    else if (
      message ===
      "Native CSS dependency scheme requires its original-policy loader"
    )
      code = "CSS_LOCAL_DEPENDENCY_UNSUPPORTED";
    else if (message === "Website resource graph limit reached.")
      code = "RESOURCE_GRAPH_RESOURCE_LIMIT";
    else if (message === "Script execution context limit reached.")
      code = "RESOURCE_GRAPH_CONTEXT_LIMIT";
    else if (message === "Website resource graph byte limit reached.")
      code = "RESOURCE_GRAPH_BYTE_LIMIT";
    else if (message === "Website resource is not CORS-readable.")
      code = "RESOURCE_RESPONSE_UNREADABLE";
    else if (message === "Website resources require HTTP(S) URLs.")
      code = "RESOURCE_SCHEME_REJECTED";
    else if (
      [
        "Module requires a JavaScript MIME type.",
        "Classic script requires JavaScript MIME type.",
        "Stylesheet requires text/css.",
        "Font MIME type is not recognized.",
        "Unsupported media MIME type",
        "Image MIME type is not recognized.",
      ].includes(typeof message === "string" ? message : "")
    )
      code = "RESOURCE_MIME_REJECTED";
    else if (
      message === "Original resource bytes failed integrity verification."
    )
      code = "RESOURCE_INTEGRITY_REJECTED";
    else if (name === "NotSupportedError") code = "UNSUPPORTED_RESOURCE_PATH";
    else if (name === "QuotaExceededError") code = "RESOURCE_LIMIT_EXCEEDED";
    else if (name === "IntegrityError") code = "RESOURCE_INTEGRITY_REJECTED";
    else if (name === "NetworkError") code = "RESOURCE_TRANSPORT_FAILED";
  }
  if (!code)
    code =
      stage === "storage" || stage === "indexeddb"
        ? "STORAGE_INITIALIZATION_FAILED"
        : stage === "cookies"
          ? "COOKIE_INITIALIZATION_FAILED"
          : stage === "network" || stage === "native-enrollment"
            ? "NETWORK_INITIALIZATION_FAILED"
            : stage === "policy"
              ? "POLICY_INITIALIZATION_FAILED"
              : stage === "graph"
                ? "RESOURCE_GRAPH_FAILED"
                : stage === "runtime"
                  ? "RUNTIME_INITIALIZATION_FAILED"
                  : stage === "write"
                    ? "DOCUMENT_WRITE_FAILED"
                    : "DOCUMENT_INITIALIZATION_FAILED";
  return Object.freeze({ stage: stages.has(stage) ? stage : "runtime", code });
}
