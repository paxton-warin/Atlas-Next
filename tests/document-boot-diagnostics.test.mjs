import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanDocumentBootFailure,
  describeDocumentBootFailure,
} from "../runtime/document-boot-diagnostics.ts";
test("boot diagnostics expose only fixed stage/code metadata, never website strings or exception payloads", () => {
  const error = Object.assign(
    new Error("https://secret.test/path?token=private COOKIE=private"),
    { code: "native_resource_any_website_string", stack: "private body" },
  );
  const value = describeDocumentBootFailure("graph", error);
  assert.deepEqual(value, {
    stage: "graph",
    code: "NATIVE_RESOURCE_PREPARATION_FAILED",
  });
  assert.equal(JSON.stringify(value).includes("private"), false);
  assert.deepEqual(
    describeDocumentBootFailure(
      "graph",
      new DOMException(
        "Native font dependency destination requires its bound gateway",
        "NotSupportedError",
      ),
    ),
    { stage: "graph", code: "NATIVE_FONT_DEPENDENCY_UNSUPPORTED" },
  );
  assert.deepEqual(
    describeDocumentBootFailure(
      "graph",
      new DOMException(
        "Conditional CSS imports require native fetch-activation authority",
        "NotSupportedError",
      ),
    ),
    { stage: "graph", code: "CSS_CONDITIONAL_IMPORT_UNSUPPORTED" },
  );
  assert.deepEqual(
    describeDocumentBootFailure("policy", { code: "original_policy_denied" }),
    { stage: "policy", code: "ORIGINAL_POLICY_DENIED" },
  );
  assert.deepEqual(
    describeDocumentBootFailure("write", {
      get code() {
        throw Error("private");
      },
    }),
    { stage: "write", code: "DOCUMENT_WRITE_FAILED" },
  );
  assert.equal(Object.isFrozen(value), true);
});
test("boot receipt validation rejects extra fields, unknown labels, arrays and accessors without invoking getters", () => {
  assert.deepEqual(
    cleanDocumentBootFailure({ stage: "graph", code: "RESOURCE_GRAPH_FAILED" }),
    { stage: "graph", code: "RESOURCE_GRAPH_FAILED" },
  );
  let reads = 0;
  for (const value of [
    null,
    [],
    { stage: "graph", code: "https://secret.test" },
    { stage: "page body", code: "RESOURCE_GRAPH_FAILED" },
    { stage: "graph", code: "RESOURCE_GRAPH_FAILED", message: "private" },
    {
      stage: "graph",
      get code() {
        reads++;
        return "RESOURCE_GRAPH_FAILED";
      },
    },
  ])
    assert.equal(cleanDocumentBootFailure(value), undefined);
  assert.equal(reads, 0);
});
test("fixed resource graph branches distinguish count/byte/context, MIME, readability and SRI without raw exception output", () => {
  for (const [message, code] of [
    ["Website resource graph limit reached.", "RESOURCE_GRAPH_RESOURCE_LIMIT"],
    ["Script execution context limit reached.", "RESOURCE_GRAPH_CONTEXT_LIMIT"],
    ["Website resource graph byte limit reached.", "RESOURCE_GRAPH_BYTE_LIMIT"],
    ["Website resource is not CORS-readable.", "RESOURCE_RESPONSE_UNREADABLE"],
    ["Website resources require HTTP(S) URLs.", "RESOURCE_SCHEME_REJECTED"],
    ["Classic script requires JavaScript MIME type.", "RESOURCE_MIME_REJECTED"],
    [
      "Original resource bytes failed integrity verification.",
      "RESOURCE_INTEGRITY_REJECTED",
    ],
  ])
    assert.deepEqual(describeDocumentBootFailure("graph", new Error(message)), {
      stage: "graph",
      code,
    });
  assert.deepEqual(
    describeDocumentBootFailure(
      "graph",
      new Error("Website resource graph limit reached. PRIVATE"),
    ),
    { stage: "graph", code: "RESOURCE_GRAPH_FAILED" },
  );
});
