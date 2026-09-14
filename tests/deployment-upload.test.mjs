import test from "node:test";
import assert from "node:assert/strict";
import { probeUpload } from "./deployment-upload-fixture.mjs";
test("upload preserves custom Caddy/Compose on all hosts, backs up first, and stages templates separately", () => {
  assert.deepEqual(probeUpload("scripts/upload-update.sh"), {
    preserved: true,
    backedUp: true,
    staged: true,
  });
});
test("upload fails before transfer if deployment backup fails", () => {
  assert.deepEqual(
    probeUpload("scripts/upload-update.sh", { failBackup: true }),
    { failedClosed: true },
  );
});
