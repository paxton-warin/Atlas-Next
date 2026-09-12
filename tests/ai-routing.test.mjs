import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { digest } from "../server/store.mjs";
import { defaultAiConfig, createAiConfig } from "../server/ai-config.mjs";
import { createAiBudget } from "../server/ai-budget.mjs";
const origin = "http://localhost:4180";
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-routing-test-"));
  const app = await createApp({
    dataDir: dir,
    staticDir: "/not-built",
    dynamicOrigins: false,
    appOrigin: origin,
    runtimeOrigin: "http://127.0.0.1:4181",
  });
  app.store.db
    .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
    .run(digest("owner-fixture"), "csrf", Date.now(), Date.now());
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const headers = {
    origin,
    cookie: "atlas-admin=owner-fixture",
    "x-atlas-csrf": "csrf",
  };
  const save = (c) =>
    app.inject({ method: "PUT", url: "/api/admin/ai", headers, payload: c });
  const state = () => app.inject({ url: "/api/admin/ai", headers });
  const chat = (extra = {}, remoteAddress = "192.0.2.4") =>
    app.inject({
      method: "POST",
      url: "/api/ai/chat",
      headers: { origin },
      remoteAddress,
      payload: { messages: [{ role: "user", content: "Hello" }], ...extra },
    });
  return { app, save, state, chat, headers };
}
function configured() {
  const c = defaultAiConfig();
  c.enabled = true;
  c.allowGeminiDataUse = true;
  for (const p of c.providers) {
    p.enabled = ["groq", "gemini", "xai"].includes(p.id);
    p.freeTierConfirmed = p.billing === "free";
    p.apiKey = `fixture-${p.id}-key`;
  }
  return c;
}
function stream(
  text = "Fixture answer",
  model = "fixture-actual-model",
  tail = true,
) {
  const data = [
    JSON.stringify({ model, choices: [{ delta: { content: text } }] }),
    ...(tail
      ? [
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { total_tokens: 123 },
          }),
          "[DONE]",
        ]
      : []),
  ];
  return new Response(data.map((s) => `data: ${s}\r\n\r\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
test("free-first defaults, encrypted independent keys, CSRF, endpoint and model restrictions", async (t) => {
  const f = await fixture(t),
    c = configured();
  assert.equal(defaultAiConfig().freeOnly, true);
  assert.equal((await f.app.inject("/api/admin/ai")).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/admin/ai",
        headers: { origin, cookie: f.headers.cookie },
        payload: c,
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.save(c)).statusCode, 200);
  const state = (await f.state()).json();
  assert.equal(state.providers[0].hasKey, true);
  assert.equal(JSON.stringify(state).includes("fixture-groq-key"), false);
  assert.notEqual(
    f.app.store.get("aiRouting").providers[0].key,
    "fixture-groq-key",
  );
  assert.equal((await f.app.inject("/api/ai/config")).json().provider, "Groq");
  const bad = structuredClone(c);
  bad.providers[0].baseUrl = "https://example.org/v1";
  assert.equal((await f.save(bad)).statusCode, 400);
  bad.providers[0] = c.providers[0];
  bad.providers[2].billing = "free";
  assert.equal((await f.save(bad)).statusCode, 400);
  const unconfirmed = structuredClone(c);
  unconfirmed.providers[0].freeTierConfirmed = false;
  unconfirmed.providers[1].enabled = false;
  assert.equal((await f.save(unconfirmed)).statusCode, 200);
  assert.equal((await f.app.inject("/api/ai/config")).json().configured, false);
  assert.equal((await f.chat()).statusCode, 503);
  assert.equal((await f.save({ ...c, dailyLimit: -1 })).statusCode, 400);
});
test("Groq request streams with actual provider/model and reconciles provider usage", async (t) => {
  const f = await fixture(t);
  await f.save(configured());
  let called = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    called++;
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer fixture-groq-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "openai/gpt-oss-120b");
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.stream, true);
    return stream();
  });
  const r = await f.chat({
    model: "ignored-client-model",
    provider: "xai",
    apiKey: "ignored",
  });
  assert.equal(r.statusCode, 200);
  assert.equal(called, 1);
  const events = r.body.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events[0], {
    type: "source",
    provider: "Groq",
    model: "fixture-actual-model",
  });
  assert.equal(events.at(-1).type, "done");
  const usage = (await f.state()).json().providers[0].usage;
  assert.equal(usage.day.requests, 1);
  assert.equal(usage.day.tokens, 123);
});
test("429 switches to Gemini before output, respects consent, and persists cooldown", async (t) => {
  const f = await fixture(t);
  await f.save(configured());
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    if (url.includes("groq.com"))
      return new Response("quota", {
        status: 429,
        headers: { "retry-after": "120" },
      });
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    assert.equal(options.headers.Authorization, "Bearer fixture-gemini-key");
    assert.equal(JSON.parse(options.body).model, "gemini-3.5-flash-lite");
    return stream("Gemini fixture");
  });
  const r = await f.chat({ allowGeminiDataUse: true });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Google Gemini/);
  assert.equal(calls.length, 2);
  assert.ok(
    (await f.state()).json().providers[0].usage.cooldown.until >
      Date.now() + 100000,
  );
  assert.equal((await f.chat({ allowGeminiDataUse: true })).statusCode, 200);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("googleapis"));
  assert.equal((await f.chat()).statusCode, 429);
  assert.equal(calls.length, 3);
  const recreated = createAiBudget(f.app.store.db);
  assert.ok(recreated.status("groq").cooldown);
});
test("free-only never sends to xAI or custom, including when all free providers fail", async (t) => {
  const f = await fixture(t),
    c = configured();
  c.providers[1].enabled = false;
  await f.save(c);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return new Response("down", { status: 503 });
  });
  assert.equal((await f.chat()).statusCode, 502);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("groq"));
  assert.equal((await f.chat()).statusCode, 429);
  assert.equal(calls.length, 1);
});
test("partial answers, refusals and credential errors never switch providers", async (t) => {
  for (const mode of ["partial", "refusal", "credentials"]) {
    const f = await fixture(t);
    await f.save(configured());
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return mode === "partial"
        ? stream("Partial answer", "groq-fixture", false)
        : mode === "credentials"
          ? new Response("secret internal", { status: 401 })
          : new Response(
              'data: {"choices":[{"finish_reason":"content_filter"}]}\n\n',
            );
    });
    const r = await f.chat({ allowGeminiDataUse: true });
    assert.equal(calls, 1);
    assert.equal(r.statusCode, mode === "partial" ? 200 : 502);
    if (mode === "partial") {
      assert.match(r.body, /"type":"error"/);
      assert.doesNotMatch(r.body, /"type":"done"/);
    }
    assert.doesNotMatch(r.body, /secret internal/);
    mock.mock.restore();
  }
});
test("xAI requires explicit paid mode and uses Responses streaming", async (t) => {
  const f = await fixture(t),
    c = configured();
  c.freeOnly = false;
  c.providers.forEach((p) => (p.enabled = p.id === "xai"));
  await f.save(c);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.x.ai/v1/responses");
    assert.equal(options.headers.Authorization, "Bearer fixture-xai-key");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.model, "grok-4.6");
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"Grok fixture"}\n\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":47}}}',
    );
  });
  const r = await f.chat();
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /xAI Grok/);
  assert.equal(
    (await f.state()).json().providers.find((p) => p.id === "xai").usage.day
      .tokens,
    47,
  );
});
test("global and provider budgets remain active for whitelisted IPs and survive settings saves", async (t) => {
  const f = await fixture(t),
    c = configured();
  c.providers[0].limits.rpd = 1;
  c.providers[1].enabled = false;
  await f.save(c);
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/admin/request-limits",
        headers: f.headers,
        payload: { whitelist: ["192.0.2.0/24"] },
      })
    ).statusCode,
    200,
  );
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return stream();
  });
  assert.equal((await f.chat()).statusCode, 200);
  assert.equal((await f.chat()).statusCode, 429);
  assert.equal(calls, 1);
  await f.save(c);
  assert.equal((await f.chat()).statusCode, 429);
  assert.equal(calls, 1);
  c.dailyLimit = 1;
  await f.save(c);
  assert.equal((await f.chat()).statusCode, 429);
  const read = createAiConfig(f.app.store, {}).read();
  assert.equal(read.providers[0].key, "fixture-groq-key");
});
test("budget reservations serialize concurrent requests and reconcile only the matching window", async (t) => {
  const f = await fixture(t),
    b = createAiBudget(f.app.store.db),
    p = { id: "synthetic", limits: { rpm: 2, rpd: 3, tpm: 100, tpd: 150 } };
  const settle = b.reserve(p, 70);
  assert.equal(typeof settle, "function");
  assert.equal(b.reserve(p, 70), null);
  settle(20);
  assert.equal(typeof b.reserve(p, 70), "function");
  assert.equal(b.reserve(p, 1), null);
  assert.equal(b.status(p.id).minute.tokens, 90);
  f.app.store.db
    .prepare("UPDATE ai_usage SET reset=0 WHERE provider=? AND period='minute'")
    .run(p.id);
  assert.equal(typeof b.reserve(p, 50), "function");
  assert.equal(b.reserve(p, 1), null);
});
test("legacy provider migration preserves encryption, endpoint and explicit paid behavior", async (t) => {
  const f = await fixture(t);
  f.app.store.set("aiConfig", {
    enabled: true,
    baseUrl: "https://example.com/v1",
    model: "legacy-model",
    protocol: "responses",
    key: f.app.store.seal("legacy-key"),
    dailyLimit: 50,
  });
  const read = (await f.state()).json();
  assert.equal(read.freeOnly, false);
  assert.equal(read.providers[0].id, "custom");
  assert.equal(read.providers[0].hasKey, true);
  read.providers[0].baseUrl = "https://other.example/v1";
  assert.equal((await f.save(read)).statusCode, 400);
  read.providers[0].apiKey = "new-key";
  assert.equal((await f.save(read)).statusCode, 200);
  assert.equal(createAiConfig(f.app.store).read().providers[0].key, "new-key");
});
