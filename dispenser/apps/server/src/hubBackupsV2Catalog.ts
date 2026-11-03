/** Persistent immutable catalog leaves. Preparation never holds the account quota lock. */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { BACKUP_V2, canonicalBackupJson } from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
export type CatalogTransaction = <T>(
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;
type Entry = { namespace: string; namespace_version_id: string };
type Page = {
  page_id: string;
  digest: string;
  entry_count: number;
  lower_key: string;
  upper_key: string;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const compare = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
const busy = () =>
  new AppError(
    "BACKUP_BUSY",
    "Catalog preparation is safely resumable; local saves continue.",
    503,
  );
const incomplete = () =>
  new AppError(
    "BACKUP_INCOMPLETE",
    "An immutable inherited part is missing; no checkpoint was published.",
    409,
  );
async function savePage(
  c: PoolClient,
  pid: string,
  entries: Entry[],
): Promise<Page> {
  const page: Page = {
    page_id: randomUUID(),
    digest: sha(canonicalBackupJson(entries)),
    entry_count: entries.length,
    lower_key: entries[0].namespace,
    upper_key: entries.at(-1)!.namespace,
  };
  await c.query(
    "INSERT INTO hub_backup_catalog_pages(profile_id,page_id,digest,entry_count,lower_key,upper_key) VALUES($1,$2,$3,$4,$5,$6)",
    [
      pid,
      page.page_id,
      page.digest,
      page.entry_count,
      page.lower_key,
      page.upper_key,
    ],
  );
  await c.query(
    "INSERT INTO hub_backup_catalog_entries SELECT $1,$2,x.namespace,x.namespace_version_id FROM jsonb_to_recordset($3::jsonb) x(namespace text,namespace_version_id uuid)",
    [pid, page.page_id, JSON.stringify(entries)],
  );
  return page;
}
function chunks(entries: Entry[]) {
  const n = Math.ceil(entries.length / 64),
    out: Entry[][] = [];
  if (!n) return out;
  const size = Math.floor(entries.length / n);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const take = size + (i < entries.length % n ? 1 : 0);
    out.push(entries.slice(at, (at += take)));
  }
  return out;
}
/** At most affected leaves are read/copied. An unchanged leaf/page ID is shared. */
async function buildRoot(c: PoolClient, pid: string, cp: any) {
  type Change = Entry & { kind: string };
  type WorkingPage = Page & { entries?: Entry[] };
  const parent = (
    await c.query(
      "SELECT parent_checkpoint_id FROM hub_backup_catalog_pins WHERE profile_id=$1 AND owner_checkpoint_id=$2",
      [pid, cp.checkpoint_id],
    )
  ).rows[0]?.parent_checkpoint_id;
  const changes: Change[] = (
    await c.query(
      'SELECT x.namespace,x.namespace_version_id,v.kind FROM hub_backup_checkpoint_namespaces x JOIN hub_backup_namespace_versions v USING(profile_id,namespace_version_id) WHERE x.profile_id=$1 AND x.checkpoint_id=$2 ORDER BY x.namespace COLLATE "C"',
      [pid, cp.checkpoint_id],
    )
  ).rows;
  const known = new Set<string>();
  let parentCount = 0;
  let pages: WorkingPage[] = parent
    ? (
        await c.query(
          "SELECT p.* FROM hub_backup_catalog_root_pages r JOIN hub_backup_catalog_pages p USING(profile_id,page_id) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 ORDER BY r.ordinal",
          [pid, parent],
        )
      ).rows
    : [];
  const virtual = (entries: Entry[]): WorkingPage => ({
    page_id: "",
    digest: "",
    entry_count: entries.length,
    lower_key: entries[0].namespace,
    upper_key: entries.at(-1)!.namespace,
    entries,
  });
  const apply = (old: Entry[], updates: Change[]) => {
    const entries = new Map(
      old.map((e) => {
        known.add(e.namespace);
        return [e.namespace, e] as const;
      }),
    );
    for (const e of updates) {
      if (e.kind === "deleted") entries.delete(e.namespace);
      else
        entries.set(e.namespace, {
          namespace: e.namespace,
          namespace_version_id: e.namespace_version_id,
        });
    }
    return [...entries.values()].sort((a, b) =>
      compare(a.namespace, b.namespace),
    );
  };
  if (!pages.length) {
    const old: Entry[] = parent
      ? (
          await c.query(
            'SELECT namespace,namespace_version_id FROM hub_backup_catalog_namespace_refs WHERE profile_id=$1 AND checkpoint_id=$2 ORDER BY namespace COLLATE "C" LIMIT 1025',
            [pid, parent],
          )
        ).rows
      : [];
    parentCount = old.length;
    pages = chunks(apply(old, changes)).map(virtual);
  } else {
    parentCount = pages.reduce((n, p) => n + Number(p.entry_count), 0);
    const touched = new Map<number, Change[]>();
    for (const e of changes) {
      let i = pages.findIndex((p) => compare(e.namespace, p.upper_key) <= 0);
      if (i < 0) i = pages.length - 1;
      const group = touched.get(i) || [];
      group.push(e);
      touched.set(i, group);
    }
    const updated: WorkingPage[] = [];
    for (let i = 0; i < pages.length; i++) {
      if (!touched.has(i)) {
        updated.push(pages[i]);
        continue;
      }
      const old: Entry[] = (
        await c.query(
          'SELECT namespace,namespace_version_id FROM hub_backup_catalog_entries WHERE profile_id=$1 AND page_id=$2 ORDER BY namespace COLLATE "C"',
          [pid, pages[i].page_id],
        )
      ).rows;
      updated.push(...chunks(apply(old, touched.get(i)!)).map(virtual));
    }
    pages = updated;
  }
  const removed = changes.filter(
    (e) => e.kind === "deleted" && known.has(e.namespace),
  ).length;
  const added = changes.filter(
    (e) => e.kind !== "deleted" && !known.has(e.namespace),
  );
  const rejected = added.slice(
    Math.max(0, BACKUP_V2.maxCatalogNamespaces - (parentCount - removed)),
  );
  if (rejected.length)
    throw new AppError(
      "BACKUP_CATALOG_FULL",
      "This backup catalog is full. New namespaces remain local; existing namespace updates are supported.",
      413,
      {
        checkpointId: cp.checkpoint_id,
        manifestDigest: cp.manifest_digest,
        rejectedNamespaceVersionIds: rejected.map(
          (e) => e.namespace_version_id,
        ),
      },
    );
  // Deletion rebalances at most neighboring leaves, freeing usable catalog slots.
  const entries = async (p: WorkingPage) =>
    p.entries ||
    ((
      await c.query(
        'SELECT namespace,namespace_version_id FROM hub_backup_catalog_entries WHERE profile_id=$1 AND page_id=$2 ORDER BY namespace COLLATE "C"',
        [pid, p.page_id],
      )
    ).rows as Entry[]);
  for (let i = 0; i < pages.length; ) {
    if (pages.length === 1 || Number(pages[i].entry_count) >= 32) {
      i++;
      continue;
    }
    const low = i > 0 ? i - 1 : i;
    const both = [
      ...(await entries(pages[low])),
      ...(await entries(pages[low + 1])),
    ].sort((a, b) => compare(a.namespace, b.namespace));
    pages.splice(low, 2, ...chunks(both).map(virtual));
    i = Math.max(0, low - 1);
  }
  const count = pages.reduce((n, p) => n + Number(p.entry_count), 0);
  if (count > BACKUP_V2.maxCatalogNamespaces || pages.length > 32)
    throw new AppError(
      "BACKUP_INVALID",
      "The bounded catalog directory is inconsistent.",
    );
  const saved: Page[] = [];
  for (const page of pages)
    saved.push(page.entries ? await savePage(c, pid, page.entries) : page);
  const root = sha(
    canonicalBackupJson(
      saved.map((p) => ({
        digest: p.digest,
        count: Number(p.entry_count),
        lower: p.lower_key,
        upper: p.upper_key,
      })),
    ),
  );
  if (saved.length)
    await c.query(
      "INSERT INTO hub_backup_catalog_root_pages SELECT $1,$2,x.ordinal,x.page_id FROM jsonb_to_recordset($3::jsonb) x(ordinal smallint,page_id uuid)",
      [
        pid,
        cp.checkpoint_id,
        JSON.stringify(
          saved.map((p, ordinal) => ({ ordinal, page_id: p.page_id })),
        ),
      ],
    );
  await c.query(
    'UPDATE hub_backup_checkpoints SET catalog_count=$3,catalog_digest=$4,catalog_cursor=\'{"phase":"namespace-parts"}\' WHERE profile_id=$1 AND checkpoint_id=$2',
    [pid, cp.checkpoint_id, count, root],
  );
}
/** One short transaction, <=64 immutable refs. Never takes a hub_profiles lock. */
async function slice(
  c: PoolClient,
  pid: string,
  id: string,
  resolved: string,
): Promise<boolean> {
  const cp = (
    await c.query(
      "SELECT * FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2 FOR UPDATE",
      [pid, id],
    )
  ).rows[0];
  if (cp?.receipt) return true;
  if (!cp || cp.status !== "prepared" || new Date(cp.expires_at) < new Date())
    throw new AppError(
      "BACKUP_CONFLICT",
      "This prepared catalog is no longer publishable.",
      409,
    );
  if (cp.catalog_ready) return true;
  const state = cp.catalog_cursor || { phase: "root" };
  if (state.phase === "root") {
    await buildRoot(c, pid, cp);
    return false;
  }
  if (state.phase === "namespace-parts") {
    const ns = (
      await c.query(
        'SELECT v.* FROM hub_backup_catalog_namespace_refs r JOIN hub_backup_namespace_versions v USING(profile_id,namespace_version_id) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND NOT v.parts_ready ORDER BY r.namespace COLLATE "C" LIMIT 1 FOR UPDATE OF v',
        [pid, id],
      )
    ).rows[0];
    if (ns) {
      const rows = (
        await c.query(
          resolved +
            `, wanted AS (SELECT f->>'sha256' hash FROM resolved r CROSS JOIN LATERAL jsonb_array_elements(r.fragments) f UNION SELECT p->>'sha256' FROM hub_backup_namespace_versions v CROSS JOIN LATERAL jsonb_array_elements(v.manifest->'parts') p WHERE v.profile_id=$1 AND v.namespace_version_id=$2) SELECT w.hash,p.bytes FROM wanted w LEFT JOIN hub_backup_parts p ON p.profile_id=$1 AND p.hash=w.hash WHERE w.hash>$3 ORDER BY w.hash LIMIT 65`,
          [pid, ns.namespace_version_id, ns.parts_cursor || ""],
        )
      ).rows;
      if (rows.some((r) => r.bytes == null)) throw incomplete();
      if (rows.length)
        await c.query(
          "INSERT INTO hub_backup_namespace_parts SELECT $1,$2,x.hash,x.bytes FROM jsonb_to_recordset($3::jsonb) x(hash text,bytes integer) ON CONFLICT DO NOTHING",
          [pid, ns.namespace_version_id, JSON.stringify(rows.slice(0, 64))],
        );
      await c.query(
        "UPDATE hub_backup_namespace_versions SET parts_ready=$3,parts_cursor=$4 WHERE profile_id=$1 AND namespace_version_id=$2",
        [
          pid,
          ns.namespace_version_id,
          rows.length <= 64,
          rows.length > 64 ? rows[63].hash : null,
        ],
      );
      return false;
    }
    await c.query(
      'UPDATE hub_backup_checkpoints SET catalog_cursor=\'{"phase":"parts","key":""}\' WHERE profile_id=$1 AND checkpoint_id=$2',
      [pid, id],
    );
    return false;
  }
  if (state.phase === "parts") {
    const rows = (
      await c.query(
        "SELECT DISTINCT p.hash,p.bytes FROM hub_backup_catalog_namespace_refs r JOIN hub_backup_namespace_parts p USING(profile_id,namespace_version_id) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND p.hash>$3 ORDER BY p.hash LIMIT 65",
        [pid, id, state.key || ""],
      )
    ).rows;
    if (rows.length)
      await c.query(
        "INSERT INTO hub_backup_checkpoint_parts(profile_id,checkpoint_id,hash,bytes) SELECT $1,$2,x.hash,x.bytes FROM jsonb_to_recordset($3::jsonb) x(hash text,bytes integer) ON CONFLICT DO NOTHING",
        [pid, id, JSON.stringify(rows.slice(0, 64))],
      );
    await c.query(
      "UPDATE hub_backup_checkpoints SET catalog_cursor=$3 WHERE profile_id=$1 AND checkpoint_id=$2",
      [
        pid,
        id,
        {
          phase: rows.length > 64 ? "parts" : "hold",
          key: rows.length > 64 ? rows[63].hash : "",
        },
      ],
    );
    return false;
  }
  if (state.phase === "hold") {
    const rows = (
      await c.query(
        "SELECT r.hash,p.bytes FROM hub_backup_checkpoint_parts r LEFT JOIN hub_backup_parts p USING(profile_id,hash) WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND r.hash>$3 ORDER BY r.hash LIMIT 65",
        [pid, id, state.key || ""],
      )
    ).rows;
    if (rows.some((r) => r.bytes == null)) throw incomplete();
    const hashes = rows.slice(0, 64).map((r) => r.hash);
    // Existing active references are a durable preparation pin, not a new byte charge.
    if (hashes.length)
      await c.query(
        `WITH held AS(UPDATE hub_backup_parts p SET published_refs=published_refs+1,ever_published=true FROM hub_backup_checkpoint_parts r WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND r.hash=ANY($3::text[]) AND NOT r.ref_held AND p.profile_id=r.profile_id AND p.hash=r.hash AND p.published_refs>0 RETURNING p.hash) UPDATE hub_backup_checkpoint_parts r SET ref_held=true FROM held h WHERE r.profile_id=$1 AND r.checkpoint_id=$2 AND r.hash=h.hash`,
        [pid, id, hashes],
      );
    if (rows.length > 64) {
      await c.query(
        "UPDATE hub_backup_checkpoints SET catalog_cursor=$3 WHERE profile_id=$1 AND checkpoint_id=$2",
        [pid, id, { phase: "hold", key: rows[63].hash }],
      );
      return false;
    }
    const pending = (
      await c.query(
        "SELECT hash FROM hub_backup_checkpoint_parts WHERE profile_id=$1 AND checkpoint_id=$2 AND NOT ref_held ORDER BY hash LIMIT 33",
        [pid, id],
      )
    ).rows;
    if (pending.length > BACKUP_V2.maxParts) throw incomplete();
    await c.query(
      'UPDATE hub_backup_checkpoints SET catalog_ready=true,catalog_cursor=\'{"phase":"ready"}\' WHERE profile_id=$1 AND checkpoint_id=$2',
      [pid, id],
    );
    return true;
  }
  throw new AppError(
    "BACKUP_INVALID",
    "Invalid durable catalog preparation state.",
  );
}
export async function prepareBackupCatalog(
  tx: CatalogTransaction,
  profileId: string,
  id: string,
  resolved: string,
  signal: AbortSignal,
) {
  const deadline = performance.now() + 1800;
  while (performance.now() < deadline) {
    if (signal.aborted) throw busy();
    if (await tx((c) => slice(c, profileId, id, resolved))) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw busy();
}
export async function catalogSummary(c: PoolClient, pid: string, cp: any) {
  if (Number(cp.catalog_version) === 1) {
    if (!cp.catalog_ready && cp.status === "complete") throw incomplete();
    return {
      format: "atlas-paged-catalog-v1" as const,
      namespaceCount: Number(cp.catalog_count),
      rootDigest: cp.catalog_digest,
    };
  }
  const rows = (
    await c.query(
      'SELECT namespace,namespace_version_id FROM hub_backup_catalog_namespace_refs WHERE profile_id=$1 AND checkpoint_id=$2 ORDER BY namespace COLLATE "C" LIMIT 65',
      [pid, cp.checkpoint_id],
    )
  ).rows;
  return {
    format: "atlas-paged-catalog-v1" as const,
    namespaceCount: rows.length,
    rootDigest: sha(canonicalBackupJson(rows)),
  };
}
export function catalogCursor(
  secret: string,
  id: string,
  root: string,
  index: number,
) {
  const token = Buffer.from(JSON.stringify({ id, root, index })).toString(
    "base64url",
  );
  return (
    token + "." + createHmac("sha256", secret).update(token).digest("base64url")
  );
}
export function readCatalogCursor(
  secret: string,
  value: unknown,
  id: string,
  root: string,
) {
  if (value == null) return 0;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  )
    throw new AppError("BACKUP_INVALID", "Invalid immutable catalog cursor.");
  const [token, sig] = value.split(".");
  if (createHmac("sha256", secret).update(token).digest("base64url") !== sig)
    throw new AppError("BACKUP_INVALID", "Invalid immutable catalog cursor.");
  let data: any;
  try {
    data = JSON.parse(Buffer.from(token, "base64url").toString());
  } catch {
    throw new AppError("BACKUP_INVALID", "Invalid immutable catalog cursor.");
  }
  if (
    data.id !== id ||
    data.root !== root ||
    !Number.isInteger(data.index) ||
    data.index < 0 ||
    data.index > BACKUP_V2.maxCatalogNamespaces
  )
    throw new AppError(
      "BACKUP_INVALID",
      "Catalog cursor does not belong to this checkpoint.",
    );
  return data.index;
}
