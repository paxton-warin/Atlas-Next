/** Immutable global announcements share the existing bell, invalidation bus and
 * numeric notification sequence. Reads are explicit per-account receipts; a
 * publication creates no per-user rows and a feed/detail GET never marks read. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { HubRouteOptions } from "./hubSupport.js";
import { AppError } from "./errors.js";
import { publishSupportBroadcast, publishSupportChanged } from "./hubSupportEvents.js";

const invalid = (message: string, status = 400) => new AppError("VALIDATION_ERROR", message, status);
const uuid = (value: unknown) => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw invalid("Announcement not found.", 404);
  return value;
};
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw invalid("Enter an announcement title and message within the displayed limits.");
  return value.trim();
};
const fields = "id,notification_id,title,body,published_at,published_at AS created_at,withdrawn_at";

export async function registerHubAnnouncementRoutes(app: FastifyInstance, o: HubRouteOptions) {
  const prefix = o.userPrefix ?? "/api/hub", { pool } = o;
  if (o.includeAdmin !== false) {
    app.get("/api/admin/hub/announcements", async req => {
      await o.requireAdmin(req);
      const q = req.query as Record<string, unknown>, limit = q.limit === undefined ? 20 : Number(q.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (q.cursor !== undefined && (typeof q.cursor !== "string" || !/^[1-9]\d{0,18}$/.test(q.cursor) || BigInt(q.cursor) > 9223372036854775807n)))
        throw invalid("Invalid announcement history cursor or limit.");
      const rows = (await pool.query(`SELECT ${fields} FROM hub_announcements WHERE ($1::bigint IS NULL OR notification_id<$1) ORDER BY notification_id DESC LIMIT $2`, [q.cursor ?? null, limit + 1])).rows;
      const page = rows.slice(0, limit);
      return { announcements: page, nextCursor: rows.length > limit ? String(page.at(-1)!.notification_id) : null };
    });
    app.post("/api/admin/hub/announcements", { bodyLimit: 32_000 }, async req => {
      const user = await o.requireAdmin(req); o.csrf(req, user);
      const v = req.body as Record<string, unknown> | undefined;
      const id = v?.id === undefined ? randomUUID() : uuid(v.id), title = text(v?.title, 120), body = text(v?.body, 5000);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const inserted = (await c.query(`INSERT INTO hub_announcements(id,title,body,published_by) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING ${fields}`, [id, title, body, user.id])).rows[0];
        const announcement = inserted ?? (await c.query(`SELECT ${fields} FROM hub_announcements WHERE id=$1`, [id])).rows[0];
        if (!announcement || announcement.title !== title || announcement.body !== body)
          throw new AppError("HUB_CONFLICT", "This publication identifier already belongs to a different announcement.", 409);
        if (inserted) {
          await c.query("INSERT INTO audit_events(admin_id,action,target_type,target_id,after) VALUES($1,'hub.announcement.publish','announcement',$2,$3::jsonb)", [user.id, id, JSON.stringify({ title, notificationId: String(announcement.notification_id) })]);
          await publishSupportBroadcast(c, announcement.notification_id);
        }
        await c.query("COMMIT");
        return { announcement, replayed: !inserted };
      } catch (error) { await c.query("ROLLBACK"); throw error; }
      finally { c.release(); }
    });
    app.post<{ Params: { id: string } }>("/api/admin/hub/announcements/:id/withdraw", async req => {
      const user = await o.requireAdmin(req); o.csrf(req, user); const id = uuid(req.params.id), c = await pool.connect();
      try {
        await c.query("BEGIN");
        const before = (await c.query(`SELECT ${fields} FROM hub_announcements WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw invalid("Announcement not found.", 404);
        let announcement = before;
        if (!before.withdrawn_at) {
          announcement = (await c.query(`UPDATE hub_announcements SET withdrawn_at=now(),withdrawn_by=$2 WHERE id=$1 RETURNING ${fields}`, [id, user.id])).rows[0];
          await c.query("INSERT INTO audit_events(admin_id,action,target_type,target_id,after) VALUES($1,'hub.announcement.withdraw','announcement',$2,$3::jsonb)", [user.id, id, JSON.stringify({ notificationId: String(announcement.notification_id) })]);
          await publishSupportBroadcast(c, announcement.notification_id);
        }
        await c.query("COMMIT"); return { announcement };
      } catch (error) { await c.query("ROLLBACK"); throw error; }
      finally { c.release(); }
    });
  }
  app.get<{ Params: { id: string } }>(prefix + "/announcements/:id", async req => {
    const user = await o.requireUser(req), id = uuid(req.params.id);
    const announcement = (await pool.query(`SELECT a.id,a.notification_id,a.title,a.body,a.published_at,a.published_at AS created_at,a.withdrawn_at,r.read_at FROM hub_announcements a LEFT JOIN hub_announcement_reads r ON r.announcement_id=a.id AND r.user_id=$2 WHERE a.id=$1 AND a.withdrawn_at IS NULL`, [id, user.id])).rows[0];
    if (!announcement) throw invalid("This announcement is no longer available.", 404);
    return { announcement };
  });
  app.post<{ Params: { id: string } }>(prefix + "/announcements/:id/read", async req => {
    const user = await o.requireUser(req); o.csrf(req, user); const id = uuid(req.params.id), c = await pool.connect();
    try {
      await c.query("BEGIN");
      const active = (await c.query("SELECT notification_id FROM hub_announcements WHERE id=$1 AND withdrawn_at IS NULL FOR SHARE", [id])).rows[0];
      if (!active) throw invalid("This announcement is no longer available.", 404);
      const read = await c.query("INSERT INTO hub_announcement_reads(user_id,announcement_id) VALUES($1,$2) ON CONFLICT(user_id,announcement_id) DO NOTHING", [user.id, id]);
      if (read.rowCount) await publishSupportChanged(c, user.id, active.notification_id);
      await c.query("COMMIT"); return { ok: true };
    } catch (error) { await c.query("ROLLBACK"); throw error; }
    finally { c.release(); }
  });
}
