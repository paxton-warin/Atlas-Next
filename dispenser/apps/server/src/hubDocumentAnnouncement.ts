import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AppError } from "./errors.js";
import {
  entryLaunchLinkOrDefault,
  type EntryLaunchLink,
} from "./entryLaunchLink.js";

type AnnouncementUser = { id: string };
type AnnouncementOptions = {
  pool: Pool;
  requireUser: (request: FastifyRequest) => Promise<AnnouncementUser>;
  csrf: (request: FastifyRequest, user: any) => void;
  userPrefix?: string;
};

export const documentAnnouncementId = (value: EntryLaunchLink) =>
  createHash("sha256").update(value.url).digest("hex");

export function registerDocumentAnnouncementRoutes(
  app: FastifyInstance,
  options: AnnouncementOptions,
) {
  const { pool } = options;
  const path = (options.userPrefix ?? "/api/hub") + "/document-announcement";
  app.get(path, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const user = await options.requireUser(request);
    const result = await pool.query<{ value: unknown }>(
      "SELECT value FROM app_settings WHERE key='entryLaunchLink'",
    );
    const value = entryLaunchLinkOrDefault(result.rows[0]?.value);
    const announcementId = documentAnnouncementId(value);
    // Look up only this exact version with the composite primary key. If the
    // administrator changes the link after this read, POST detects that race.
    const acknowledged = await pool.query(
      "SELECT 1 FROM hub_document_acknowledgements WHERE user_id=$1 AND url_hash=$2",
      [user.id, announcementId],
    );
    return {
      ...value,
      announcementId,
      acknowledged: Boolean(acknowledged.rowCount),
    };
  });
  app.post(path + "/ack", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const user = await options.requireUser(request);
    options.csrf(request, user);
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.announcementId !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.announcementId)
    )
      throw new AppError(
        "VALIDATION_ERROR",
        "Check the document acknowledgement.",
      );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Hold this setting row against concurrent UPDATE until the acknowledgement
      // commits. Every query uses this client; no nested pool acquisition occurs.
      const stored = await client.query<{ value: unknown }>(
        "SELECT value FROM app_settings WHERE key='entryLaunchLink' FOR SHARE",
      );
      const value = entryLaunchLinkOrDefault(stored.rows[0]?.value);
      const announcementId = documentAnnouncementId(value);
      if (body.announcementId !== announcementId)
        throw new AppError(
          "DOCUMENT_ANNOUNCEMENT_CHANGED",
          "The document link changed. Review the current link before saving this preference.",
          409,
        );
      await client.query(
        "INSERT INTO hub_document_acknowledgements(user_id,url_hash) VALUES($1,$2) ON CONFLICT(user_id,url_hash) DO NOTHING",
        [user.id, announcementId],
      );
      await client.query("COMMIT");
      return { acknowledged: true, announcementId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
