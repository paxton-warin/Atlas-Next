import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureFrontendRelay } from "../scripts/configure-frontend-relay.mjs";
test("frontend-relay env migration retains keys, identity and unrelated configuration with private backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-env-"));
  const file = join(dir, ".env");
  const original =
    "# Operator configuration\nAPP_ORIGIN=https://front.example\nORIGIN_HOST=vps.example\nORIGIN_KEY=fixture-secret\nAI_API_KEY=fixture-ai\nLOCAL_BROWSING=false\nLOCAL_RELAY_MODE=isolated\nRUNTIME_HOST=old.example\nRUNTIME_ORIGIN=https://old.example\n";
  try {
    writeFileSync(file, original);
    const result = configureFrontendRelay(file);
    assert.ok(result.changed);
    assert.equal(readFileSync(result.backup, "utf8"), original);
    assert.equal(statSync(result.backup).mode & 0o777, 0o600);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const updated = readFileSync(file, "utf8");
    assert.match(updated, /ORIGIN_KEY=fixture-secret/);
    assert.match(updated, /AI_API_KEY=fixture-ai/);
    assert.match(updated, /LOCAL_BROWSING=true\nLOCAL_RELAY_MODE=frontend/);
    assert.doesNotMatch(updated, /^RUNTIME_(ORIGIN|HOST)=/m);
    assert.equal(configureFrontendRelay(file).changed, false);
    writeFileSync(
      file,
      original.replace(
        "https://front.example",
        "[https://front.example](https://front.example)",
      ),
    );
    assert.throws(() => configureFrontendRelay(file), /plain HTTPS origin/);
    assert.ok(existsSync(result.backup));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
