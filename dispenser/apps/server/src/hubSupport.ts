import {
  registerSupportEventRoute,
  publishSupportChanged,
} from "./hubSupportEvents.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AppError, forbidden } from "./errors.js";
import { registerHubAnnouncementRoutes } from "./hubAnnouncements.js";
import {
  parseSupportMedia,
  saveSupportMedia,
  SUPPORT_MEDIA_BODY_LIMIT,
  SUPPORT_MEDIA_METADATA_SQL,
} from "./hubSupportMedia.js";
export type HubUser = {
  id: string;
  role: "user" | "admin";
  sessionId?: string;
};
export type HubRouteOptions = {
  pool: Pool;
  requireUser: (request: FastifyRequest) => Promise<HubUser>;
  requireAdmin: (request: FastifyRequest) => Promise<HubUser>;
  csrf: (request: FastifyRequest, user: any) => void;
  verifyService?: (request: FastifyRequest) => boolean | Promise<boolean>;
  sourceLabel?: (id: string) => string;
  userPrefix?: string;
  includeAdmin?: boolean;
  legacyVerify?: (
    source: string,
    id: string,
    token: string,
  ) => boolean | Promise<boolean>;
};
const obj = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as any) : {};
const field = (v: unknown, max: number, min = 1) => {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    throw new AppError("VALIDATION_ERROR", "Check the required fields.");
  return v.trim();
};
const uuid = (v: unknown) => {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  )
    throw new AppError("VALIDATION_ERROR", "Invalid ticket.", 404);
  return v;
};
export async function registerHubSupportRoutes(
  app: FastifyInstance,
  o: HubRouteOptions,
) {
  const { pool } = o;
  const prefix = o.userPrefix ?? "/api/hub";
  const includeAdmin = o.includeAdmin !== false;
  await registerSupportEventRoute(app, pool, prefix + "/events", o.requireUser);
  await registerHubAnnouncementRoutes(app, o);
  async function owner(request: FastifyRequest, admin = false) {
    const user = await (admin
      ? o.requireAdmin(request)
      : o.requireUser(request));
    const id = uuid(obj(request.params).id);
    const ticket = (
      await pool.query(
        admin
          ? "SELECT t.*,u.email AS requester_email FROM hub_tickets t LEFT JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND ($2::boolean OR t.user_id=$3)"
          : "SELECT * FROM hub_tickets WHERE id=$1 AND ($2::boolean OR user_id=$3)",
        [id, admin, user.id],
      )
    ).rows[0];
    if (!ticket)
      throw new AppError("VALIDATION_ERROR", "Ticket not found.", 404);
    return { user, id, ticket };
  }
  for (const admin of includeAdmin ? [false, true] : [false]) {
    const base = admin ? "/api/admin/hub/tickets" : prefix + "/tickets";
    app.get(base, async (request) => {
      const user = await (admin
        ? o.requireAdmin(request)
        : o.requireUser(request));
      return {
        tickets: (
          await pool.query(
            `SELECT t.*, ${admin ? "u.email AS requester_email," : ""} (SELECT count(*)::int FROM hub_ticket_messages m WHERE m.ticket_id=t.id AND m.public AND m.author='admin' AND m.id>COALESCE(r.message_id,0)) unread FROM hub_tickets t LEFT JOIN hub_ticket_reads r ON r.ticket_id=t.id AND r.user_id=$2 ${admin ? "LEFT JOIN users u ON u.id=t.user_id" : ""} WHERE ($1::boolean OR t.user_id=$2) ORDER BY t.updated_at DESC LIMIT 200`,
            [admin, user.id],
          )
        ).rows,
      };
    });
    app.get(base + "/:id", async (request) => {
      const { id, ticket } = await owner(request, admin);
      return {
        ticket,
        messages: (
          await pool.query(
            admin
              ? `SELECT m.id,m.author,m.body,m.public,m.created_at,CASE WHEN m.author='user' THEN u.email ELSE NULL END AS author_email,${SUPPORT_MEDIA_METADATA_SQL} FROM hub_ticket_messages m JOIN hub_tickets t ON t.id=m.ticket_id LEFT JOIN users u ON u.id=t.user_id WHERE m.ticket_id=$1 AND ($2::boolean OR m.public) ORDER BY m.id`
              : `SELECT m.id,m.author,m.body,m.public,m.created_at,${SUPPORT_MEDIA_METADATA_SQL} FROM hub_ticket_messages m WHERE m.ticket_id=$1 AND ($2::boolean OR m.public) ORDER BY m.id`,
            [id, admin],
          )
        ).rows,
      };
    });
    app.get(base + "/:id/attachments/:attachmentId", async (request, reply) => {
      const { id } = await owner(request, admin);
      const attachmentId = uuid(obj(request.params).attachmentId);
      const attachment = (
        await pool.query(
          'SELECT a.id,a.name,a.mime_type AS "mimeType",a.byte_size AS size,a.data FROM hub_ticket_attachments a JOIN hub_ticket_messages m ON m.id=a.message_id WHERE a.id=$1 AND m.ticket_id=$2 AND ($3::boolean OR m.public)',
          [attachmentId, id, admin],
        )
      ).rows[0];
      if (!attachment)
        throw new AppError("VALIDATION_ERROR", "Attachment not found.", 404);
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      const { data, ...metadata } = attachment;
      return {
        attachment: metadata,
        dataBase64: (data as Buffer).toString("base64"),
      };
    });
    app.post(
      base + "/:id/messages",
      { bodyLimit: SUPPORT_MEDIA_BODY_LIMIT },
      async (request) => {
        const { user, id } = await owner(request, admin);
        o.csrf(request, user);
        const input = obj(request.body);
        const body = field(input.body, 5000);
        const attachments = parseSupportMedia(input.attachments);
        const visible = !admin || input.public !== false;
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const t = (
            await c.query("SELECT * FROM hub_tickets WHERE id=$1 FOR UPDATE", [
              id,
            ])
          ).rows[0];
          const message = (
            await c.query(
              "INSERT INTO hub_ticket_messages(ticket_id,author,body,public) VALUES($1,$2,$3,$4) RETURNING *",
              [id, admin ? "admin" : "user", body, visible],
            )
          ).rows[0];
          message.attachments = await saveSupportMedia(
            c,
            message.id,
            user.id,
            attachments,
          );
          if (visible) {
            await c.query(
              "UPDATE hub_tickets SET status=$2,updated_at=now() WHERE id=$1",
              [id, admin ? "awaiting_you" : "open"],
            );
            if (admin && t.user_id)
              await c.query(
                "INSERT INTO hub_notifications(user_id,ticket_id,message_id) VALUES($1,$2,$3)",
                [t.user_id, id, message.id],
              );
            if (t.user_id)
              await publishSupportChanged(c, t.user_id, message.id);
          }
          await c.query("COMMIT");
          return { message };
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
    );
  }
  if (includeAdmin)
    app.patch("/api/admin/hub/tickets/:id", async (request) => {
      const { user, id } = await owner(request, true);
      o.csrf(request, user);
      const status = obj(request.body).status;
      if (!["open", "closed"].includes(status))
        throw new AppError("VALIDATION_ERROR", "Invalid ticket status.");
      return {
        ticket: (
          await pool.query(
            "UPDATE hub_tickets SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",
            [id, status],
          )
        ).rows[0],
      };
    });
  app.post(
    prefix + "/tickets",
    { bodyLimit: SUPPORT_MEDIA_BODY_LIMIT },
    async (request) => {
      const user = await o.requireUser(request);
      o.csrf(request, user);
      const b = obj(request.body);
      const attachments = parseSupportMedia(b.attachments);
      const subject = field(b.subject, 120, 3),
        body = field(b.body, 5000, 5),
        category = field(b.category ?? "Other", 30);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const t = (
          await c.query(
            "INSERT INTO hub_tickets(user_id,subject,category) VALUES($1,$2,$3) RETURNING *",
            [user.id, subject, category],
          )
        ).rows[0];
        const first = await c.query(
          "INSERT INTO hub_ticket_messages(ticket_id,author,body) VALUES($1,'user',$2) RETURNING id",
          [t.id, body],
        );
        await saveSupportMedia(c, first.rows[0].id, user.id, attachments);
        await publishSupportChanged(c, user.id, first.rows[0].id);
        await c.query("COMMIT");
        return { ticket: t };
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  );
  app.post(prefix + "/tickets/:id/read", async (request) => {
    const { user, id } = await owner(request);
    o.csrf(request, user);
    const supplied = Number(obj(request.body).messageId);
    if (!Number.isSafeInteger(supplied) || supplied < 0)
      throw new AppError("VALIDATION_ERROR", "Invalid message cursor.");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const latest = (
        await c.query(
          "SELECT COALESCE(max(id),0)::text id FROM hub_ticket_messages WHERE ticket_id=$1 AND public AND id<=$2",
          [id, supplied],
        )
      ).rows[0].id;
      const advanced = await c.query(
        "INSERT INTO hub_ticket_reads(ticket_id,user_id,message_id) VALUES($1,$2,$3) ON CONFLICT(ticket_id,user_id) DO UPDATE SET message_id=excluded.message_id WHERE hub_ticket_reads.message_id<excluded.message_id",
        [id, user.id, latest],
      );
      const read = await c.query(
        "UPDATE hub_notifications SET read_at=now() WHERE user_id=$1 AND ticket_id=$2 AND message_id<=$3 AND read_at IS NULL",
        [user.id, id, latest],
      );
      if (advanced.rowCount || read.rowCount)
        await publishSupportChanged(c, user.id, latest);
      await c.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  });
  app.get(prefix + "/notifications", async (request) => {
    const user = await o.requireUser(request);
    const rows = (
      await pool.query(
        `SELECT * FROM (
          SELECT n.id,'support'::text AS kind,n.ticket_id,n.message_id,NULL::uuid AS announcement_id,n.created_at,n.read_at,t.subject
          FROM hub_notifications n JOIN hub_tickets t ON t.id=n.ticket_id WHERE n.user_id=$1
          UNION ALL
          SELECT a.notification_id AS id,'announcement'::text AS kind,NULL::uuid AS ticket_id,NULL::bigint AS message_id,a.id AS announcement_id,a.published_at AS created_at,r.read_at,a.title AS subject
          FROM hub_announcements a LEFT JOIN hub_announcement_reads r ON r.announcement_id=a.id AND r.user_id=$1 WHERE a.withdrawn_at IS NULL
        ) mixed ORDER BY (read_at IS NULL) DESC,id DESC LIMIT 100`,
        [user.id],
      )
    ).rows;
    return {
      notifications: rows,
      unread: (
        await pool.query(
          `SELECT ((SELECT count(*) FROM hub_notifications WHERE user_id=$1 AND read_at IS NULL)+(SELECT count(*) FROM hub_announcements a WHERE a.withdrawn_at IS NULL AND NOT EXISTS(SELECT 1 FROM hub_announcement_reads r WHERE r.announcement_id=a.id AND r.user_id=$1)))::int n`,
          [user.id],
        )
      ).rows[0].n,
    };
  });
  app.post(prefix + "/legacy-tickets/claim", async (request) => {
    const user = await o.requireUser(request);
    o.csrf(request, user);
    const b = obj(request.body),
      source = field(b.source, 100),
      id = field(b.id, 100),
      token = field(b.token, 1000);
    if (!o.legacyVerify || !(await o.legacyVerify(source, id, token)))
      throw forbidden();
    const result = await pool.query(
      "UPDATE hub_tickets SET user_id=$3 WHERE legacy_source=$1 AND legacy_id=$2 AND (user_id IS NULL OR user_id=$3) RETURNING id",
      [source, id, user.id],
    );
    if (!result.rows[0])
      throw new AppError(
        "VALIDATION_ERROR",
        "Legacy ticket is unavailable.",
        404,
      );
    return { ticketId: result.rows[0].id };
  });
  if (includeAdmin)
    app.post("/api/hub/internal/legacy-tickets", async (request) => {
      if (!o.verifyService || !(await o.verifyService(request)))
        throw forbidden();
      return importLegacyTicket(pool, request.body);
    });
}

export async function importLegacyTicket(pool: Pool, payload: unknown) {
  const b = obj(payload),
    source = field(b.source, 100),
    id = field(b.id, 100);
  const messages = Array.isArray(b.messages) ? b.messages : [];
  if (messages.length > 1000)
    throw new AppError("VALIDATION_ERROR", "Import too large.");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const t = (
      await c.query(
        "INSERT INTO hub_tickets(subject,category,legacy_source,legacy_id,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(legacy_source,legacy_id) DO UPDATE SET legacy_id=excluded.legacy_id RETURNING id",
        [
          field(b.subject, 120),
          field(b.category ?? "Other", 30),
          source,
          id,
          ["open", "awaiting_you", "closed"].includes(b.status)
            ? b.status
            : "open",
        ],
      )
    ).rows[0];
    for (const raw of messages) {
      const m = obj(raw);
      await c.query(
        "INSERT INTO hub_ticket_messages(ticket_id,author,body,legacy_message_id,created_at) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now())) ON CONFLICT(ticket_id,legacy_message_id) DO NOTHING",
        [
          t.id,
          m.author === "admin" ? "admin" : "user",
          field(m.body, 5000),
          field(String(m.id), 100),
          m.createdAt ?? null,
        ],
      );
    }
    await c.query("COMMIT");
    return { ticketId: t.id };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
