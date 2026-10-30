import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../server/store.mjs";
const { installHubBranch, validateHubBranchConfig } = await import(process.env.ATLAS_HUB_BRANCH_SOURCE || "../server/hub-branch.mjs");
const origin = "https://branch.example",
  hubOrigin = "https://hub.example",
  branchId = randomUUID(),
  branchSecret = "s".repeat(43),
  rawSession = "t".repeat(43);
async function fixture({ pool, configuration = {} } = {}) {
  let clock = Date.now(),
    state = "",
    revoked = false,
    unavailable = false,
    upstreamResponse,
    calls = [];
  const dir = mkdtempSync(join(tmpdir(), "atlas-hub-branch-"));
  const store = openStore(dir);
  const app = Fastify();
  const grant = (id = branchId) => ({
    protocol: 1,
    branchId: id,
    userId: "11111111-1111-4111-8111-111111111111",
    profileId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    contextId: "44444444-4444-4444-8444-444444444444",
    expiresAt: new Date(clock + 86400000).toISOString(),
    grantExpiresAt: new Date(clock + 300000).toISOString(),
    tokenHash: "never-forward-this",
  });
  await installHubBranch(app, {
    config: {
      appOrigin: origin,
      hubOrigin,
      hubBranchId: branchId,
      hubBranchSecret: branchSecret,
      hubUiOnlyLab: true,
      hubServiceSecret: "control-".repeat(6),
      ...configuration,
    },
    pool,
    originFor: (r) => r.headers["x-fixture-origin"] || origin,
    store,
    seal: store.seal,
    unseal: store.unseal,
    now: () => clock,
    fetch: async (url, opts) => {
      if (unavailable) throw Error("Fixture upstream outage");
      calls.push({ url, opts });
      // Fastify rejects an advertised empty JSON body on DELETE. Keep the
      // gateway fixture honest about the actual upstream HTTP parser contract.
      if (opts.method === "DELETE" && opts.headers["content-type"] === "application/json" && opts.body === undefined)
        return new Response(JSON.stringify({error:{code:"FST_ERR_CTP_EMPTY_JSON_BODY"}}),{status:400});
      const path = new URL(url).pathname;
      const overridden = await upstreamResponse?.(path, opts);
      if (overridden) return overridden;
      if (path.endsWith("/exchange"))
        return new Response(
          JSON.stringify({
            branchSession: rawSession,
            grant: grant(opts.headers["x-atlas-branch-id"]),
            state,
          }),
        );
      if (path.endsWith("/session"))
        return new Response(
          JSON.stringify(
            revoked
              ? { error: { code: "HUB_SESSION_EXPIRED" } }
              : { grant: grant(opts.headers["x-atlas-branch-id"]) },
          ),
          { status: revoked ? 401 : 200 },
        );
      if (path === "/api/hub/branch/profile/events")
        return new Response(
          'event: profile\ndata: {"type":"profile.writers.resync"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      if (path.endsWith("/events"))
        return new Response(
          'event: ready\ndata: {"type":"ready"}\n\nevent: support\ndata: {"type":"support.changed","revision":"19"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        JSON.stringify({ ok: true, profileId: grant().profileId }),
      );
    },
  });
  app.get("/api/browse/fixture", () => ({ ok: true }));
  await app.ready();
  return {
    app,
    store,
    calls,
    advance: (ms) => (clock += ms),
    revoke: () => (revoked = true),
    outage: () => (unavailable = true),
    upstream: (response) => (upstreamResponse = response),
    async signin(frontend = origin, returnTo = "/popout") {
      const start = await app.inject({
        method: "POST",
        url: "/api/hub/signin",
        headers: { origin: frontend, "x-fixture-origin": frontend },
        payload: { returnTo },
      });
      assert.equal(start.statusCode, 200);
      state = new URL(start.json().redirect).searchParams.get("state");
      const pending = start.headers["set-cookie"].split(";")[0];
      const done = await app.inject({
        url: "/auth/hub/callback?code=" + "c".repeat(43) + "&state=" + state,
        headers: { cookie: pending, "x-fixture-origin": frontend },
      });
      assert.equal(done.statusCode, 302);
      assert.equal(done.headers.location, returnTo);
      const cookies = done.headers["set-cookie"];
      return {
        pending,
        state,
        cookie: cookies
          .find((v) => v.startsWith("__Host-atlas-hub="))
          .split(";")[0],
      };
    },
    async done() {
      await app.close();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("support SSE uses only authenticated fixed upstream path and server-owned credentials", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject("/api/hub/support/events")).statusCode,
      401,
    );
    const s = await f.signin();
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hub/support/events?token=forged",
          headers: { cookie: s.cookie },
        })
      ).statusCode,
      404,
    );
    const r = await f.app.inject({
      url: "/api/hub/support/events",
      headers: { cookie: s.cookie },
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers["content-type"], /^text\/event-stream/);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(r.body, /"revision":"19"/);
    assert.ok(!r.body.includes(rawSession) && !r.body.includes(branchSecret));
    const request = f.calls.find((v) => v.url.endsWith("/events"));
    assert.equal(request.url, hubOrigin + "/api/hub/branch/events");
    assert.equal(request.opts.headers.authorization, "Bearer " + branchSecret);
    assert.equal(request.opts.headers["x-atlas-branch-session"], rawSession);
    assert.equal(request.opts.redirect, "error");
    f.advance(46000);
    f.revoke();
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hub/support/events",
          headers: { cookie: s.cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.done();
  }
});
test("Hub activation rejects unisolated production runtime instead of weakening origins", () => {
  assert.equal(validateHubBranchConfig({}), false);
  assert.throws(
    () =>
      validateHubBranchConfig({
        hubOrigin,
        hubBranchId: branchId,
        hubBranchSecret: branchSecret,
        sameOriginRuntime: true,
      }),
    /opaque runtime/,
  );
  assert.equal(
    validateHubBranchConfig({
      hubOrigin,
      hubBranchId: branchId,
      hubBranchSecret: branchSecret,
      hubUiOnlyLab: true,
    }),
    true,
  );
});
test("welcome is explicit and auth callback is state/cookie bound; credentials remain server-only", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject("/api/hub/state")).json().authenticated,
      false,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/hub/signin",
          payload: {},
        })
      ).statusCode,
      403,
    );
    const s = await f.signin();
    const r = await f.app.inject({
      url: "/api/hub/state",
      headers: { cookie: s.cookie },
    });
    assert.equal(r.json().authenticated, true);
    assert.equal(
      r.json().grant.profileId,
      "22222222-2222-4222-8222-222222222222",
    );
    for (const secret of [rawSession, branchSecret, "never-forward-this"])
      assert.ok(!r.body.includes(secret));
    assert.equal(
      (
        await f.app.inject({
          url: "/auth/hub/callback?code=" + "c".repeat(43) + "&state=wrong",
          headers: { cookie: s.pending },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hub/state",
          headers: {
            cookie: s.cookie,
            "x-fixture-origin": "https://other.example",
          },
        })
      ).json().authenticated,
      false,
    );
  } finally {
    await f.done();
  }
});
test("profile proxy allowlists methods/paths and enforces CSRF/current session", async () => {
  const f = await fixture();
  try {
    const s = await f.signin(),
      state = (
        await f.app.inject({
          url: "/api/hub/state",
          headers: { cookie: s.cookie },
        })
      ).json();
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/hub/profile/stream",
          headers: { cookie: s.cookie, origin },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hub/profile/admin/users",
          headers: { cookie: s.cookie },
        })
      ).statusCode,
      404,
    );
    const r = await f.app.inject({
      method: "POST",
      url: "/api/hub/profile/stream",
      headers: { cookie: s.cookie, origin, "x-atlas-hub-csrf": state.csrf },
      payload: { namespace: { kind: "settings" } },
    });
    assert.equal(r.statusCode, 200);
    const last = f.calls.at(-1);
    assert.equal(last.url, hubOrigin + "/api/hub/branch/profile/stream");
    assert.equal(last.opts.headers["x-atlas-branch-session"], rawSession);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/browse/fixture",
          headers: { cookie: s.cookie },
        })
      ).statusCode,
      503,
    );
  } finally {
    await f.done();
  }
});
test("valid session refresh survives original five-minute grant and notices revocation within45s", async () => {
  const f = await fixture();
  try {
    const s = await f.signin();
    f.advance(301000);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hub/state",
          headers: { cookie: s.cookie },
        })
      ).json().authenticated,
      true,
    );
    f.revoke();
    f.advance(45001);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hub/state",
          headers: { cookie: s.cookie },
        })
      ).json().authenticated,
      false,
    );
  } finally {
    await f.done();
  }
});
test("administration leaves browser instance and signed-out browsing cannot issue capabilities", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject("/api/browse/fixture")).statusCode, 401);
    const r = await f.app.inject("/_control/atlas-owner");
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, hubOrigin + "/?admin=overview");
  } finally {
    await f.done();
  }
});

test("server-owned multi-origin registry selects exact credentials and rejects stale control", async () => {
  const f = await fixture();
  try {
    const second = "https://second.example",
      secondId = randomUUID(),
      secret = "v".repeat(43);
    const input = { origin: second, id: secondId, secret, generation: 1 };
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/internal/hub/branches",
          payload: input,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/internal/hub/branches",
          headers: { authorization: "Bearer " + "control-".repeat(6), origin },
          payload: input,
        })
      ).statusCode,
      401,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/internal/hub/branches",
            headers: { authorization: "Bearer " + "control-".repeat(6) },
            payload: input,
          })
        ).statusCode,
        200,
      );
    assert.ok(
      !JSON.stringify(f.store.get("hubBranchRegistry")).includes(secret),
    );
    await f.signin();
    assert.equal(
      f.calls.at(-1).opts.headers.authorization,
      "Bearer " + branchSecret,
    );
    await f.signin(second);
    assert.equal(f.calls.at(-1).opts.headers.authorization, "Bearer " + secret);
    assert.equal(f.calls.at(-1).opts.headers["x-atlas-branch-id"], secondId);
    const unknown = await f.app.inject({
      method: "POST",
      url: "/api/hub/signin",
      headers: {
        origin: "https://unknown.example",
        "x-fixture-origin": "https://unknown.example",
      },
      payload: {},
    });
    assert.equal(unknown.statusCode, 503);
    assert.ok(unknown.body.includes("not connected"));
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/internal/hub/branches",
          headers: { authorization: "Bearer " + "control-".repeat(6) },
          payload: { ...input, generation: 1, secret: "z".repeat(43) },
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.done();
  }
});

test("ordinary sign-out sends a valid bodyless DELETE to revoke the real Hub session",async()=>{
  const f=await fixture();try{
    const signed=await f.signin();
    const state=await f.app.inject({url:"/api/hub/state",headers:{cookie:signed.cookie}});
    const response=await f.app.inject({method:"POST",url:"/api/hub/logout",headers:{cookie:signed.cookie,origin,"x-atlas-hub-csrf":state.json().csrf},payload:{}});
    assert.equal(response.statusCode,200);assert.equal(response.json().revocationPending,false);
    const call=f.calls.find(c=>c.opts.method==="DELETE");assert.ok(call);assert.equal(call.opts.body,undefined);assert.equal(call.opts.headers["content-type"],undefined);
    assert.equal(call.opts.headers["x-atlas-branch-session"],rawSession);
  }finally{await f.done();}
});
test("logout clears encrypted browser session and cache even when Hub validation is unavailable", async () => {
  const f = await fixture();
  try {
    const s = await f.signin();
    const state = (
      await f.app.inject({
        url: "/api/hub/state",
        headers: { cookie: s.cookie },
      })
    ).json();
    f.outage();
    f.advance(45001);
    const r = await f.app.inject({
      method: "POST",
      url: "/api/hub/logout",
      headers: { origin, cookie: s.cookie, "x-atlas-hub-csrf": state.csrf },
      payload: {},
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().revocationPending, true);
    assert.ok(r.headers["set-cookie"].includes("Max-Age=0"));
    assert.equal(
      (await f.app.inject("/api/hub/state")).json().authenticated,
      false,
    );
  } finally {
    await f.done();
  }
});

test("retired four-MiB chunks stay retired; current binary backup boundary and generic body limits remain enforced", async () => {
  const f = await fixture();
  try {
    const s = await f.signin();
    const state = (
      await f.app.inject({
        url: "/api/hub/state",
        headers: { cookie: s.cookie },
      })
    ).json();
    const headers = {
      origin,
      cookie: s.cookie,
      "x-atlas-hub-csrf": state.csrf,
    };
    const payload = {
      hash: "a".repeat(64),
      data: Buffer.alloc(4 * 1024 * 1024).toString("base64"),
    };
    const beforeLegacy = f.calls.length;
    const retired = await f.app.inject({
          method: "POST",
          url: "/api/hub/profile/chunks",
          headers,
          payload,
        });
    assert.equal(retired.statusCode, 410);
    assert.equal(retired.json().error.code, "PROFILE_LEGACY_SYNC_RETIRED");
    assert.equal(retired.json().error.retryable, false);
    assert.equal(f.calls.length, beforeLegacy, "legacy bytes never reach identity/upstream work");
    const partPath = "/api/hub/profile/backups/v2/staging/" + randomUUID() + "/parts/" + "a".repeat(64);
    const partUpstream = hubOrigin + partPath.replace("/api/hub/profile", "/api/hub/branch/profile");
    f.upstream(async (path, options) => {
      if (!path.includes("/backups/v2/staging/")) return;
      let bytes = 0;
      for await (const chunk of options.body) bytes += chunk.length;
      return new Response(JSON.stringify({ bytes }), { headers: { "content-type": "application/json" } });
    });
    const binaryHeaders = { ...headers, "content-type": "application/octet-stream" };
    const boundary = await f.app.inject({ method: "PUT", url: partPath, headers: binaryHeaders, payload: Buffer.alloc(262144) });
    assert.equal(boundary.statusCode, 200);
    assert.equal(boundary.json().bytes, 262144, "v2 raw bytes reach upstream exactly, without base64 expansion");
    assert.equal(f.calls.at(-1).url, partUpstream);
    assert.equal(f.calls.at(-1).opts.headers["content-type"], "application/octet-stream");
    assert.equal((await f.app.inject({ method: "PUT", url: partPath, headers: binaryHeaders, payload: Buffer.alloc(262145) })).statusCode, 413, "one excess byte cannot widen the v2 part boundary");
    const beforeGeneric = f.calls.length;
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/hub/profile/stream",
          headers,
          payload,
        })
      ).statusCode,
      413,
    );
    assert.equal(f.calls.length, beforeGeneric, "oversized generic JSON stops before upstream work");
  } finally {
    await f.done();
  }
});


test("dedicated Support destination survives the existing single-use Hub sign-in handoff", async()=>{
 const f=await fixture();try{await f.signin(origin,"/support");}finally{await f.done();}
});


test("profile SSE is a fixed authenticated stream, not a JSON or caller-selected upstream proxy", async () => {
 const f=await fixture();
 try {
  assert.equal((await f.app.inject('/api/hub/profile/events')).statusCode,401);
  const s=await f.signin();
  assert.equal((await f.app.inject({url:'/api/hub/profile/events?profile=other',headers:{cookie:s.cookie}})).statusCode,404);
  const r=await f.app.inject({url:'/api/hub/profile/events',headers:{cookie:s.cookie}});
  assert.equal(r.statusCode,200);assert.match(r.headers['content-type'],/^text\/event-stream/);assert.equal(r.headers['cache-control'],'no-store');
  assert.match(r.body,/profile.writers.resync/);assert.ok(!r.body.includes(rawSession)&&!r.body.includes(branchSecret));
  const request=f.calls.find(c=>c.url.endsWith('/profile/events'));
  assert.equal(request.url,hubOrigin+'/api/hub/branch/profile/events');assert.equal(request.opts.redirect,'error');
  assert.equal(request.opts.headers.authorization,'Bearer '+branchSecret);assert.equal(request.opts.headers['x-atlas-branch-session'],rawSession);
  f.advance(46000);f.revoke();assert.equal((await f.app.inject({url:'/api/hub/profile/events',headers:{cookie:s.cookie}})).statusCode,401);
 }finally{await f.done();}
});

const serviceAuthorization = { authorization: "Bearer " + "control-".repeat(6) };
async function registerTransitionBranch(f, input = {}) {
  const payload = { origin, id: branchId, secret: branchSecret, generation: 1, ...input };
  const response = await f.app.inject({
    method: "POST", url: "/api/internal/hub/branches",
    headers: serviceAuthorization, payload,
  });
  assert.equal(response.statusCode, 200);
  return payload;
}
const writeTransition = (f, input = {}, headers = serviceAuthorization) => f.app.inject({
  method: "POST", url: "/api/internal/hub/branch-transitions", headers,
  payload: { origin, expectedGeneration: 1, revision: 1, active: true, ...input },
});

test("branch transition defaults absent and state query cannot invent a destination", async () => {
  const f = await fixture();
  try {
    const s = await f.signin();
    const state = await f.app.inject({
      url: "/api/hub/state?endpointTransition=1&hubOrigin=https%3A%2F%2Fattacker.example&destination=https%3A%2F%2Fattacker.example",
      headers: { cookie: s.cookie, "x-atlas-endpoint-transition": "1" },
    });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().authenticated, true);
    assert.equal(state.json().hubOrigin, hubOrigin);
    assert.equal(state.json().endpointTransition, undefined);
  } finally { await f.done(); }
});

test("branch transition control requires service authorization and rejects browser Origin", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { ...serviceAuthorization, origin }]) {
      assert.equal((await writeTransition(f, {}, headers)).statusCode, 401);
    }
    assert.equal(JSON.parse(f.store.unseal(f.store.get("hubBranchRegistry")[origin])).transition, undefined);
  } finally { await f.done(); }
});

test("authenticated transition preserves cookie, grant and current profile/backup access without reviving retired sync", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    const s = await f.signin();
    const before = (await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } })).json();
    const changed = await writeTransition(f);
    assert.equal(changed.statusCode, 200);
    assert.deepEqual(changed.json(), { ok: true, generation: 1, revision: 1, active: true });
    const state = await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } });
    assert.equal(state.statusCode, 200);
    assert.equal(state.headers["set-cookie"], undefined);
    assert.equal(state.json().authenticated, true);
    assert.deepEqual(state.json().grant, before.grant);
    assert.equal(state.json().csrf, before.csrf);
    assert.deepEqual(state.json().endpointTransition, { revision: 1, hubOrigin });
    for (const path of ["preferences", "backups/v2/replicas"]) {
      const response = await f.app.inject({
        method: "POST", url: "/api/hub/profile/" + path,
        headers: { cookie: s.cookie, origin, "x-atlas-hub-csrf": before.csrf },
        payload: { namespace: { kind: "atlas" }, checkpoint: "still available" },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(f.calls.at(-1).url, hubOrigin + "/api/hub/branch/profile/" + path);
    }
    for (const path of ["backups/v2/capabilities", "backups/v2/checkpoints/latest"]) {
      const response = await f.app.inject({ url: "/api/hub/profile/" + path, headers: { cookie: s.cookie } });
      assert.equal(response.statusCode, 200);
      assert.equal(f.calls.at(-1).url, hubOrigin + "/api/hub/branch/profile/" + path);
    }
    const beforeRetired = f.calls.length;
    for (const path of ["commits", "writers", "recoveries"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/hub/profile/" + path, headers: { cookie: s.cookie, origin, "x-atlas-hub-csrf": before.csrf }, payload: {} });
      assert.equal(response.statusCode, 410);
      assert.equal(response.json().error.code, "PROFILE_LEGACY_SYNC_RETIRED");
    }
    assert.equal(f.calls.length, beforeRetired, "transition metadata never re-enables retired mutation forwarding");
    const events = await f.app.inject({ url: "/api/hub/profile/events", headers: { cookie: s.cookie } });
    assert.equal(events.statusCode, 200);
    assert.match(events.body, /profile\.writers\.resync/);
  } finally { await f.done(); }
});

test("transition metadata remains sealed and never exports branch or session credentials", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    const s = await f.signin();
    assert.equal((await writeTransition(f)).statusCode, 200);
    const stored = f.store.get("hubBranchRegistry")[origin];
    assert.ok(!stored.includes(branchSecret));
    assert.ok(!stored.includes('"transition"'));
    assert.deepEqual(JSON.parse(f.store.unseal(stored)), {
      id: branchId, secret: branchSecret, generation: 1,
      transition: { revision: 1, active: true },
    });
    const state = await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } });
    for (const secret of [branchSecret, rawSession, "control-".repeat(6), "never-forward-this"])
      assert.ok(!state.body.includes(secret));
    assert.equal(state.json().endpointTransition.destination, undefined);
  } finally { await f.done(); }
});

test("an active transition is emitted only for its authenticated exact registered origin", async () => {
  const f = await fixture();
  try {
    const second = "https://second.example";
    await registerTransitionBranch(f);
    await registerTransitionBranch(f, { origin: second, id: randomUUID(), secret: "v".repeat(43) });
    const a = await f.signin(), b = await f.signin(second);
    assert.equal((await writeTransition(f)).statusCode, 200);
    const signedOut = await f.app.inject("/api/hub/state");
    assert.equal(signedOut.json().authenticated, false);
    assert.equal(signedOut.json().endpointTransition, undefined);
    const other = await f.app.inject({ url: "/api/hub/state", headers: { cookie: b.cookie, "x-fixture-origin": second } });
    assert.equal(other.json().authenticated, true);
    assert.equal(other.json().endpointTransition, undefined);
    const wrongHost = await f.app.inject({ url: "/api/hub/state", headers: { cookie: a.cookie, "x-fixture-origin": second } });
    assert.equal(wrongHost.json().authenticated, false);
    assert.equal(wrongHost.json().endpointTransition, undefined);
  } finally { await f.done(); }
});

test("transition control requires an existing stored branch and exact credential generation", async () => {
  const f = await fixture();
  try {
    // Environment-only fallback credentials are not a mutable stored registry record.
    assert.equal((await writeTransition(f)).statusCode, 409);
    await registerTransitionBranch(f);
    assert.equal((await writeTransition(f, { expectedGeneration: 2 })).statusCode, 409);
    assert.equal((await writeTransition(f, { origin: "https://missing.example" })).statusCode, 409);
    assert.equal((await writeTransition(f)).statusCode, 200);
    assert.equal((await writeTransition(f, { expectedGeneration: 2, revision: 2, active: false })).statusCode, 409);
  } finally { await f.done(); }
});

test("transition revisions advance one at a time with exact idempotent replay only", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    assert.equal((await writeTransition(f, { revision: 2 })).statusCode, 409);
    assert.equal((await writeTransition(f)).statusCode, 200);
    const before = f.store.get("hubBranchRegistry")[origin];
    const replay = await writeTransition(f);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), { ok: true, generation: 1, revision: 1, active: true, replayed: true });
    assert.equal(f.store.get("hubBranchRegistry")[origin], before);
    assert.equal((await writeTransition(f, { active: false })).statusCode, 409);
    assert.equal((await writeTransition(f, { revision: 3 })).statusCode, 409);
  } finally { await f.done(); }
});

test("clearing a transition uses the next revision and retains the established session", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    const s = await f.signin();
    assert.equal((await writeTransition(f)).statusCode, 200);
    const clear = await writeTransition(f, { revision: 2, active: false });
    assert.equal(clear.statusCode, 200);
    assert.deepEqual(clear.json(), { ok: true, generation: 1, revision: 2, active: false });
    const state = await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } });
    assert.equal(state.json().authenticated, true);
    assert.equal(state.json().endpointTransition, undefined);
    assert.equal((await writeTransition(f, { revision: 2, active: false })).json().replayed, true);
    assert.equal((await writeTransition(f)).statusCode, 409);
    assert.equal((await writeTransition(f, { revision: 3 })).statusCode, 200);
  } finally { await f.done(); }
});

test("branch credential replay retains transition while a higher generation clears it", async () => {
  const f = await fixture();
  try {
    const input = await registerTransitionBranch(f);
    const s = await f.signin();
    assert.equal((await writeTransition(f)).statusCode, 200);
    await registerTransitionBranch(f, input);
    assert.deepEqual((await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } })).json().endpointTransition, { revision: 1, hubOrigin });
    await registerTransitionBranch(f, { ...input, generation: 2 });
    assert.equal(JSON.parse(f.store.unseal(f.store.get("hubBranchRegistry")[origin])).transition, undefined);
    assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } })).json().authenticated, false);
    assert.equal((await writeTransition(f)).statusCode, 409);
    const fresh = await f.signin();
    assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: fresh.cookie } })).json().endpointTransition, undefined);
    assert.equal((await writeTransition(f, { expectedGeneration: 2 })).statusCode, 200);
  } finally { await f.done(); }
});

test("transition control rejects extra fields, noncanonical origins and invalid revision types", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    for (const input of [
      { destination: "https://attacker.example" }, { hubOrigin: "https://attacker.example" },
      { secret: "x".repeat(43) }, { generation: 2 },
      { origin: "http://branch.example" }, { origin: origin + "/" },
      { origin: origin + "/path" }, { origin: origin + "?x=1" },
      { expectedGeneration: 0 }, { expectedGeneration: "1" },
      { revision: 0 }, { revision: -1 }, { revision: "1" },
      { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
      { active: 1 }, { active: "true" }, { active: null },
    ]) assert.equal((await writeTransition(f, input)).statusCode, 400, JSON.stringify(input));
    assert.equal(JSON.parse(f.store.unseal(f.store.get("hubBranchRegistry")[origin])).transition, undefined);
  } finally { await f.done(); }
});

test("configuration-only branch entries never emit transition metadata", async () => {
  const f = await fixture({ configuration: { hubBranches: [{
    origin, id: branchId, secret: branchSecret, generation: 1,
    transition: { revision: 99, active: true },
  }] } });
  try {
    const s = await f.signin();
    const state = await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } });
    assert.equal(state.json().authenticated, true);
    assert.equal(state.json().endpointTransition, undefined);
    assert.equal((await writeTransition(f)).statusCode, 409);
  } finally { await f.done(); }
});

test("transition enable and clear do not revoke established browsing ownership", async () => {
  let revoked = 0;
  const f = await fixture({ pool: {
    setRequireHubOwnership() {}, refreshHubIdentity() {},
    revokeHubSession() { revoked++; },
  } });
  try {
    await registerTransitionBranch(f);
    const s = await f.signin();
    assert.equal((await writeTransition(f)).statusCode, 200);
    f.advance(46000);
    assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } })).json().authenticated, true);
    assert.equal((await writeTransition(f, { revision: 2, active: false })).statusCode, 200);
    assert.equal(revoked, 0);
    assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } })).json().authenticated, true);
    assert.equal(revoked, 0);
  } finally { await f.done(); }
});

test("competing transition writes cannot accept two different states for one revision", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    const results = await Promise.all([writeTransition(f), writeTransition(f, { active: false })]);
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
    const stored = JSON.parse(f.store.unseal(f.store.get("hubBranchRegistry")[origin]));
    assert.equal(stored.transition.revision, 1);
    assert.equal(typeof stored.transition.active, "boolean");
    assert.equal((await writeTransition(f, { revision: 2, active: false })).statusCode, 200);
  } finally { await f.done(); }
});

test("malformed persisted transition fails closed and a rejected write releases its transaction", async () => {
  const f = await fixture();
  try {
    await registerTransitionBranch(f);
    const original = f.store.get("hubBranchRegistry")[origin];
    const entry = JSON.parse(f.store.unseal(original));
    f.store.set("hubBranchRegistry", { [origin]: f.store.seal(JSON.stringify({ ...entry, transition: { revision: "1", active: true } })) });
    const s = await f.signin();
    assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: s.cookie } })).json().endpointTransition, undefined);
    assert.equal((await writeTransition(f)).statusCode, 409);
    f.store.set("hubBranchRegistry", { [origin]: original });
    assert.equal((await writeTransition(f)).statusCode, 200);
  } finally { await f.done(); }
});

const announcementId = "77777777-7777-4777-8777-777777777777";
test("announcements proxy allows only verified detail/read, with CSRF and server-owned credentials", async () => {
  const f = await fixture();
  try {
    const path = "/api/hub/support/announcements/" + announcementId;
    assert.equal((await f.app.inject(path)).statusCode, 401);
    const s = await f.signin();
    const state = (await f.app.inject({url:"/api/hub/state",headers:{cookie:s.cookie}})).json();
    const detail = await f.app.inject({url:path,headers:{cookie:s.cookie,authorization:"Bearer forged","x-atlas-branch-session":"forged"}});
    assert.equal(detail.statusCode, 200, detail.body);
    let forwarded = f.calls.find(v=>v.url.endsWith("/announcements/"+announcementId));
    assert.equal(forwarded.url, hubOrigin+"/api/hub/branch/announcements/"+announcementId);
    assert.equal(forwarded.opts.headers.authorization,"Bearer "+branchSecret);
    assert.equal(forwarded.opts.headers["x-atlas-branch-session"],rawSession);
    assert.equal(forwarded.opts.redirect,"error");
    const noCsrf = await f.app.inject({method:"POST",url:path+"/read",headers:{cookie:s.cookie},payload:{}});
    assert.equal(noCsrf.statusCode,403);
    const read = await f.app.inject({method:"POST",url:path+"/read",headers:{cookie:s.cookie,origin,"x-atlas-hub-csrf":state.csrf},payload:{}});
    assert.equal(read.statusCode,200,read.body);
    forwarded=f.calls.find(v=>v.url.endsWith("/announcements/"+announcementId+"/read"));
    assert.equal(forwarded.opts.method,"POST");
    const count=f.calls.length;
    for(const url of [path+"?user=forged",path+"/withdraw","/api/hub/support/announcements/not-a-uuid","/api/hub/support/announcements/00000000-0000-0000-0000-000000000000","/api/hub/support/announcements"]){
      assert.equal((await f.app.inject({url,headers:{cookie:s.cookie}})).statusCode,404,url);
    }
    assert.equal((await f.app.inject({method:"POST",url:"/api/hub/support/announcements",headers:{cookie:s.cookie,origin,"x-atlas-hub-csrf":state.csrf},payload:{title:"not published",body:"fixture"}})).statusCode,404);
    assert.equal(f.calls.length,count,"Disallowed paths must not reach Hub.");
    f.advance(46000);f.revoke();
    assert.equal((await f.app.inject({url:path,headers:{cookie:s.cookie}})).statusCode,401);
  } finally { await f.done(); }
});

test("support media stays owner-authenticated, fixed-path, CSRF protected and only message routes accept large payloads", async () => {
  const f = await fixture();
  const ticket = "77777777-7777-4777-8777-777777777777";
  const attachment = "88888888-8888-4888-8888-888888888888";
  const path = `/api/hub/support/tickets/${ticket}/attachments/${attachment}`;
  try {
    assert.equal((await f.app.inject(path)).statusCode, 401);
    const session = await f.signin();
    const headers = { cookie: session.cookie, origin };
    const state = (await f.app.inject({ url: "/api/hub/state", headers })).json();
    const result = await f.app.inject({ url: path, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "private, no-store");
    const call = f.calls.find(c => c.url.endsWith(`/api/hub/branch/tickets/${ticket}/attachments/${attachment}`));
    assert.equal(call.opts.headers["x-atlas-branch-session"], rawSession);
    assert.equal(call.opts.headers.authorization, "Bearer " + branchSecret);
    assert.equal((await f.app.inject({ url: path + "?owner=forged", headers })).statusCode, 404);
    const payload = { body: "Please inspect this recording.", attachments: [{ name: "recording.webm", mimeType: "video/webm", dataBase64: "A".repeat(14000) }] };
    const messages = `/api/hub/support/tickets/${ticket}/messages`;
    assert.equal((await f.app.inject({ method: "POST", url: messages, headers, payload })).statusCode, 403);
    headers["x-atlas-hub-csrf"] = state.csrf;
    assert.equal((await f.app.inject({ method: "POST", url: messages, headers, payload })).statusCode, 200);
    assert.deepEqual(JSON.parse(f.calls.at(-1).opts.body), payload);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/hub/support/tickets", headers, payload: { ...payload, subject: "Media report" } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/hub/support/tickets/${ticket}/read`, headers, payload: { pad: "x".repeat(13000) } })).statusCode, 413);
  } finally { await f.done(); }
});


test("upstream body timeout and malformed JSON preserve authentication and log only transport metadata", async () => {
  for (const name of ["TimeoutError", "AbortError", "SyntaxError"]) {
    const f = await fixture();
    try {
      const signed = await f.signin();
      assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: signed.cookie } })).json().authenticated, true);
      const logs = [];
      f.app.log.error = (metadata, message) => { if (message === "Atlas Hub response could not be decoded.") logs.push({ metadata, message }); };
      f.advance(45001);
      const before = f.calls.length;
      f.upstream(path => path.endsWith("/session") ? {
        status: name === "SyntaxError" ? 502 : 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        json: async () => { throw Object.assign(Error("PRIVATE_RESPONSE_BODY_" + rawSession), { name, code: "UND_ERR_BODY_TIMEOUT" }); },
      } : undefined);
      const response = await f.app.inject({ url: "/api/hub/state", headers: { cookie: signed.cookie } });
      assert.equal(response.statusCode, name === "SyntaxError" ? 502 : 503);
      assert.equal(response.headers["set-cookie"], undefined, "availability failures must not clear the session");
      assert.equal(f.calls.length - before, 1, "failed POST validation must not retry");
      assert.deepEqual(logs, [{ metadata: {
        upstreamPath: "/api/hub/branch/session",
        upstreamStatus: name === "SyntaxError" ? 502 : 200,
        upstreamContentType: "text/html; charset=utf-8",
        errorName: name,
        errorCode: "UND_ERR_BODY_TIMEOUT",
      }, message: "Atlas Hub response could not be decoded." }]);
      const recorded = JSON.stringify(logs);
      for (const secret of [rawSession, branchSecret, signed.cookie, "PRIVATE_RESPONSE_BODY"])
        assert.equal(recorded.includes(secret), false);
      f.upstream(undefined);
      assert.equal((await f.app.inject({ url: "/api/hub/state", headers: { cookie: signed.cookie } })).json().authenticated, true);
    } finally { await f.done(); }
  }
});
