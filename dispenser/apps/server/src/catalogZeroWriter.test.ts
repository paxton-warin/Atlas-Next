import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { BackupCheckpointV2 } from "@atlas-link-dispenser/shared";
import {
  catalogZeroWriterSQL,
  publishCatalogZeroSQLFixture,
} from "./catalogZeroWriter.fixture.js";

const manifest = (): BackupCheckpointV2 => ({
  format: "atlas-checkpoint-v2",
  checkpointId: randomUUID(),
  replicaId: randomUUID(),
  incarnation: randomUUID(),
  sequence: 1,
  parentCheckpointId: null,
  manifestDigest: "0".repeat(64),
  adoptedThrough: 0,
  namespaces: [
    {
      namespace: { kind: "local", origin: "https://save.example" },
      namespaceVersionId: randomUUID(),
      parentNamespaceVersionId: null,
      localCut: 1,
      schemaEpoch: 1,
      kind: "baseline",
      rootDigest: "0".repeat(64),
      parts: [],
      coverage: "complete-at-cut",
    },
  ],
});

function database(failAt?: string) {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === failAt) throw Error("fixture write failed");
      return {
        rows: [{ ordinal: "1", completed_at: "2026-01-01T00:00:00.000Z" }],
      };
    },
    release: () => {
      released = true;
    },
  };
  const pool = { connect: async () => client } as unknown as Pick<
    Pool,
    "connect"
  >;
  return { pool, queries, released: () => released };
}

describe("newly authored catalog-zero SQL schema fixture (not historical server)", () => {
  it("names no columns or tables introduced by0026", () => {
    const sql = Object.values(catalogZeroWriterSQL).join("\n");
    expect(sql).not.toMatch(
      /catalog_|parts_ready|ref_held|ever_published|gc_eligible|lease_id|last_cancel|replacement_proof/,
    );
    expect(sql).toContain("hub_backup_checkpoint_namespaces");
    expect(sql).toContain("hub_backup_namespace_versions");
  });
  it("writes one bounded empty-baseline checkpoint atomically using the shared protocol shape", async () => {
    const db = database(),
      m = manifest();
    const receipt = await publishCatalogZeroSQLFixture(db.pool, {
      profileId: randomUUID(),
      branchId: randomUUID(),
      origin: "https://fixture.example",
      manifest: m,
    });
    expect(db.queries).toEqual([
      catalogZeroWriterSQL.begin,
      catalogZeroWriterSQL.replica,
      catalogZeroWriterSQL.checkpoint,
      catalogZeroWriterSQL.namespace,
      catalogZeroWriterSQL.checkpointNamespace,
      catalogZeroWriterSQL.stamp,
      catalogZeroWriterSQL.complete,
      catalogZeroWriterSQL.head,
      catalogZeroWriterSQL.commit,
    ]);
    expect(receipt).toMatchObject({
      acknowledged: true,
      checkpointId: m.checkpointId,
    });
    expect(db.released()).toBe(true);
  });
  it("rolls back and releases the connection after a write failure", async () => {
    const db = database(catalogZeroWriterSQL.namespace);
    await expect(
      publishCatalogZeroSQLFixture(db.pool, {
        profileId: randomUUID(),
        branchId: randomUUID(),
        origin: "https://fixture.example",
        manifest: manifest(),
      }),
    ).rejects.toThrow("fixture write failed");
    expect(db.queries.at(-1)).toBe("ROLLBACK");
    expect(db.queries).not.toContain("COMMIT");
    expect(db.released()).toBe(true);
  });
  it("rejects real payload parts instead of pretending to implement a production publisher", async () => {
    const db = database(),
      m = manifest();
    m.namespaces[0].parts.push({
      ordinal: 0,
      bytes: 1,
      sha256: "0".repeat(64),
    });
    await expect(
      publishCatalogZeroSQLFixture(db.pool, {
        profileId: randomUUID(),
        branchId: randomUUID(),
        origin: "https://fixture.example",
        manifest: m,
      }),
    ).rejects.toThrow("CATALOG_ZERO_FIXTURE_REQUIRES_EMPTY_BASELINE");
    expect(db.queries).toEqual([]);
  });
});
