import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cleanEnvironment,
  validateLabDatabase,
  validateLabRedis,
  ports,
} from "../scripts/hub-lab.mjs";
test("lab accepts only its exact loopback PostgreSQL database", () => {
  for (const uri of [
    "postgres://user@localhost:5432/atlas_hub_lab_test",
    "postgresql://user@127.0.0.1/atlas_hub_lab_test",
  ])
    assert.equal(validateLabDatabase(uri).pathname, "/atlas_hub_lab_test");
  for (const uri of [
    "postgres://user@prod.example/atlas_hub_lab_test",
    "postgres://user@localhost/atlas",
    "postgres://user@localhost/atlas_hub_lab_test?options=bad",
    "https://localhost/atlas_hub_lab_test",
  ])
    assert.throws(() => validateLabDatabase(uri));
});
test("lab accepts only its reserved loopback Redis database without flush", () => {
  assert.equal(validateLabRedis("redis://localhost:56379/14").pathname, "/14");
  for (const uri of [
    "redis://prod.example/14",
    "redis://localhost/0",
    "redis://localhost/15",
    "redis://localhost/14?x=1",
  ])
    assert.throws(() => validateLabRedis(uri));
});
test("lab never inherits production database or AWS environment", () => {
  process.env.AWS_PROFILE = "secret-main";
  process.env.DATABASE_URL = "postgres://prod/real";
  const env = cleanEnvironment({ APP_URL: "https://localhost:4300" });
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.APP_URL, "https://localhost:4300");
  delete process.env.AWS_PROFILE;
  delete process.env.DATABASE_URL;
});
test("lab command refuses production invocation before reading state or starting services", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/hub-lab.mjs", "status"], {
        cwd: new URL("..", import.meta.url),
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
        stdio: "pipe",
      }),
    (error) => String(error.stderr).includes("refuses a production invocation"),
  );
});
test("lab ports are unique and avoid normal integration/browser fixture ports", () => {
  const values = Object.values(ports).flat();
  assert.equal(new Set(values).size, values.length);
  for (const port of [4180, 4181, 4183, 4199, 3000, 5432, 56379])
    assert.equal(values.includes(port), false);
});
test("Main relay HTTP and upgrades route to runtime while trusted owner channels stay in app", async () => {
  const { labUpstreamPort, labTransitionBlocksUpgrade } = await import(
    "../scripts/hub-lab-routing.mjs"
  );
  for (const path of ["/relay/ticket/", "/relay/ticket/?v=2"])
    assert.equal(
      labUpstreamPort(ports.atlas, ports.atlasInternal, path, ports),
      ports.runtimeInternal,
    );
  for (const path of [
    "/relay",
    "/api/relay/",
    "/browse/storage/owner/key",
    "/browse/cookies/owner/key",
    "/api/hub/state",
  ])
    assert.equal(
      labUpstreamPort(ports.atlas, ports.atlasInternal, path, ports),
      ports.atlasInternal,
    );
  assert.equal(
    labUpstreamPort(ports.hub, ports.hubInternal, "/relay/ticket/", ports),
    ports.hubInternal,
  );
  for (const path of [
    "/browse/storage/owner/key",
    "/browse/cookies/owner/key?x=1",
  ])
    assert.equal(labTransitionBlocksUpgrade(path), false);
  for (const path of [
    "/relay/ticket/",
    "/browse/storage/owner",
    "/browse/cookies/owner-malicious/key",
  ])
    assert.equal(labTransitionBlocksUpgrade(path), true);
});
test("status exposes only current local endpoint aliases at the expected service port", async () => {
  const { validateLabPublicOrigin } = await import("../scripts/hub-lab.mjs");
  assert.equal(
    validateLabPublicOrigin("https://h123.atlas.localhost:4300", 4300),
    "https://h123.atlas.localhost:4300",
  );
  assert.equal(
    validateLabPublicOrigin("https://localhost:4280", 4280),
    "https://localhost:4280",
  );
  for (const value of [
    "https://production.example:4300",
    "https://evil-atlas.localhost:4300",
    "https://h123.atlas.localhost:4280",
    "https://h123.atlas.localhost:4300/path",
    "http://localhost:4300",
  ])
    assert.throws(() => validateLabPublicOrigin(value, 4300));
});

test("local runtime selection is explicit and never accepts the old local-only same-origin mode", async () => {
  const { validateLabRuntime } = await import("../scripts/hub-lab.mjs");
  assert.equal(validateLabRuntime(), "opaque-v2");
  assert.equal(validateLabRuntime("same-origin-profile"), "same-origin-profile");
  for (const value of ["same-origin", "", "true", "held"]) assert.throws(() => validateLabRuntime(value));
});
