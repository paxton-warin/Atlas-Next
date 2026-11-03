/** Isolated single-job converter. stdin/stdout contain private pipe data only, never logs. */
import { createHash } from "node:crypto";
import {
  decodePortableValue,
  encodePortableValue,
  canonicalBackupJson,
  hubNamespace,
} from "@atlas-link-dispenser/shared";
import { decrypt } from "./security.js";
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
function key(v: any, depth = 0, budget = { nodes: 0 }): any {
  if (++budget.nodes > 4096 || depth > 64) throw Error("LEGACY_KEY_DEFERRED");
  if (typeof v === "string") return { t: "string", v };
  if (typeof v === "number" && !Number.isNaN(v))
    return { t: "number", v: String(Object.is(v, -0) ? 0 : v) };
  if (v instanceof Date && Number.isFinite(v.getTime()))
    return { t: "date", v: String(v.getTime()) };
  if (v instanceof ArrayBuffer)
    return { t: "binary", v: Buffer.from(v).toString("base64") };
  if (ArrayBuffer.isView(v))
    return {
      t: "binary",
      v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64"),
    };
  if (Array.isArray(v))
    return { t: "array", v: v.map((k) => key(k, depth + 1, budget)) };
  throw Error("LEGACY_KEY_DEFERRED");
}
export async function convertPinnedLegacy(input: any) {
  const { namespace, versionId, revision } = input;
  let graph = JSON.parse(decrypt(input.encryptedPayload, input.key));
  if (input.mode === "inspect")
    return { manifest: graph?.codec === "atlas-chunks-v1" ? graph : null };
  hubNamespace(namespace);
  if (graph?.codec === "atlas-chunks-v1") {
    if (
      !Array.isArray(graph.hashes) ||
      graph.hashes.length > 64 ||
      graph.bytes > 4 * 1024 * 1024
    )
      throw Error("LEGACY_SOURCE_OVERSIZED");
    const parts = graph.hashes.map((h: string) => {
      const p = input.chunks.find((c: any) => c.hash === h);
      if (!p) throw Error("LEGACY_CHUNK_MISSING");
      const bytes = Buffer.from(
        decrypt(p.encryptedPayload, input.key),
        "base64",
      );
      if (hash(bytes) !== h) throw Error("LEGACY_CHUNK_INTEGRITY");
      return bytes;
    });
    const raw = Buffer.concat(parts);
    if (raw.length !== graph.bytes || hash(raw) !== graph.sha256)
      throw Error("LEGACY_CHUNK_INTEGRITY");
    graph = JSON.parse(raw.toString("utf8"));
  }
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length > 40000)
    throw Error("LEGACY_GRAPH_DEFERRED");
  const value: any = decodePortableValue(graph),
    records: any[] = [],
    kind = namespace.kind;
  let schema: any = {
    format: "atlas-local-schema-v2",
    kind,
    version: 1,
    stores: [
      {
        name: "",
        keyPath: null,
        autoIncrement: false,
        generator: null,
        indexes: [],
      },
    ],
  };
  if (kind === "local") {
    if (
      value?.format !== "atlas-local-snapshot-v1" ||
      !Array.isArray(value.entries) ||
      value.entries.length > 4096
    )
      throw Error("LEGACY_LOCAL_UNSUPPORTED");
    for (const row of value.entries) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        row.some((v) => typeof v !== "string")
      )
        throw Error("LEGACY_LOCAL_INVALID");
      records.push({ store: "", key: row[0], value: row[1] });
    }
  } else if (kind === "cookies") {
    if (
      value?.format !== "atlas-cookie-snapshot-v1" ||
      !Array.isArray(value.cookies) ||
      value.cookies.length > 4096
    )
      throw Error("LEGACY_COOKIES_UNSUPPORTED");
    const group = hubNamespace(namespace).siteGroup;
    for (const cookie of value.cookies) {
      if (
        !cookie ||
        typeof cookie.id !== "string" ||
        typeof cookie.domain !== "string" ||
        hubNamespace({ kind: "cookies", origin: "https://" + cookie.domain })
          .siteGroup !== group ||
        cookie.id !==
          JSON.stringify([
            cookie.partition,
            cookie.domain,
            cookie.hostOnly,
            cookie.path,
            cookie.name,
          ])
      )
        throw Error("LEGACY_COOKIE_INVALID");
      records.push({
        store: "",
        key: cookie.id,
        value: { ...cookie, site: group },
      });
    }
  } else if (kind === "atlas") {
    if (
      value?.format !== "atlas-user-snapshot-v1" ||
      !value.values ||
      typeof value.values !== "object" ||
      Object.keys(value.values).length > 4096
    )
      throw Error("LEGACY_PREFERENCES_UNSUPPORTED");
    for (const [key, v] of Object.entries(value.values)) {
      if (typeof v !== "string") throw Error("LEGACY_PREFERENCES_INVALID");
      records.push({ store: "", key, value: v });
    }
  } else if (kind === "idb") {
    if (
      value?.format !== "atlas-idb-snapshot-v1" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1 ||
      !Array.isArray(value.stores) ||
      value.stores.length > 32 ||
      value.deleted
    )
      throw Error("LEGACY_IDB_UNSUPPORTED");
    const names = new Set();
    schema.version = value.version;
    schema.stores = [];
    for (const store of value.stores) {
      if (
        !store ||
        typeof store.name !== "string" ||
        store.name.length > 512 ||
        names.has(store.name) ||
        !Array.isArray(store.records) ||
        !Array.isArray(store.indexes) ||
        store.indexes.length > 64 ||
        typeof store.autoIncrement !== "boolean" ||
        !(
          store.keyPath === null ||
          typeof store.keyPath === "string" ||
          (Array.isArray(store.keyPath) &&
            store.keyPath.every((k: any) => typeof k === "string"))
        )
      )
        throw Error("LEGACY_IDB_SCHEMA_DEFERRED");
      names.add(store.name);
      if (
        store.autoIncrement &&
        (!store.generator ||
          (!("exhausted" in store.generator) &&
            (!Number.isInteger(store.generator.next) ||
              store.generator.next < 1 ||
              store.generator.next > 9007199254740992)))
      )
        throw Error("LEGACY_GENERATOR_MISSING");
      schema.stores.push({
        name: store.name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        generator: store.generator,
        indexes: store.indexes,
      });
      for (const record of store.records)
        records.push({
          store: store.name,
          key: record.key,
          value: record.value,
        });
    }
  }
  if (records.length > 8191) throw Error("LEGACY_RECORD_COUNT_DEFERRED");
  const output: any[] = [],
    encodedRecords = [
      {
        operation: "schema",
        store: "",
        value: await encodePortableValue(schema),
        generation: revision,
      },
    ];
  for (const record of records) {
    const native = await encodePortableValue(record.value);
    if (
      native.nodes.length > 4096 ||
      Buffer.byteLength(canonicalBackupJson(native)) > 256 * 1024
    )
      throw Error("LEGACY_RECORD_OVERSIZED");
    encodedRecords.push({
      operation: "put",
      store: record.store,
      key: key(record.key),
      value: native,
      generation: revision,
      storeEpoch: 1,
    } as any);
  }
  let total = 0;
  let page: any = {
    format: "atlas-record-page-v2",
    namespaceVersionId: versionId,
    records: [],
  };
  const flush = () => {
    if (!page.records.length) return;
    const part = Buffer.from(JSON.stringify(page));
    total += part.length;
    if (part.length > 262144 || total > 8 * 1024 * 1024 || output.length >= 32)
      throw Error("LEGACY_ENCODED_BUDGET_DEFERRED");
    output.push({
      sha256: hash(part),
      bytes: part.length,
      data: part.toString("base64"),
    });
    page = {
      format: "atlas-record-page-v2",
      namespaceVersionId: versionId,
      records: [],
    };
  };
  for (const record of encodedRecords) {
    const raw = Buffer.from(canonicalBackupJson(record));
    if (raw.length > 1048576) throw Error("LEGACY_RECORD_OVERSIZED");
    const recordId = hash(
        canonicalBackupJson({
          namespace,
          store: record.store,
          key: (record as any).key || null,
          operationKey: record.operation === "schema" ? "schema" : "record",
        }),
      ),
      count = Math.ceil(raw.length / (160 * 1024));
    for (let i = 0; i < count; i++) {
      const fragment = {
        recordId,
        index: i,
        count,
        totalBytes: raw.length,
        sha256: hash(raw),
        data: raw
          .subarray(i * 160 * 1024, (i + 1) * 160 * 1024)
          .toString("base64"),
      };
      page.records.push(fragment);
      if (
        page.records.length > 256 ||
        Buffer.byteLength(JSON.stringify(page)) > 262144
      ) {
        page.records.pop();
        flush();
        page.records.push(fragment);
      }
    }
  }
  flush();
  return { parts: output, kind: "baseline" };
}
if (process.env.ATLAS_BACKUP_CONVERTER_CHILD === "1") {
  const remaining =
    Number(process.env.ATLAS_BACKUP_CONVERTER_DEADLINE) - Date.now();
  if (Number.isFinite(remaining)) {
    const watchdog = setTimeout(() => process.exit(3), Math.max(1, remaining));
    watchdog.unref();
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 12 * 1024 * 1024) {
      process.exitCode = 2;
      process.stdin.destroy();
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on("end", () => {
    void (async () => {
      try {
        const result = await convertPinnedLegacy(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        process.stdout.write(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        const code = (error as Error)?.message;
        process.stdout.write(
          JSON.stringify({
            ok: false,
            code: /^LEGACY_[A-Z_]+$/.test(code)
              ? code
              : "LEGACY_CONVERSION_DEFERRED",
          }),
        );
      }
    })();
  });
}
