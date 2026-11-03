import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { hashSecret } from "./security.js";
import {
  encodePortableValue,
  hubNamespace,
  decodePortableValue,
  hubSiteGroup,
} from "@atlas-link-dispenser/shared";
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
integration(
  "Hub identity and encrypted portable profiles (isolated PostgreSQL)",
  () => {
    const schema = "hub_" + randomUUID().replaceAll("-", "");
    let maintenance: Pool,
      pool: Pool,
      app: Awaited<ReturnType<typeof buildApp>>["app"];
    const secret = randomUUID(),
      csrf = "fixture-csrf-" + secret;
    let userId: string,
      otherId: string,
      branch: any,
      headers: any,
      headers2: any;
    const browser = (label = "user") => ({
      cookie: "ald_session=" + secret + label,
      "x-csrf-token": csrf,
    });
    async function request(
      method: any,
      path: string,
      body?: unknown,
      h = headers,
    ) {
      return app.inject({
        method,
        url: path,
        headers: h,
        ...(body === undefined ? {} : { payload: body as any }),
      });
    }
    async function login(label = "user", contextId = randomUUID()) {
      const verifier =
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const codeChallenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const handoff = await request(
        "POST",
        "/api/hub/handoffs",
        {
          branchId: branch.id,
          codeChallenge,
          state: "fixture-state-123456789",
        },
        browser(label),
      );
      expect(handoff.statusCode).toBe(200);
      const exchanged = await request(
        "POST",
        "/api/hub/branch/exchange",
        { code: handoff.json().code, verifier, contextId },
        {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
        },
      );
      expect(exchanged.statusCode).toBe(200);
      return {
        headers: {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
          "x-atlas-branch-session": exchanged.json().branchSession,
        },
        grant: exchanged.json().grant,
        code: handoff.json().code,
        verifier,
      };
    }
    beforeAll(async () => {
      if (!new URL(url!).pathname.endsWith("_test"))
        throw Error("Dedicated _test PostgreSQL required");
      maintenance = new Pool({ connectionString: url });
      const extensionSetup = await maintenance.connect();
      try {
        await extensionSetup.query("SELECT pg_advisory_lock(870412201)");
        await extensionSetup.query(
          "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
        );
        const extension = await extensionSetup.query(
          "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname='pgcrypto'",
        );
        if (extension.rows[0]?.schema !== "public")
          await extensionSetup.query(
            "ALTER EXTENSION pgcrypto SET SCHEMA public",
          );
      } finally {
        await extensionSetup.query("SELECT pg_advisory_unlock(870412201)");
        extensionSetup.release();
      }
      await maintenance.query("CREATE SCHEMA " + schema);
      pool = new Pool({
        connectionString: url,
        options: "-c search_path=" + schema + ",public",
      });
      for (const file of (
        await readdir(
          resolve(import.meta.dirname, "../../../packages/database/migrations"),
        )
      )
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(
          await readFile(
            resolve(
              import.meta.dirname,
              "../../../packages/database/migrations",
              file,
            ),
            "utf8",
          ),
        );
      for (const [label, role] of [
        ["admin", "admin"],
        ["user", "user"],
        ["other", "user"],
      ]) {
        const r = (
          await pool.query(
            "INSERT INTO users(email,normalized_email,role,verified_at)VALUES($1,$1,$2::role,now())RETURNING id",
            [label + "@example.test", role],
          )
        ).rows[0];
        if (label === "user") userId = r.id;
        if (label === "other") otherId = r.id;
        await pool.query(
          "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at)VALUES($1,$2,$3,now()+interval '1 day')",
          [
            r.id,
            hashSecret(secret + label, config.sessionSecret),
            hashSecret(csrf, config.sessionSecret),
          ],
        );
      }
      const redis = {
        status: "ready",
        ping: async () => "PONG",
        incr: async () => 1,
        expire: async () => 1,
      };
      app = (await buildApp({ pool, redis: redis as any, hubEnabled: true }))
        .app;
      await app.ready();
      const link = (
        await pool.query(
          "INSERT INTO links(name,url,health_status)VALUES('Fixture branch','https://branch.example.test','healthy')RETURNING id",
        )
      ).rows[0];
      for (const id of [userId, otherId])
        await pool.query(
          "INSERT INTO link_assignments(user_id,link_id)VALUES($1,$2)",
          [id, link.id],
        );
      const enrolled = await request(
        "POST",
        "/api/admin/hub/branches",
        { linkId: link.id },
        browser("admin"),
      );
      expect(enrolled.statusCode).toBe(200);
      branch = { ...enrolled.json().branch, secret: enrolled.json().secret };
      headers = (await login()).headers;
      headers2 = (await login()).headers;
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await maintenance?.query("DROP SCHEMA " + schema + " CASCADE");
      await maintenance?.end();
    });
    it("explicit branch sign-out releases its writer immediately without exposing another account", async () => {
      const a=await login(),b=await login(),namespace={kind:"local",origin:"https://signout-release.example"};
      const owned=await request("POST","/api/hub/branch/profile/writers",{namespace},a.headers);
      expect(owned.statusCode).toBe(200);
      expect((await request("POST","/api/hub/branch/profile/writers",{namespace},b.headers)).statusCode).toBe(409);
      expect((await request("DELETE","/api/hub/branch/session",undefined,a.headers)).statusCode).toBe(200);
      const next=await request("POST","/api/hub/branch/profile/writers",{namespace},b.headers);
      expect(next.statusCode).toBe(200);expect(next.json().writer.epoch).toBe(owned.json().writer.epoch+1);
      expect((await request("PUT","/api/hub/branch/profile/writers",{namespace,epoch:owned.json().writer.epoch},a.headers)).statusCode).toBe(401);
    });
    it("replays an acknowledged handoff without extending or rewriting ready/used writer ownership", async () => {
      const a = await login(),
        b = await login();
      const namespace = {
        kind: "local",
        origin: "https://ack-response-loss.example",
      };
      const owned = await request(
        "POST",
        "/api/hub/branch/profile/writers",
        { namespace },
        a.headers,
      );
      expect(owned.statusCode).toBe(200);
      const taken = await request(
        "POST",
        "/api/hub/branch/profile/writers/takeover",
        { namespace },
        b.headers,
      );
      expect(taken.statusCode).toBe(200);
      const id = taken.json().handoffId;
      const ack = () =>
        request(
          "POST",
          `/api/hub/branch/profile/writers/requests/${id}/ack`,
          { flushed: true },
          a.headers,
        );
      expect((await ack()).json()).toEqual({ acknowledged: true });
      const ready = (
        await pool.query(
          "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2",
          [a.grant.profileId, hubSiteGroup(namespace.origin)],
        )
      ).rows[0];
      await pool.query(
        "UPDATE hub_writer_handoffs SET expires_at=now()-interval '1 second' WHERE id=$1",
        [id],
      );
      const replay = await ack();
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ acknowledged: true });
      expect(
        (
          await pool.query(
            "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2",
            [a.grant.profileId, hubSiteGroup(namespace.origin)],
          )
        ).rows[0],
      ).toEqual(ready);
      await pool.query(
        "UPDATE hub_writer_handoffs SET expires_at=now()+interval '1 minute' WHERE id=$1",
        [id],
      );
      const next = await request(
        "POST",
        "/api/hub/branch/profile/writers",
        { namespace, handoffId: id },
        b.headers,
      );
      expect(next.statusCode).toBe(200);
      expect(next.json().writer.epoch).toBe(owned.json().writer.epoch + 1);
      const used = (
        await pool.query(
          "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2",
          [a.grant.profileId, hubSiteGroup(namespace.origin)],
        )
      ).rows[0];
      await pool.query(
        "UPDATE hub_writer_handoffs SET expires_at=now()-interval '1 second' WHERE id=$1",
        [id],
      );
      expect((await ack()).statusCode).toBe(200);
      expect(
        (
          await pool.query(
            "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2",
            [a.grant.profileId, hubSiteGroup(namespace.origin)],
          )
        ).rows[0],
      ).toEqual(used);
      expect(
        (
          await request(
            "PUT",
            "/api/hub/branch/profile/writers",
            { namespace, epoch: owned.json().writer.epoch },
            a.headers,
          )
        ).statusCode,
      ).toBe(409);
    });
    it("denies unflushed, wrong-context and wrong-profile ACKs before and after acquisition", async () => {
      const a = await login(),
        b = await login(),
        wrongContext = await login(),
        foreign = await login("other");
      const namespace = {
        kind: "local",
        origin: "https://ack-authorization.example",
      };
      expect(
        (
          await request(
            "POST",
            "/api/hub/branch/profile/writers",
            { namespace },
            a.headers,
          )
        ).statusCode,
      ).toBe(200);
      const taken = await request(
        "POST",
        "/api/hub/branch/profile/writers/takeover",
        { namespace },
        b.headers,
      );
      const id = taken.json().handoffId,
        path = `/api/hub/branch/profile/writers/requests/${id}/ack`;
      for (const headers of [wrongContext.headers, foreign.headers, b.headers])
        expect(
          (await request("POST", path, { flushed: true }, headers)).statusCode,
        ).toBe(409);
      const sameContextNewSession = await login("user", a.grant.contextId);
      const pendingOwner = await request(
        "GET",
        "/api/hub/branch/profile/writers/requests",
        undefined,
        a.headers,
      );
      expect(pendingOwner.json().requests.some((r: any) => r.id === id)).toBe(true);
      const pendingOtherSession = await request(
        "GET",
        "/api/hub/branch/profile/writers/requests",
        undefined,
        sameContextNewSession.headers,
      );
      expect(
        pendingOtherSession.json().requests.some((r: any) => r.id === id),
      ).toBe(false);
      expect(
        (
          await request(
            "POST",
            path,
            { flushed: true },
            sameContextNewSession.headers,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (await request("POST", path, { flushed: false }, a.headers)).statusCode,
      ).toBe(400);
      expect(
        (await request("POST", path, { flushed: true }, a.headers)).statusCode,
      ).toBe(200);
      for (const headers of [wrongContext.headers, foreign.headers, b.headers])
        expect(
          (await request("POST", path, { flushed: true }, headers)).statusCode,
        ).toBe(409);
      expect(
        (
          await request(
            "POST",
            "/api/hub/branch/profile/writers",
            { namespace, handoffId: id },
            b.headers,
          )
        ).statusCode,
      ).toBe(200);
      for (const headers of [wrongContext.headers, foreign.headers, b.headers])
        expect(
          (await request("POST", path, { flushed: true }, headers)).statusCode,
        ).toBe(409);
    });
    it("does not treat another session's matching context token as free writer ownership", async () => {
      const contextId = randomUUID(),
        a = await login("user", contextId),
        b = await login("user", contextId);
      const namespace = {
        kind: "local",
        origin: "https://same-context-different-session.example",
      };
      expect(
        (
          await request(
            "POST",
            "/api/hub/branch/profile/writers",
            { namespace },
            a.headers,
          )
        ).statusCode,
      ).toBe(200);
      const taken = await request(
        "POST",
        "/api/hub/branch/profile/writers/takeover",
        { namespace },
        b.headers,
      );
      expect(taken.statusCode).toBe(200);
      expect(taken.json()).toEqual({
        handoffId: expect.any(String),
        status: "waiting",
      });
    });
    it("wakes the exact owner/requester after durable writer changes, but not routine renewal", async () => {
      const a = await login(),
        b = await login(),
        c = await login();
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const wait = async (check: () => boolean) => {
        const deadline = Date.now() + 3000;
        while (!check()) {
          if (Date.now() > deadline)
            throw Error("Expected writer hint did not arrive");
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      const watch = async (h: any) => {
        const abort = new AbortController();
        const response = await fetch(origin + "/api/hub/branch/profile/events", {
          headers: h,
          signal: abort.signal,
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader(),
          decoder = new TextDecoder();
        let text = "";
        const reading = (async () => {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              text += decoder.decode(next.value, { stream: true });
            }
          } catch (error) {
            if (!abort.signal.aborted) throw error;
          }
        })();
        await wait(() => text.includes('"profile.writers.resync"'));
        return {
          changed: () => text.split('"profile.writers.changed"').length - 1,
          async close() {
            abort.abort();
            await reading;
          },
        };
      };
      const owner = await watch(a.headers),
        requester = await watch(b.headers),
        third = await watch(c.headers);
      const namespace = {
        kind: "local",
        origin: "https://writer-live-wakeup.example",
      };
      try {
        const acquired = await request(
          "POST",
          "/api/hub/branch/profile/writers",
          { namespace },
          a.headers,
        );
        const epoch = acquired.json().writer.epoch;
        expect(
          (
            await request(
              "PUT",
              "/api/hub/branch/profile/writers",
              { namespace, epoch },
              a.headers,
            )
          ).statusCode,
        ).toBe(200);
        await new Promise((r) => setTimeout(r, 50));
        expect(owner.changed()).toBe(0);
        expect(requester.changed()).toBe(0);
        expect(third.changed()).toBe(0);
        const takeover = await request(
          "POST",
          "/api/hub/branch/profile/writers/takeover",
          { namespace },
          b.headers,
        );
        await wait(() => owner.changed() === 1);
        expect(requester.changed()).toBe(0);
        expect(third.changed()).toBe(0);
        const id = takeover.json().handoffId;
        expect(
          (
            await request(
              "POST",
              `/api/hub/branch/profile/writers/requests/${id}/ack`,
              { flushed: true },
              a.headers,
            )
          ).statusCode,
        ).toBe(200);
        await wait(() => requester.changed() === 1);
        expect(
          (
            await request(
              "POST",
              "/api/hub/branch/profile/writers",
              { namespace, handoffId: id },
              b.headers,
            )
          ).statusCode,
        ).toBe(200);
        await wait(() => owner.changed() === 2);
        const next = await request(
          "POST",
          "/api/hub/branch/profile/writers/takeover",
          { namespace },
          c.headers,
        );
        expect(next.json().status).toBe("waiting");
        await wait(() => requester.changed() === 2);
        expect(third.changed()).toBe(0);
        expect(
          (
            await request(
              "DELETE",
              "/api/hub/branch/profile/writers",
              { namespace, epoch: epoch + 1 },
              b.headers,
            )
          ).statusCode,
        ).toBe(200);
        await wait(() => third.changed() === 1);
      } finally {
        await Promise.all([owner, requester, third].map((s) => s.close()));
      }
    });
    it("types only the matching owner's expired waiting request without mutating a later writer", async () => {
      const a = await login(),
        b = await login(),
        other = await login(),
        foreign = await login("other");
      const namespace = {
        kind: "local",
        origin: "https://expired-waiting-handoff.example",
      };
      const owned = await request(
        "POST",
        "/api/hub/branch/profile/writers",
        { namespace },
        a.headers,
      );
      const taken = await request(
        "POST",
        "/api/hub/branch/profile/writers/takeover",
        { namespace },
        b.headers,
      );
      const id = taken.json().handoffId,
        path = `/api/hub/branch/profile/writers/requests/${id}/ack`;
      await pool.query(
        "UPDATE hub_writer_handoffs SET expires_at=now()-interval '1 second' WHERE id=$1",
        [id],
      );
      const expired = await request("POST", path, { flushed: true }, a.headers);
      expect(expired.statusCode).toBe(409);
      expect(expired.json().error.code).toBe("HUB_HANDOFF_EXPIRED");
      for (const h of [other.headers, foreign.headers, b.headers]) {
        const denied = await request("POST", path, { flushed: true }, h);
        expect(denied.statusCode).toBe(409);
        expect(denied.json().error.code).toBe("HUB_CONFLICT");
      }
      await pool.query(
        "UPDATE hub_writers SET expires_at=now()-interval '1 second' WHERE profile_id=$1 AND site_group=$2",
        [a.grant.profileId, hubSiteGroup(namespace.origin)],
      );
      const next = await request(
        "POST",
        "/api/hub/branch/profile/writers",
        { namespace },
        b.headers,
      );
      expect(next.statusCode).toBe(200);
      expect(next.json().writer.epoch).toBe(owned.json().writer.epoch + 1);
      const before = (
        await pool.query(
          "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2",
          [a.grant.profileId, hubSiteGroup(namespace.origin)],
        )
      ).rows[0];
      expect(
        (await request("POST", path, { flushed: true }, a.headers)).json().error
          .code,
      ).toBe("HUB_HANDOFF_EXPIRED");
      expect(
        (
          await pool.query(
            "SELECT * FROM hub_writers WHERE profile_id=$1 AND site_group=$2",
            [a.grant.profileId, hubSiteGroup(namespace.origin)],
          )
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await pool.query("SELECT status FROM hub_writer_handoffs WHERE id=$1", [
            id,
          ])
        ).rows[0].status,
      ).toBe("waiting");
    });
    it("uses one-use destination-bound PKCE handoffs and stable account profiles", async () => {
      const a = await login();
      expect(a.grant.userId).toBe(userId);
      const b = await login();
      expect(b.grant.profileId).toBe(a.grant.profileId);
      const again = await request(
        "POST",
        "/api/hub/branch/exchange",
        { code: a.code, verifier: a.verifier },
        {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
        },
      );
      expect(again.statusCode).toBe(401);
      const wrong = await request(
        "POST",
        "/api/hub/branch/exchange",
        { code: a.code, verifier: a.verifier },
        {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + randomUUID().repeat(2),
        },
      );
      expect(wrong.statusCode).not.toBe(200);
      expect(
        (await request("GET", "/api/hub/branch/profile", undefined, browser()))
          .statusCode,
      ).not.toBe(200);
    });
    it("rejects unassigned branches and revoked ownership without spending quota", async () => {
      const link = (
        await pool.query(
          "INSERT INTO links(name,url,health_status)VALUES('Other branch','https://other-branch.example.test','healthy')RETURNING id",
        )
      ).rows[0];
      const enrolled = await request(
        "POST",
        "/api/admin/hub/branches",
        { linkId: link.id },
        browser("admin"),
      );
      const r = await request(
        "POST",
        "/api/hub/handoffs",
        {
          branchId: enrolled.json().branch.id,
          codeChallenge: "a".repeat(43),
          state: "fixture-state-123456789",
        },
        browser(),
      );
      expect(r.statusCode).toBe(403);
      const listed = await request(
        "GET",
        "/api/hub/branches",
        undefined,
        browser(),
      );
      expect(listed.json().branches).toHaveLength(1);
    });
    it("locks cookie-sharing sibling origins while preserving exact origin storage", async () => {
      const namespace = { kind: "local", origin: "https://app.example.test" };
      const a = await request("POST", "/api/hub/branch/profile/writers", {
        namespace,
      });
      expect(a.statusCode).toBe(200);
      const b = await request(
        "POST",
        "/api/hub/branch/profile/writers",
        {
          namespace: {
            kind: "idb",
            origin: "http://login.example.test:8080",
            name: "save",
          },
        },
        headers2,
      );
      expect(b.statusCode).toBe(409);
      expect(hubNamespace(namespace as any).key).not.toBe(
        hubNamespace({ kind: "local", origin: "http://app.example.test" }).key,
      );
      expect(hubSiteGroup("https://one.github.io")).not.toBe(
        hubSiteGroup("https://two.github.io"),
      );
      expect(
        hubNamespace({ kind: "cookies", origin: "https://app.example.test" })
          .key,
      ).toBe(
        hubNamespace({ kind: "cookies", origin: "http://login.example.test" })
          .key,
      );
    });
    it("commits encrypted snapshots, exact replay, revisions, journals and fenced takeovers", async () => {
      const namespace = { kind: "local", origin: "https://save.test.example" };
      const lock = await request("POST", "/api/hub/branch/profile/writers", {
        namespace,
      });
      const epoch = lock.json().writer.epoch;
      const payload = await encodePortableValue({
        save: "private-fixture-save",
        a: 1,
      });
      const body = {
        namespace,
        epoch,
        baseRevision: 0,
        idempotencyKey: "fixture_commit_123456",
        mode: "snapshot",
        payload,
      };
      const first = await request(
        "POST",
        "/api/hub/branch/profile/commits",
        body,
      );
      expect(first.statusCode).toBe(200);
      const receipt = await request(
        "GET",
        "/api/hub/branch/profile/receipts/" + body.idempotencyKey,
      );
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toMatchObject({
        acknowledged: true,
        revision: 1,
        mode: "snapshot",
        namespace: JSON.parse(hubNamespace(namespace as any).key),
      });
      expect(receipt.json()).not.toHaveProperty("encryptedPayload");
      expect(first.json()).toMatchObject({
        revision: 1,
        acknowledged: true,
        replayed: false,
      });
      expect(
        (await request("POST", "/api/hub/branch/profile/commits", body)).json(),
      ).toMatchObject({ revision: 1, replayed: true });
      expect(
        (
          await request("POST", "/api/hub/branch/profile/commits", {
            ...body,
            payload: await encodePortableValue({ save: "changed" }),
          })
        ).statusCode,
      ).toBe(409);
      const row = (
        await pool.query(
          "SELECT encrypted_payload FROM hub_streams WHERE namespace=$1",
          [hubNamespace(namespace as any).key],
        )
      ).rows[0];
      expect(row.encrypted_payload).not.toContain("private-fixture-save");
      const read = await request("POST", "/api/hub/branch/profile/stream", {
        namespace,
      });
      expect(decodePortableValue(read.json().snapshot)).toEqual({
        save: "private-fixture-save",
        a: 1,
      });
      const forced = await request("POST","/api/hub/branch/profile/writers",{namespace,takeover:true},headers2);
      expect(forced.statusCode).toBe(409);
      const handoff = await request("POST","/api/hub/branch/profile/writers/takeover",{namespace},headers2);
      expect(handoff.json().status).toBe("waiting");
      const pending=await request("GET","/api/hub/branch/profile/writers/requests");
      expect(pending.json().requests.some((r:any)=>r.id===handoff.json().handoffId)).toBe(true);
      expect((await request("POST","/api/hub/branch/profile/writers",{namespace,handoffId:handoff.json().handoffId},headers2)).statusCode).toBe(409);
      expect((await request("POST","/api/hub/branch/profile/writers/requests/"+handoff.json().handoffId+"/ack",{flushed:true})).statusCode).toBe(200);
      const takeover = await request("POST","/api/hub/branch/profile/writers",{namespace,handoffId:handoff.json().handoffId},headers2);
      expect(takeover.json().writer.epoch).toBe(epoch + 1);
      expect(
        (
          await request("POST", "/api/hub/branch/profile/commits", {
            ...body,
            baseRevision: 1,
            idempotencyKey: "stale_writer_123456",
          })
        ).statusCode,
      ).toBe(409);
      const journal = await request(
        "POST",
        "/api/hub/branch/profile/commits",
        {
          ...body,
          mode: "journal",
          epoch: epoch + 1,
          baseRevision: 1,
          idempotencyKey: "journal_writer_123456",
          payload: await encodePortableValue({
            transaction: [{ op: "put", key: 2, value: "two" }],
          }),
        },
        headers2,
      );
      expect(journal.statusCode).toBe(200);
      const restored = await request("POST", "/api/hub/branch/profile/stream", {
        namespace,
      });
      expect(restored.json().journal).toHaveLength(1);
      expect(restored.json().revision).toBe(2);
    });
    it("isolates accounts, verifies chunk integrity and rechecks authoritative suspension", async () => {
      const other = await login("other");
      const value = Buffer.from("binary-private-fixture");
      const hash = createHash("sha256").update(value).digest("hex");
      expect(
        (
          await request("POST", "/api/hub/branch/profile/chunks", {
            hash,
            data: value.toString("base64"),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await request(
            "GET",
            "/api/hub/branch/profile/chunks/" + hash,
            undefined,
            other.headers,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await request("POST", "/api/hub/branch/profile/chunks", {
            hash,
            data: Buffer.from("tamper").toString("base64"),
          })
        ).statusCode,
      ).toBe(400);
      await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [
        otherId,
      ]);
      expect(
        (
          await request(
            "GET",
            "/api/hub/branch/profile",
            undefined,
            other.headers,
          )
        ).statusCode,
      ).toBe(403);
      await pool.query("UPDATE users SET status='active' WHERE id=$1", [
        otherId,
      ]);
    });
    it("reserves empty imports once and applies them atomically", async () => {
      const a = await login("other"),
        b = await login("other");
      const reserved = await request(
        "POST",
        "/api/hub/branch/profile/imports",
        { claimAccepted: true },
        a.headers,
      );
      expect(reserved.statusCode).toBe(200);
      expect(
        (
          await request(
            "POST",
            "/api/hub/branch/profile/imports",
            { claimAccepted: true },
            b.headers,
          )
        ).statusCode,
      ).toBe(409);
      const payload = await encodePortableValue({ game: "legacy-save" }),
        namespace = { kind: "local", origin: "https://game.example" };
      const manifestHash = sha(
        JSON.stringify([
          [hubNamespace(namespace as any).key, sha(JSON.stringify(payload))],
        ]),
      );
      const commit = await request(
        "POST",
        "/api/hub/branch/profile/imports/" +
          reserved.json().importId +
          "/commit",
        { entries: [{ namespace, payload }], manifestHash },
        a.headers,
      );
      expect(commit.statusCode).toBe(200);
      expect(
        (
          await request(
            "POST",
            "/api/hub/branch/profile/imports",
            { claimAccepted: true },
            b.headers,
          )
        ).statusCode,
      ).toBe(409);
      const read = await request(
        "POST",
        "/api/hub/branch/profile/stream",
        { namespace },
        b.headers,
      );
      expect(decodePortableValue(read.json().snapshot)).toEqual({
        game: "legacy-save",
      });
    });
    it("replaces checkpoint bytes without accumulating quota and keeps idempotency receipts", async () => {
      const namespace = {
        kind: "idb",
        origin: "https://checkpoint.fixture",
        name: "save",
      };
      const epoch = (
        await request("POST", "/api/hub/branch/profile/writers", { namespace })
      ).json().writer.epoch;
      const before = Number(
        (
          await pool.query("SELECT bytes FROM hub_profiles WHERE user_id=$1", [
            userId,
          ])
        ).rows[0].bytes,
      );
      const payload = await encodePortableValue({ save: "x".repeat(100000) });
      let first: any;
      for (let i = 0; i < 3; i++) {
        const body = {
          namespace,
          epoch,
          baseRevision: i,
          idempotencyKey: "checkpoint_fixture_" + i,
          mode: "snapshot",
          payload,
        };
        if (i === 0) first = body;
        expect(
          (await request("POST", "/api/hub/branch/profile/commits", body))
            .statusCode,
        ).toBe(200);
      }
      const profile = (
        await pool.query("SELECT bytes FROM hub_profiles WHERE user_id=$1", [
          userId,
        ])
      ).rows[0];
      expect(Number(profile.bytes) - before).toBe(
        Buffer.byteLength(JSON.stringify(payload)),
      );
      expect(
        (
          await request("POST", "/api/hub/branch/profile/commits", first)
        ).json(),
      ).toMatchObject({ revision: 1, replayed: true });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_commits WHERE namespace=$1 AND encrypted_payload IS NOT NULL",
            [hubNamespace(namespace as any).key],
          )
        ).rows[0].n,
      ).toBe(0); // Immutable receipts do not duplicate the canonical snapshot.
      expect((await pool.query("SELECT count(*)::int n FROM hub_commits WHERE namespace=$1", [hubNamespace(namespace as any).key])).rows[0].n).toBe(3);
      expect(decodePortableValue((await request("POST", "/api/hub/branch/profile/stream", { namespace })).json().snapshot)).toEqual({ save: "x".repeat(100000) });
      expect(
        (
          await request("POST", "/api/hub/branch/profile/stream", {
            namespace,
            after: 1,
          })
        ).statusCode,
      ).toBe(409);
    });
    it("restores chunked portable snapshots and denies policy changes immediately", async () => {
      const namespace = { kind: "local", origin: "https://chunk.fixture" };
      const graph = await encodePortableValue({ saved: "chunk-private-data" });
      const bytes = Buffer.from(JSON.stringify(graph)),
        hash = createHash("sha256").update(bytes).digest("hex");
      expect(
        (
          await request("POST", "/api/hub/branch/profile/chunks", {
            hash,
            data: bytes.toString("base64"),
          })
        ).statusCode,
      ).toBe(200);
      const epoch = (
        await request("POST", "/api/hub/branch/profile/writers", { namespace })
      ).json().writer.epoch;
      const payload = {
        codec: "atlas-chunks-v1",
        hashes: [hash],
        bytes: bytes.length,
        sha256: hash,
      };
      expect(
        (
          await request("POST", "/api/hub/branch/profile/commits", {
            namespace,
            epoch,
            baseRevision: 0,
            idempotencyKey: "chunk_fixture_123456",
            mode: "snapshot",
            payload,
          })
        ).statusCode,
      ).toBe(200);
      const read = await request(
        "GET",
        "/api/hub/branch/profile/chunks/" + hash,
      );
      expect(
        decodePortableValue(
          JSON.parse(Buffer.from(read.json().data, "base64").toString()),
        ),
      ).toEqual({ saved: "chunk-private-data" });
      await pool.query(
        "INSERT INTO manual_verification_domains(domain,enabled)VALUES('example.test',true)",
      );
      try {
        expect(
          (await request("GET", "/api/hub/branch/profile")).statusCode,
        ).toBe(403);
      } finally {
        await pool.query(
          "DELETE FROM manual_verification_domains WHERE domain='example.test'",
        );
      }
    });
    it("revokes branch sessions without allocating links", async () => {
      const loginResult = await login();
      const before = (
        await pool.query("SELECT count(*)::int n FROM link_assignments")
      ).rows[0].n;
      const revoked = await request(
        "DELETE",
        "/api/hub/sessions/" + loginResult.grant.sessionId,
        undefined,
        browser(),
      );
      expect(revoked.statusCode).toBe(200);
      expect(
        (
          await request(
            "POST",
            "/api/hub/branch/session",
            {},
            loginResult.headers,
          )
        ).statusCode,
      ).toBe(401);
      expect(
        (await pool.query("SELECT count(*)::int n FROM link_assignments"))
          .rows[0].n,
      ).toBe(before);
    });
    it("merges independent window preferences with per-key compare-and-set, exact replay and preserved conflicts",async()=>{
      const n="/api/hub/branch/profile/preferences",initial=await request("GET",n);expect(initial.statusCode).toBe(200);
      const patch=async(id:string,changes:any[],h=headers)=>request("POST",n,{idempotencyKey:id,payload:await encodePortableValue({format:"atlas-preferences-patch-v1",changes})},h);
      const a="atlas.windows.v1.11111111-1111-4111-8111-111111111111",b="atlas.windows.v1.22222222-2222-4222-8222-222222222222";
      const x=await login(),y=await login();
      const changes=[{key:a,value:'{"tabs":[]}',base:null}];const first=await patch("window_a_commit_123456",changes,x.headers);expect(first.statusCode).toBe(200);
      expect((await patch("window_b_commit_123456",[{key:b,value:'{"tabs":[1]}',base:null}],y.headers)).statusCode).toBe(200);
      expect((await patch("window_a_commit_123456",changes,x.headers)).json().replayed).toBe(true);
      expect((await patch("window_conflict_123456",[{key:a,value:'overwrite',base:null}],y.headers)).statusCode).toBe(409);
      expect((await patch("forbidden_settings_123456",[{key:'atlas.admin.token',value:'never',base:null}],x.headers)).statusCode).toBe(400);
      const read=await request("GET",n,undefined,x.headers);expect(read.json().values[a]).toBe('{"tabs":[]}');expect(read.json().values[b]).toBe('{"tabs":[1]}');
    });

  },
);
describe("portable profile graph codec", () => {
  it("roundtrips cycles, holes, BigInt, maps, typed views and blobs without JSON loss", async () => {
    const a: any = {
      n: -0,
      b: 99n,
      date: new Date(0),
      map: new Map(),
      set: new Set([1, "two"]),
      binary: new Uint16Array([1, 65535]),
      blob: new Blob(["hello"], { type: "text/plain" }),
      array: new Array(3),
    };
    a.self = a;
    a.map.set(a, "cycle");
    a.array[2] = undefined;
    const wire = await encodePortableValue(a);
    const b = decodePortableValue(wire) as any;
    expect(b.self).toBe(b);
    expect(b.map.get(b)).toBe("cycle");
    expect(Object.is(b.n, -0)).toBe(true);
    expect(b.b).toBe(99n);
    expect(b.binary).toEqual(a.binary);
    expect(0 in b.array).toBe(false);
    expect(await b.blob.text()).toBe("hello");
  });
  it("rejects getters and unknown platform objects, never returns a partial backup", async () => {
    await expect(
      encodePortableValue({
        get secret() {
          throw Error("must not execute");
        },
      }),
    ).rejects.toThrow("Accessor");
    await expect(
      encodePortableValue(new URL("https://example.test")),
    ).rejects.toThrow("Unsupported");
  });
});
