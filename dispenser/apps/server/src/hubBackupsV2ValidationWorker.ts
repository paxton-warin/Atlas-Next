/** All payload parsing, hashing, base64 and graph work stays in this bounded actor. */
import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import {
  BACKUP_V2,
  canonicalBackupJson,
  decodePortableValue,
  type BackupRecordPageV2,
} from "@atlas-link-dispenser/shared";
import type { IndexedBackupRecord } from "./hubBackupsV2Validation.js";
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const invalid = () => {
  throw Error("BACKUP_INVALID");
};
function key(k: any, depth = 0, budget = { nodes: 0 }): void {
  if (
    ++budget.nodes > 4096 ||
    depth > 64 ||
    !k ||
    typeof k !== "object" ||
    Array.isArray(k)
  )
    invalid();
  if (k.t === "array") {
    if (!Array.isArray(k.v) || k.v.length > 4096) invalid();
    for (const a of k.v) key(a, depth + 1, budget);
    return;
  }
  if (typeof k.v !== "string") invalid();
  if (k.t === "number") {
    if (k.v === "NaN" || String(Number(k.v)) !== k.v) invalid();
    return;
  }
  if (k.t === "date") {
    if (
      !Number.isFinite(Number(k.v)) ||
      String(Number(k.v)) !== k.v ||
      new Date(Number(k.v)).getTime() !== Number(k.v)
    )
      invalid();
    return;
  }
  if (k.t === "binary") {
    if (Buffer.from(k.v, "base64").toString("base64") !== k.v) invalid();
    return;
  }
  if (k.t !== "string") invalid();
}
function validate(input: any): IndexedBackupRecord[] {
  const groups = new Map<
    string,
    {
      recordId: string;
      count: number;
      totalBytes: number;
      sha256: string;
      fragments: Array<{ sha256: string; index: number }>;
      data: Array<Buffer | undefined>;
    }
  >();
  let total = 0;
  for (const part of input.parts) {
    const raw = Buffer.from(part.bytes);
    if (
      raw.length < 1 ||
      raw.length > BACKUP_V2.partBytes ||
      hash(raw) !== part.sha256
    )
      invalid();
    const page = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ) as BackupRecordPageV2;
    if (
      page?.format !== "atlas-record-page-v2" ||
      page.namespaceVersionId !== input.namespaceVersionId ||
      !Array.isArray(page.records) ||
      page.records.length > 256
    )
      invalid();
    for (let index = 0; index < page.records.length; index++) {
      const f = page.records[index];
      if (
        !f ||
        !/^[a-f0-9]{64}$/.test(f.recordId) ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !Number.isSafeInteger(f.count) ||
        f.count < 1 ||
        f.count > 8 ||
        !Number.isSafeInteger(f.index) ||
        f.index < 0 ||
        f.index >= f.count ||
        !Number.isSafeInteger(f.totalBytes) ||
        f.totalBytes < 1 ||
        f.totalBytes > BACKUP_V2.recordBytes ||
        typeof f.data !== "string" ||
        f.data.length > BACKUP_V2.partBytes
      )
        invalid();
      const bytes = Buffer.from(f.data, "base64");
      if (bytes.toString("base64") !== f.data) invalid();
      total += bytes.length;
      if (total > BACKUP_V2.cycleBytes) invalid();
      let group = groups.get(f.recordId);
      if (!group) {
        if (groups.size >= BACKUP_V2.maxRecords) invalid();
        group = {
          recordId: f.recordId,
          count: f.count,
          totalBytes: f.totalBytes,
          sha256: f.sha256,
          fragments: [],
          data: Array(f.count),
        };
        groups.set(f.recordId, group);
      }
      if (
        group.count !== f.count ||
        group.totalBytes !== f.totalBytes ||
        group.sha256 !== f.sha256 ||
        group.data[f.index]
      )
        invalid();
      group.data[f.index] = bytes;
      group.fragments[f.index] = { sha256: part.sha256, index };
    }
  }
  const result: IndexedBackupRecord[] = [];
  for (const g of groups.values()) {
    if (g.data.filter(Boolean).length !== g.count) invalid();
    const raw = Buffer.concat(g.data as Buffer[]);
    if (raw.length !== g.totalBytes || hash(raw) !== g.sha256) invalid();
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !["put", "delete", "clear-store", "schema"].includes(value.operation) ||
      typeof value.store !== "string" ||
      value.store.length > 512 ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      value.generation > input.localCut ||
      (value.storeEpoch !== undefined &&
        (!Number.isSafeInteger(value.storeEpoch) || value.storeEpoch < 0))
    )
      invalid();
    const identity = {
      namespace: input.namespace,
      store: value.store,
      key: value.key || null,
      operationKey:
        value.operation === "schema"
          ? "schema"
          : value.operation === "clear-store"
            ? "clear"
            : "record",
    };
    if (hash(canonicalBackupJson(identity)) !== g.recordId) invalid();
    if (value.operation === "put" || value.operation === "delete")
      key(value.key);
    if (value.operation === "put" || value.operation === "schema") {
      const graph = value.value;
      if (
        !graph ||
        graph.codec !== "atlas-portable-v1" ||
        !Array.isArray(graph.nodes) ||
        graph.nodes.length > 4096
      )
        invalid();
      decodePortableValue(graph);
    }
    result.push({
      recordId: g.recordId,
      store: value.store,
      storeEpoch: value.storeEpoch || 0,
      operation: value.operation,
      sha256: g.sha256,
      totalBytes: g.totalBytes,
      fragments: g.fragments,
    });
  }
  return result;
}
if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, records: validate(workerData) });
  } catch {
    parentPort.postMessage({ ok: false, code: "BACKUP_INVALID" });
  }
}
