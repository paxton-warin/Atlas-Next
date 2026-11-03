import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerHubSupportRoutes } from "./hubSupport.js";
import { AppError } from "./errors.js";
import { SUPPORT_MEDIA_MAX_UPLOADER_BYTES } from "./hubSupportMedia.js";
const database = process.env.TEST_DATABASE_URL,
  suite = database ? describe : describe.skip;
const screenshot = {
  name: "screenshot.png",
  mimeType: "image/png",
  dataBase64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD3sAAAAASUVORK5CYII=",
};
suite(
  "Support attachments are atomic, owned, visibility-filtered and bounded",
  () => {
    const schema = "support_media_" + randomUUID().replaceAll("-", ""),
      user = randomUUID(),
      other = randomUUID(),
      admin = randomUUID();
    const app = Fastify();
    let pool: Pool, maintenance: Pool;
    const headers = (actor = user, csrf = true) => ({
      "x-test-user": actor,
      ...(csrf ? { "x-test-csrf": "yes" } : {}),
    });
    const req = (
      method: any,
      url: string,
      payload?: any,
      actor = user,
      csrf = true,
    ) =>
      app.inject({
        method,
        url,
        headers: headers(actor, csrf),
        ...(payload !== undefined ? { payload } : {}),
      });
    const create = async (
      attachments: unknown[] = [screenshot],
      actor = user,
      prefix = "/api/hub",
    ) => {
      const r = await req(
        "POST",
        prefix + "/tickets",
        {
          subject: "Screenshot issue",
          body: "Screenshot attached",
          attachments,
        },
        actor,
      );
      expect(r.statusCode, r.body).toBe(200);
      return r.json().ticket;
    };
    const detail = (id: string, actor = user, prefix = "/api/hub") =>
      req("GET", prefix + "/tickets/" + id, undefined, actor);
    beforeAll(async () => {
      if (!new URL(database!).pathname.endsWith("_test"))
        throw Error("Dedicated test database required");
      maintenance = new Pool({ connectionString: database });
      await maintenance.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: database,
        options: `-c search_path=${schema},public`,
        max: 8,
      });
      await pool.query(
        "CREATE TABLE users(id uuid PRIMARY KEY,email text,status text NOT NULL DEFAULT 'active')",
      );
      for (const f of [
        "0011_hub_support_metrics.sql",
        "0023_hub_announcements.sql",
        "0024_hub_support_media.sql",
      ])
        await pool.query(
          await readFile(
            new URL(
              "../../../packages/database/migrations/" + f,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      for (const id of [user, other, admin])
        await pool.query("INSERT INTO users(id,email)VALUES($1,$2)", [
          id,
          id + "@example.invalid",
        ]);
      const authenticate = async (r: any) => {
        const id = r.headers["x-test-user"];
        if (![user, other, admin].includes(id))
          throw new AppError("UNAUTHORIZED", "Sign in", 401);
        return {
          id,
          role: id === admin ? ("admin" as const) : ("user" as const),
        };
      };
      const options = {
        pool,
        requireUser: authenticate,
        requireAdmin: async (r: any) => {
          const actor = await authenticate(r);
          if (actor.role !== "admin")
            throw new AppError("FORBIDDEN", "Forbidden", 403);
          return actor;
        },
        csrf: (r: any) => {
          if (r.headers["x-test-csrf"] !== "yes")
            throw new AppError("FORBIDDEN", "CSRF", 403);
        },
      };
      app.setErrorHandler((error, _req, reply) =>
        reply
          .code(
            error instanceof AppError
              ? error.status
              : (error as any).statusCode || 500,
          )
          .send({
            error: { message: (error as Error).message, code: (error as any).code },
          }),
      );
      await registerHubSupportRoutes(app, options);
      await registerHubSupportRoutes(app, {
        ...options,
        userPrefix: "/api/hub/branch",
        includeAdmin: false,
      });
      await app.ready();
    });
    beforeEach(async () => {
      await pool.query("TRUNCATE hub_tickets CASCADE");
    });
    afterAll(async () => {
      await app.close();
      await pool?.end();
      if (maintenance) {
        await maintenance.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await maintenance.end();
      }
    });
    it("creates ticket+media atomically, polls metadata only, round-trips exact bytes", async () => {
      const t = await create(),
        r = await detail(t.id),
        media = r.json().messages[0].attachments[0];
      expect(media).toMatchObject({
        name: screenshot.name,
        mimeType: screenshot.mimeType,
        size: Buffer.from(screenshot.dataBase64, "base64").length,
      });
      expect(r.body).not.toContain(screenshot.dataBase64);
      const download = await req(
        "GET",
        `/api/hub/tickets/${t.id}/attachments/${media.id}`,
      );
      expect(download.statusCode).toBe(200);
      expect(download.json()).toEqual({
        attachment: media,
        dataBase64: screenshot.dataBase64,
      });
      expect(download.headers["cache-control"]).toBe("private, no-store");
      expect(download.headers["x-content-type-options"]).toBe("nosniff");
    });
    it("rejects cross-account access and foreign/missing attachment IDs", async () => {
      const t = await create(),
        t2 = await create([], other),
        media = (await detail(t.id)).json().messages[0].attachments[0];
      expect(
        (
          await req(
            "GET",
            `/api/hub/tickets/${t.id}/attachments/${media.id}`,
            undefined,
            other,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await req(
            "GET",
            `/api/hub/tickets/${t2.id}/attachments/${media.id}`,
            undefined,
            other,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await req(
            "GET",
            `/api/hub/tickets/${t.id}/attachments/${randomUUID()}`,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await req(
            "GET",
            `/api/admin/hub/tickets/${t.id}/attachments/${media.id}`,
            undefined,
            user,
          )
        ).statusCode,
      ).toBe(403);
    });
    it("keeps note media private and sends notifications only for public admin replies", async () => {
      const t = await create([]),
        note = await req(
          "POST",
          `/api/admin/hub/tickets/${t.id}/messages`,
          {
            body: "Private internal note",
            public: false,
            attachments: [screenshot],
          },
          admin,
        );
      expect(note.statusCode, note.body).toBe(200);
      const media = note.json().message.attachments[0];
      expect((await detail(t.id)).json().messages).toHaveLength(1);
      expect(
        (await req("GET", `/api/hub/tickets/${t.id}/attachments/${media.id}`))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await req(
            "GET",
            `/api/admin/hub/tickets/${t.id}/attachments/${media.id}`,
            undefined,
            admin,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await req(
            "POST",
            `/api/admin/hub/tickets/${t.id}/messages`,
            { body: "Public reply attached", attachments: [screenshot] },
            admin,
          )
        ).statusCode,
      ).toBe(200);
      expect((await detail(t.id)).json().messages).toHaveLength(2);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_notifications WHERE ticket_id=$1",
            [t.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("supports branch create, reply, download with same contract", async () => {
      const base = "/api/hub/branch",
        t = await create([screenshot], user, base),
        r = await req("POST", `${base}/tickets/${t.id}/messages`, {
          body: "Another screenshot",
          attachments: [screenshot],
        });
      expect(r.statusCode).toBe(200);
      const media = r.json().message.attachments[0];
      expect(
        (
          await req("GET", `${base}/tickets/${t.id}/attachments/${media.id}`)
        ).json().dataBase64,
      ).toBe(screenshot.dataBase64);
      expect((await detail(t.id, user, base)).json().messages).toHaveLength(2);
    });
    it("preserves text-only messages and rejects invalid uploads without orphan writes", async () => {
      const t = await create([]),
        invalid = { ...screenshot, mimeType: "image/svg+xml" };
      expect(
        (
          await req("POST", "/api/hub/tickets", {
            subject: "Bad upload",
            body: "Attachment should fail",
            attachments: [invalid],
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await req("POST", `/api/hub/tickets/${t.id}/messages`, {
            body: "Must not persist",
            attachments: [invalid],
          })
        ).statusCode,
      ).toBe(400);
      const messages = (await detail(t.id)).json().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toEqual([]);
      expect(
        (await pool.query("SELECT count(*)::int n FROM hub_tickets")).rows[0].n,
      ).toBe(1);
    });
    it("requires CSRF on new tickets and admin uploads", async () => {
      const t = await create([]);
      expect(
        (
          await req(
            "POST",
            "/api/hub/tickets",
            {
              subject: "CSRF upload",
              body: "Should fail",
              attachments: [screenshot],
            },
            user,
            false,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await req(
            "POST",
            `/api/admin/hub/tickets/${t.id}/messages`,
            { body: "Should fail", attachments: [screenshot] },
            admin,
            false,
          )
        ).statusCode,
      ).toBe(403);
    });
    it("rejects full allowance atomically; other accounts remain unaffected", async () => {
      const t = await create([]),
        m = (await detail(t.id)).json().messages[0];
      await pool.query(
        "INSERT INTO hub_ticket_attachments(message_id,uploader_id,name,mime_type,byte_size,data) SELECT $1,$2,'full.png','image/png',10485760,decode(repeat('00',10485760),'hex') FROM generate_series(1,10)",
        [m.id, user],
      );
      expect(
        (
          await pool.query(
            "SELECT sum(byte_size)::text bytes FROM hub_ticket_attachments WHERE uploader_id=$1",
            [user],
          )
        ).rows[0].bytes,
      ).toBe(String(SUPPORT_MEDIA_MAX_UPLOADER_BYTES));
      const r = await req("POST", `/api/hub/tickets/${t.id}/messages`, {
        body: "Should roll back",
        attachments: [screenshot],
      });
      expect(r.statusCode, r.body).toBe(413);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM hub_ticket_messages WHERE ticket_id=$1",
            [t.id],
          )
        ).rows[0].n,
      ).toBe(1);
      await create([screenshot], other);
    });
    it("serializes simultaneous quota checks; ticket deletion cascades bytes", async () => {
      const t = await create(),
        t2 = await create([]),
        m = (await detail(t.id)).json().messages[0];
      await pool.query(
        "INSERT INTO hub_ticket_attachments(message_id,uploader_id,name,mime_type,byte_size,data) SELECT $1,$2,'full.png','image/png',10485760,decode(repeat('00',10485760),'hex') FROM generate_series(1,9)",
        [m.id, user],
      );
      const remaining =
        SUPPORT_MEDIA_MAX_UPLOADER_BYTES -
        9 * 10485760 -
        Buffer.from(screenshot.dataBase64, "base64").length;
      const data = Buffer.alloc(Math.floor(remaining * 0.75));
      Buffer.from(screenshot.dataBase64, "base64").copy(data);
      const attachment = { ...screenshot, dataBase64: data.toString("base64") };
      const results = await Promise.all(
        [t.id, t2.id].map((id) =>
          req("POST", `/api/hub/tickets/${id}/messages`, {
            body: "Concurrent message",
            attachments: [attachment],
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 413]);
      await pool.query("DELETE FROM hub_tickets WHERE id=ANY($1::uuid[])", [
        [t.id, t2.id],
      ]);
      expect(
        (await pool.query("SELECT count(*)::int n FROM hub_ticket_attachments"))
          .rows[0].n,
      ).toBe(0);
    });
  },
);
