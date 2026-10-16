import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  verifyResourceIntegrity,
  resourceDigest,
} from "../runtime/opaque-resource-integrity.ts";
const bytes = new TextEncoder().encode("original resource bytes");
const hash = (algorithm, body = bytes) =>
  algorithm + "-" + createHash(algorithm).update(body).digest("base64");
test("SRI validates original bytes and rejects transformed bytes against original metadata", async () => {
  const metadata = hash("sha384");
  await verifyResourceIntegrity(metadata, bytes);
  await assert.rejects(
    verifyResourceIntegrity(
      metadata,
      new TextEncoder().encode("rewritten bytes"),
    ),
    { name: "SecurityError" },
  );
  assert.equal(await resourceDigest(bytes), metadata);
});
test("strongest supported hash wins; one matching strongest digest suffices", async () => {
  await verifyResourceIntegrity(
    hash("sha256") + " sha512-wrong " + hash("sha512"),
    bytes,
  );
  await assert.rejects(
    verifyResourceIntegrity(hash("sha256") + " sha512-wrong", bytes),
    { name: "SecurityError" },
  );
});
test("unsupported metadata and unknown options follow forward-compatible SRI matching", async () => {
  await verifyResourceIntegrity("unknown-deadbeef", bytes);
  await verifyResourceIntegrity(hash("sha384") + "?future-option", bytes);
  await assert.rejects(verifyResourceIntegrity("sha384-", bytes), {
    name: "SecurityError",
  });
});
