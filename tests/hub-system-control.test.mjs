import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSystemCollector,
  sanitizeSystem,
} from "../server/hub-system.mjs";
import { createApp } from "../server/app.mjs";
test("real local resource collector emits genuine distinct process and host measurements", () => {
  const value = createSystemCollector()();
  assert.ok(value.metrics.host_memory_total_bytes > 0);
  assert.ok(value.metrics.heap_used_bytes > 0);
  assert.ok(value.metrics.process_rss_bytes > 0);
  assert.ok(value.metrics.host_uptime_seconds >= 0);
  assert.ok(!("online_users" in value.metrics));
  assert.equal(
    sanitizeSystem({
      observedAt: new Date(0).toISOString(),
      metrics: { heap_used_bytes: 1 },
    }),
    null,
  );
});
test("Linux memory availability and container cgroup are separate; CPU needs a delta", () => {
  let clock = Date.now(),
    phase = 0;
  const readFile = (p) =>
    ({
      "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 400 kB\n",
      "/sys/fs/cgroup/memory.current": "2048",
      "/sys/fs/cgroup/memory.max": "4096",
    })[p] ??
    (() => {
      throw Error();
    })();
  const collect = createSystemCollector({
    readFile,
    now: () => clock,
    cpus: () => [
      {
        times: {
          idle: phase ? 150 : 100,
          user: phase ? 150 : 100,
          nice: 0,
          sys: 0,
          irq: 0,
        },
      },
    ],
    statfs: () => ({ bsize: 1024, bavail: 2, blocks: 10 }),
  });
  let v = collect();
  assert.equal(v.metrics.host_memory_used_bytes, 600 * 1024);
  assert.equal(v.metrics.container_memory_bytes, 2048);
  assert.equal(v.metrics.container_memory_limit_bytes, 4096);
  assert.equal(v.metrics.cpu_percent, undefined);
  clock += 15001;
  phase = 1;
  v = collect();
  assert.equal(v.metrics.cpu_percent, 50);
  assert.equal(v.metrics.disk_available_bytes, 2048);
});
test("typed controls require service proof and default to preserving admin MFA gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-control-"));
  const key = "fixture-control-".repeat(3);
  const app = await createApp({
    dataDir: dir,
    dynamicOrigins: false,
    appOrigin: "http://localhost:4180",
    runtimeOrigin: "http://127.0.0.1:4181",
    staticDir: "/not-built",
    hubServiceSecret: key,
  });
  try {
    assert.equal(
      (await app.inject("/api/internal/hub/control")).statusCode,
      401,
    );
    const headers = { authorization: "Bearer " + key };
    const good = await app.inject({
      url: "/api/internal/hub/control",
      headers,
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().mutationsEnabled, false);
    assert.ok(!good.body.includes(key));
    assert.ok(
      good.json().nodes.find((n) => n.id === "local").system.metrics
        .heap_used_bytes > 0,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers,
          payload: { operation: "site.update", input: { name: "Changed" } },
        })
      ).statusCode,
      503,
    );
    assert.notEqual(app.store.get("siteName"), "Changed");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("explicit local control writes are typed and AI snapshots never return saved secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-control-"));
  const key = "fixture-control-".repeat(3);
  const app = await createApp({
    dataDir: dir,
    dynamicOrigins: false,
    appOrigin: "http://localhost:4180",
    runtimeOrigin: "http://127.0.0.1:4181",
    staticDir: "/not-built",
    hubServiceSecret: key,
    hubControlMutations: true,
  });
  try {
    const headers = { authorization: "Bearer " + key };
    const r = await app.inject({
      method: "POST",
      url: "/api/internal/hub/control",
      headers,
      payload: { operation: "site.update", input: { name: "Fixture Atlas" } },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().name, "Fixture Atlas");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers,
          payload: { operation: "shell.exec", input: { command: "anything" } },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers: { ...headers, origin: "http://localhost:4180" },
          payload: { operation: "site.update", input: { name: "No" } },
        })
      ).statusCode,
      401,
    );
    for (const provider of r.json().ai.providers)
      assert.equal("key" in provider, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("central changes require coordinator password and single-use operation/session-bound MFA", async () => {
  const { otp } = await import("../server/app.mjs");
  const { digest, token } = await import("../server/store.mjs");
  const { randomUUID } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-mfa-")),
    key = "mfa-service-".repeat(4);
  const app = await createApp({
    dataDir: dir,
    dynamicOrigins: false,
    appOrigin: "http://localhost:4180",
    runtimeOrigin: "http://127.0.0.1:4181",
    staticDir: "/not-built",
    hubServiceSecret: key,
  });
  try {
    const raw = token();
    app.store.set("bootstrap", {
      hash: digest(raw),
      expires: Date.now() + 60000,
    });
    const enroll = await app.inject({
      method: "POST",
      url: "/api/admin/enroll",
      headers: { origin: "http://localhost:4180" },
      payload: { token: raw, password: "coordinator-fixture-password" },
    });
    const complete = await app.inject({
      method: "POST",
      url: "/api/admin/complete",
      headers: { origin: "http://localhost:4180" },
      payload: {
        challenge: enroll.json().challenge,
        code: otp(enroll.json().secret).generate(),
      },
    });
    assert.equal(complete.statusCode, 200);
    const recovery = complete.json().recovery;
    const headers = { authorization: "Bearer " + key },
      administrator = { userId: randomUUID(), sessionId: randomUUID() },
      command = {
        operation: "site.update",
        input: { name: "Verified Hub" },
        administrator,
      };
    const begin = () =>
      app.inject({
        method: "POST",
        url: "/api/internal/hub/control/challenge",
        headers,
        payload: command,
      });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers,
          payload: command,
        })
      ).statusCode,
      401,
    );
    const changed = (await begin()).json().challengeId;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers,
          payload: {
            ...command,
            input: { name: "Tampered" },
            challengeId: changed,
            password: "coordinator-fixture-password",
            code: recovery[0],
          },
        })
      ).statusCode,
      401,
    );
    const challengeId = (await begin()).json().challengeId;
    const execute = {
      ...command,
      challengeId,
      password: "coordinator-fixture-password",
      code: recovery[0],
    };
    const applied = await app.inject({
      method: "POST",
      url: "/api/internal/hub/control",
      headers,
      payload: execute,
    });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().name, "Verified Hub");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers,
          payload: execute,
        })
      ).statusCode,
      401,
    );
    const second = (await begin()).json().challengeId;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control",
          headers,
          payload: { ...execute, challengeId: second },
        })
      ).statusCode,
      401,
      "recovery code is single use across central and legacy administration",
    );
    assert.equal(
      app.store.get("admin").recovery.includes(digest(recovery[0])),
      false,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("legacy support export requires the actual existing ticket bearer capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-legacy-")),
    key = "legacy-service-".repeat(4);
  const app = await createApp({
    dataDir: dir,
    dynamicOrigins: false,
    appOrigin: "http://localhost:4180",
    runtimeOrigin: "http://127.0.0.1:4181",
    staticDir: "/not-built",
    hubServiceSecret: key,
  });
  try {
    const made = await app.inject({
      method: "POST",
      url: "/api/tickets",
      headers: { origin: "http://localhost:4180" },
      payload: {
        subject: "Legacy conversation",
        category: "Other",
        body: "Existing conversation fixture.",
      },
    });
    const ticket = made.json(),
      headers = { authorization: "Bearer " + key };
    const value = await app.inject({
      method: "POST",
      url: "/api/internal/hub/control/legacy-ticket",
      headers,
      payload: { source: "atlas", id: ticket.id, token: ticket.token },
    });
    assert.equal(value.statusCode, 200, value.body);
    assert.equal(
      value.json().messages[0].body,
      "Existing conversation fixture.",
    );
    assert.equal(value.body.includes(ticket.token), false);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control/legacy-ticket",
          headers,
          payload: { source: "atlas", id: ticket.id, token: "guessed" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal/hub/control/legacy-ticket",
          headers,
          payload: { source: "other", id: ticket.id, token: ticket.token },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
