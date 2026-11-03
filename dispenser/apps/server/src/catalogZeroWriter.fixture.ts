/**
 * Newly authored schema-compatibility fixture, NOT recovered historical Hub code.
 *
 * It uses only tables/columns present after migration0025, before catalog fields
 * existed. Run the identical SQL before and after0026 to prove that this limited
 * writer contract still works. It does not emulate old HTTP/auth/quota logic and
 * must never be used as an application publisher or historical-binary proof.
 */
import type { Pool } from "pg";
import {
  hubNamespace,
  type BackupCheckpointV2,
  type BackupPublishReceiptV2,
} from "@atlas-link-dispenser/shared";

export const catalogZeroWriterSQL = {
  begin: "BEGIN",
  replica:
    "INSERT INTO hub_backup_replicas(profile_id,replica_id,incarnation,branch_id,origin,label) VALUES($1,$2,$3,$4,$5,$6)",
  checkpoint:
    "INSERT INTO hub_backup_checkpoints(profile_id,checkpoint_id,replica_id,sequence,parent_checkpoint_id,manifest_digest,manifest) VALUES($1,$2,$3,$4,$5,$6,$7)",
  namespace:
    "INSERT INTO hub_backup_namespace_versions(profile_id,namespace_version_id,checkpoint_id,namespace,parent_version_id,kind,local_cut,schema_epoch,root_digest,manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
  checkpointNamespace:
    "INSERT INTO hub_backup_checkpoint_namespaces(profile_id,checkpoint_id,namespace,namespace_version_id) VALUES($1,$2,$3,$4)",
  stamp:
    "SELECT nextval('hub_backup_publication_order')::text AS ordinal,now() AS completed_at",
  complete:
    "UPDATE hub_backup_checkpoints SET status='complete',publication_ordinal=$3,completed_at=$4,history_day=($4::timestamptz AT TIME ZONE 'UTC')::date,receipt=$5 WHERE profile_id=$1 AND checkpoint_id=$2",
  head: "UPDATE hub_backup_replicas SET head_checkpoint_id=$3,head_sequence=$4,updated_at=now() WHERE profile_id=$1 AND replica_id=$2",
  commit: "COMMIT",
  rollback: "ROLLBACK",
} as const;

export async function publishCatalogZeroSQLFixture(
  pool: Pick<Pool, "connect">,
  input: {
    profileId: string;
    branchId: string;
    origin: string;
    manifest: BackupCheckpointV2;
  },
): Promise<BackupPublishReceiptV2> {
  const { profileId, branchId, origin, manifest: m } = input;
  // This bounded fixture intentionally publishes only empty baseline namespaces.
  // Supporting real data/parts or pretending to exercise old publisher semantics
  // would exceed its stated schema-contract purpose.
  if (
    m.parentCheckpointId !== null ||
    m.sequence !== 1 ||
    m.namespaces.length !== 1 ||
    m.namespaces.some((n) => n.kind !== "baseline" || n.parts.length !== 0)
  )
    throw new Error("CATALOG_ZERO_FIXTURE_REQUIRES_EMPTY_BASELINE");
  const c = await pool.connect();
  let inTransaction = false;
  try {
    await c.query(catalogZeroWriterSQL.begin);
    inTransaction = true;
    await c.query(catalogZeroWriterSQL.replica, [
      profileId,
      m.replicaId,
      m.incarnation,
      branchId,
      origin,
      "Newly authored pre-0026 SQL fixture",
    ]);
    await c.query(catalogZeroWriterSQL.checkpoint, [
      profileId,
      m.checkpointId,
      m.replicaId,
      m.sequence,
      m.parentCheckpointId,
      m.manifestDigest,
      m,
    ]);
    for (const n of m.namespaces) {
      const key = hubNamespace(n.namespace).key;
      await c.query(catalogZeroWriterSQL.namespace, [
        profileId,
        n.namespaceVersionId,
        m.checkpointId,
        key,
        n.parentNamespaceVersionId,
        n.kind,
        n.localCut,
        String(n.schemaEpoch),
        n.rootDigest,
        n,
      ]);
      await c.query(catalogZeroWriterSQL.checkpointNamespace, [
        profileId,
        m.checkpointId,
        key,
        n.namespaceVersionId,
      ]);
    }
    const stamp = (await c.query(catalogZeroWriterSQL.stamp)).rows[0];
    const receipt: BackupPublishReceiptV2 = {
      acknowledged: true,
      checkpointId: m.checkpointId,
      replicaId: m.replicaId,
      sequence: m.sequence,
      manifestDigest: m.manifestDigest,
      publicationOrdinal: String(stamp.ordinal),
      completedAt: new Date(stamp.completed_at).toISOString(),
      coverage: m.namespaces.map((n) => ({
        namespaceVersionId: n.namespaceVersionId,
        localCut: n.localCut,
      })),
      historyShortened: false,
    };
    await c.query(catalogZeroWriterSQL.complete, [
      profileId,
      m.checkpointId,
      receipt.publicationOrdinal,
      receipt.completedAt,
      receipt,
    ]);
    await c.query(catalogZeroWriterSQL.head, [
      profileId,
      m.replicaId,
      m.checkpointId,
      m.sequence,
    ]);
    await c.query(catalogZeroWriterSQL.commit);
    inTransaction = false;
    return receipt;
  } catch (error) {
    if (inTransaction) await c.query(catalogZeroWriterSQL.rollback);
    throw error;
  } finally {
    c.release();
  }
}
