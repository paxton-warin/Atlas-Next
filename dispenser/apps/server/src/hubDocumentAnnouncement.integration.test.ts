import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { DEFAULT_ENTRY_LAUNCH_LINK } from "./entryLaunchLink.js";
import { hashSecret } from "./security.js";

const database = process.env.TEST_DATABASE_URL;
const suite = database ? describe : describe.skip;
suite(
  "Durable account document announcements through Hub and real branch authentication",
  () => {
    const schema = "document_" + randomUUID().replaceAll("-", "");
    const secret = randomUUID(),
      csrf = "fixture-csrf-" + randomUUID();
    const endpoint = "/api/hub/document-announcement";
    const branchEndpoint = "/api/hub/branch/document-announcement";
    const browser = (label = "user") => ({
      cookie: "ald_session=" + secret + label,
      "x-csrf-token": csrf,
    });
    const launch = {
      ...DEFAULT_ENTRY_LAUNCH_LINK,
      hubEnabled: true,
      browserEnabled: true,
    };
    let maintenance: Pool,
      pool: Pool,
      app: Awaited<ReturnType<typeof buildApp>>["app"];
    let userId: string, otherId: string;
    let branchA: Record<string, string>,
      branchB: Record<string, string>,
      otherBranch: Record<string, string>;
    async function request(
      method: any,
      url: string,
      payload?: any,
      headers = browser(),
    ) {
      return app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    }
    async function login(branch: any, label = "user") {
      const verifier =
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const handoff = await request(
        "POST",
        "/api/hub/handoffs",
        {
          branchId: branch.id,
          codeChallenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          state: "document-fixture-state-123456789",
        },
        browser(label),
      );
      expect(handoff.statusCode).toBe(200);
      const exchange = await request(
        "POST",
        "/api/hub/branch/exchange",
        {
          code: handoff.json().code,
          verifier,
          contextId: randomUUID(),
        },
        {
          "x-atlas-branch-id": branch.id,
          authorization: "Bearer " + branch.secret,
        } as any,
      );
      expect(exchange.statusCode).toBe(200);
      return {
        "x-atlas-branch-id": branch.id,
        authorization: "Bearer " + branch.secret,
        "x-atlas-branch-session": exchange.json().branchSession,
      };
    }
    beforeAll(async () => {
      if (!new URL(database!).pathname.endsWith("_test"))
        throw Error("Dedicated test database required");
      maintenance = new Pool({ connectionString: database });
      const client = await maintenance.connect();
      try {
        await client.query("SELECT pg_advisory_lock(870412201)");
        await client.query(
          "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
        );
      } finally {
        await client.query("SELECT pg_advisory_unlock(870412201)");
        client.release();
      }
      await maintenance.query("CREATE SCHEMA " + schema);
      pool = new Pool({
        connectionString: database,
        options: "-c search_path=" + schema + ",public",
      });
      const directory = new URL(
        "../../../packages/database/migrations/",
        import.meta.url,
      );
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, directory), "utf8"));
      for (const label of ["admin", "user", "other"]) {
        const user = (
          await pool.query(
            "INSERT INTO users(email,normalized_email,role,verified_at) VALUES($1,$1,$2::role,now()) RETURNING id",
            [label + "@example.test", label === "admin" ? "admin" : "user"],
          )
        ).rows[0];
        if (label === "user") userId = user.id;
        if (label === "other") otherId = user.id;
        await pool.query(
          "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
          [
            user.id,
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
      const branches: any[] = [];
      for (const number of [1, 2]) {
        const link = (
          await pool.query(
            "INSERT INTO links(name,url,health_status) VALUES($1,$2,'healthy') RETURNING id",
            [
              "Document fixture " + number,
              "https://document-branch" + number + ".example.test",
            ],
          )
        ).rows[0];
        for (const id of [userId, otherId])
          await pool.query(
            "INSERT INTO link_assignments(user_id,link_id) VALUES($1,$2)",
            [id, link.id],
          );
        const response = await request(
          "POST",
          "/api/admin/hub/branches",
          { linkId: link.id },
          browser("admin"),
        );
        expect(response.statusCode).toBe(200);
        branches.push({
          ...response.json().branch,
          secret: response.json().secret,
        });
      }
      branchA = await login(branches[0]);
      branchB = await login(branches[1]);
      otherBranch = await login(branches[0], "other");
    });
    beforeEach(async () => {
      await pool.query("TRUNCATE hub_document_acknowledgements");
      await pool.query(
        "INSERT INTO app_settings(key,value) VALUES('entryLaunchLink',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [JSON.stringify(launch)],
      );
    });
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await maintenance?.query("DROP SCHEMA " + schema + " CASCADE");
      await maintenance?.end();
    });
    it("defaults both surfaces off and does not create an acknowledgement on reads", async () => {
      await pool.query("DELETE FROM app_settings WHERE key='entryLaunchLink'");
      const state = await request("GET", endpoint);
      expect(state.statusCode).toBe(200);
      expect(state.headers["cache-control"]).toBe("no-store");
      expect(state.json()).toEqual({
        ...DEFAULT_ENTRY_LAUNCH_LINK,
        announcementId: createHash("sha256")
          .update(DEFAULT_ENTRY_LAUNCH_LINK.url)
          .digest("hex"),
        acknowledged: false,
      });
      expect(
        (await pool.query("SELECT 1 FROM hub_document_acknowledgements"))
          .rowCount,
      ).toBe(0);
    });
    it("persists one account's Hub acknowledgement across both Atlas branches, without affecting another account", async () => {
      const state = (await request("GET", endpoint)).json();
      expect(state.acknowledged).toBe(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        const saved = await request("POST", endpoint + "/ack", {
          announcementId: state.announcementId,
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toEqual({
          acknowledged: true,
          announcementId: state.announcementId,
        });
      }
      for (const [url, headers] of [
        [endpoint, browser()],
        [branchEndpoint, branchA],
        [branchEndpoint, branchB],
      ] as const) {
        const response = await request("GET", url, undefined, headers as any);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ...state, acknowledged: true });
      }
      expect(
        (await request("GET", endpoint, undefined, browser("other"))).json()
          .acknowledged,
      ).toBe(false);
      expect(
        (
          await request("GET", branchEndpoint, undefined, otherBranch as any)
        ).json().acknowledged,
      ).toBe(false);
      expect(
        (await pool.query("SELECT user_id FROM hub_document_acknowledgements"))
          .rows,
      ).toEqual([{ user_id: userId }]);
    });
    it("accepts a real branch acknowledgement and shares it back to Hub and the other branch", async () => {
      const state = (
        await request("GET", branchEndpoint, undefined, branchB as any)
      ).json();
      const response = await request(
        "POST",
        branchEndpoint + "/ack",
        { announcementId: state.announcementId },
        branchB as any,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        acknowledged: true,
        announcementId: state.announcementId,
      });
      expect((await request("GET", endpoint)).json().acknowledged).toBe(true);
      expect(
        (await request("GET", branchEndpoint, undefined, branchA as any)).json()
          .acknowledged,
      ).toBe(true);
    });
    it("rejects a stale displayed URL after the administrator changes it and remembers previous URL acknowledgements", async () => {
      const previous = (await request("GET", endpoint)).json();
      expect(
        (
          await request("POST", endpoint + "/ack", {
            announcementId: previous.announcementId,
          })
        ).statusCode,
      ).toBe(200);
      const next = {
        ...launch,
        url: "https://example.test/new-document?tab=t.1#section",
      };
      expect(
        (
          await request(
            "PUT",
            "/api/admin/settings/entryLaunchLink",
            next,
            browser("admin"),
          )
        ).statusCode,
      ).toBe(200);
      const changed = (await request("GET", endpoint)).json();
      expect(changed.announcementId).not.toBe(previous.announcementId);
      expect(changed.acknowledged).toBe(false);
      for (const [url, headers] of [
        [endpoint, browser()],
        [branchEndpoint, branchA],
      ] as const) {
        const response = await request(
          "POST",
          url + "/ack",
          { announcementId: previous.announcementId },
          headers as any,
        );
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe(
          "DOCUMENT_ANNOUNCEMENT_CHANGED",
        );
      }
      expect(
        (await pool.query("SELECT url_hash FROM hub_document_acknowledgements"))
          .rows,
      ).toEqual([{ url_hash: previous.announcementId }]);
      await request(
        "PUT",
        "/api/admin/settings/entryLaunchLink",
        launch,
        browser("admin"),
      );
      expect((await request("GET", endpoint)).json().acknowledged).toBe(true);
    });
    it("retains the same acknowledgement across both/either/off surface settings", async () => {
      const state = (await request("GET", endpoint)).json();
      await request("POST", endpoint + "/ack", {
        announcementId: state.announcementId,
      });
      for (const [hubEnabled, browserEnabled] of [
        [true, false],
        [false, true],
        [false, false],
        [true, true],
      ]) {
        const value = { ...launch, hubEnabled, browserEnabled };
        expect(
          (
            await request(
              "PUT",
              "/api/admin/settings/entryLaunchLink",
              value,
              browser("admin"),
            )
          ).statusCode,
        ).toBe(200);
        expect((await request("GET", endpoint)).json()).toEqual({
          ...value,
          announcementId: state.announcementId,
          acknowledged: true,
        });
      }
    });
    it("protects Hub writes with session and CSRF, rejects arbitrary IDs and account selectors, and requires a full branch session", async () => {
      const state = (await request("GET", endpoint)).json();
      expect((await app.inject(endpoint)).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: endpoint + "/ack",
            payload: { announcementId: state.announcementId },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await request(
            "POST",
            endpoint + "/ack",
            { announcementId: state.announcementId },
            { cookie: browser().cookie } as any,
          )
        ).statusCode,
      ).toBe(403);
      for (const payload of [
        {},
        { announcementId: "wrong" },
        { announcementId: state.announcementId, userId: otherId },
        { announcementId: state.announcementId, url: launch.url },
      ])
        expect(
          (await request("POST", endpoint + "/ack", payload)).statusCode,
        ).toBe(400);
      expect(
        (
          await request("POST", endpoint + "/ack", {
            announcementId: "0".repeat(64),
          })
        ).statusCode,
      ).toBe(409);
      for (const url of [branchEndpoint, branchEndpoint + "/ack"]) {
        const method = url.endsWith("/ack") ? "POST" : "GET";
        const response = await request(
          method,
          url,
          method === "POST"
            ? { announcementId: state.announcementId }
            : undefined,
          {
            "x-atlas-branch-id": branchA["x-atlas-branch-id"],
            authorization: branchA.authorization,
          } as any,
        );
        expect([400, 401, 403]).toContain(response.statusCode);
      }
      expect(
        (await pool.query("SELECT 1 FROM hub_document_acknowledgements"))
          .rowCount,
      ).toBe(0);
    });
    it("deletes a user's acknowledgements with the account without changing another user's preference", async () => {
      const state = (await request("GET", endpoint)).json();
      for (const headers of [browser(), browser("other")])
        expect(
          (
            await request(
              "POST",
              endpoint + "/ack",
              { announcementId: state.announcementId },
              headers,
            )
          ).statusCode,
        ).toBe(200);
      await pool.query("DELETE FROM users WHERE id=$1", [otherId]);
      expect(
        (await pool.query("SELECT user_id FROM hub_document_acknowledgements"))
          .rows,
      ).toEqual([{ user_id: userId }]);
    });
  },
);
