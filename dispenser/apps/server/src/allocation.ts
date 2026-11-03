import type { Pool, PoolClient } from "pg";
import { AppError } from "./errors.js";

export interface AssignmentSettings {
  strategy: "balanced_random" | "random" | "weighted_random" | "sequential";
  linksPerWeek: number;
  assignmentLifetimeHours: number;
}
export type Candidate = {
  id: string;
  name: string;
  url: string;
  capacity: number | null;
  weight: number;
  used: number;
  created_at: Date;
  last_assigned_at: Date | null;
};

export async function allocateLink(
  pool: Pool,
  userId: string,
  defaults: AssignmentSettings,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const user = await client.query<{
      quota_override: {
        linksPerWeek?: number | null;
      } | null;
      quota_reset_at: Date | null;
    }>(
      "SELECT quota_override,quota_reset_at FROM users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    const override = user.rows[0]?.quota_override ?? {};
    const weeklyLimit =
      override.linksPerWeek === null
        ? Infinity
        : (override.linksPerWeek ?? defaults.linksPerWeek);
    const usage = await client.query<{ week: string }>(
      `SELECT count(DISTINCT a.link_id) FILTER (WHERE a.assigned_at >= date_trunc('week', now()) AND ($2::timestamptz IS NULL OR a.assigned_at>$2))::text "week" FROM link_assignments a JOIN links l ON l.id=a.link_id WHERE a.user_id=$1 AND l.enabled`,
      [userId, user.rows[0]?.quota_reset_at ?? null],
    );
    if (Number(usage.rows[0]?.week ?? 0) >= weeklyLimit)
      throw new AppError(
        "QUOTA_EXCEEDED",
        "You have reached your link request limit.",
        429,
      );
    const candidates = await client.query<Candidate>(
      `SELECT l.id,l.name,l.url,l.capacity,l.weight,l.created_at,COALESCE((SELECT count(*)::int FROM link_assignments a WHERE a.link_id=l.id AND a.active),0)::int used,(SELECT max(a.assigned_at) FROM link_assignments a WHERE a.link_id=l.id) last_assigned_at FROM links l WHERE l.enabled AND l.health_status NOT IN ('unavailable','disabled') AND (l.expires_at IS NULL OR l.expires_at>now()) AND (l.capacity IS NULL OR (SELECT count(*) FROM link_assignments a WHERE a.link_id=l.id AND a.active)<l.capacity) AND NOT EXISTS (SELECT 1 FROM link_assignments owned WHERE owned.user_id=$1 AND owned.link_id=l.id) ORDER BY l.id FOR UPDATE`,
      [userId],
    );
    if (!candidates.rows.length)
      throw new AppError(
        "NO_LINK_AVAILABLE",
        "There are no links available right now.",
        503,
      );
    const selected = chooseCandidate(candidates.rows, defaults.strategy);
    const expiresAt =
      defaults.assignmentLifetimeHours > 0
        ? new Date(Date.now() + defaults.assignmentLifetimeHours * 3_600_000)
        : null;
    const assignment = await client.query(
      `INSERT INTO link_assignments (user_id,link_id,expires_at) VALUES ($1,$2,$3) RETURNING id,assigned_at "assignedAt",expires_at "expiresAt"`,
      [userId, selected.id, expiresAt],
    );
    await client.query("COMMIT");
    return {
      ...assignment.rows[0],
      name: selected.name,
      url: selected.url,
      status: "ready" as const,
      available: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export function chooseCandidate(
  candidates: Candidate[],
  strategy: AssignmentSettings["strategy"],
) {
  if (strategy === "random")
    return candidates[Math.floor(Math.random() * candidates.length)]!;
  if (strategy === "sequential")
    return [...candidates].sort((a, b) =>
      a.last_assigned_at === null
        ? -1
        : b.last_assigned_at === null
          ? 1
          : a.last_assigned_at.getTime() - b.last_assigned_at.getTime(),
    )[0]!;
  if (strategy === "weighted_random") return weighted(candidates);
  const scored = candidates.map((item) => ({
    item,
    utilization: item.capacity
      ? item.used / item.capacity
      : item.used / Math.max(1000, item.used + 1),
  }));
  const minimum = Math.min(...scored.map((entry) => entry.utilization));
  return weighted(
    scored
      .filter((entry) => entry.utilization <= minimum + 0.05)
      .map((entry) => entry.item),
  );
}
function weighted(items: Candidate[]) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let point = Math.random() * total;
  for (const item of items) {
    point -= item.weight;
    if (point <= 0) return item;
  }
  return items.at(-1)!;
}

export async function withSerializableRetry<T>(
  work: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || (error as { code?: string }).code !== "40001")
        throw error;
    }
  }
}
