import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { registerHubProfileRoutes } from "./hubProfiles.js";
import {
  registerLegacyProfileWriteRetirement,
  isRetiredLegacyProfileWrite,
} from "./hubLegacyProfileRetirement.js";
const base = "/api/hub/branch/profile";
const writes: Array<["POST" | "PUT" | "DELETE", string]> = [
  ["POST", "/commits"],
  ["POST", "/chunks"],
  ["POST", "/recoveries"],
  ["POST", "/imports"],
  ["POST", "/imports/fixture/commit"],
  ["DELETE", "/imports/fixture"],
  ["POST", "/writers"],
  ["PUT", "/writers"],
  ["DELETE", "/writers"],
  ["POST", "/writers/takeover"],
  ["POST", "/writers/requests/fixture/ack"],
  ["POST", "/backups/v2/legacy-conversions"],
];
describe("Hard retirement of legacy website replication before any database work", () => {
  it("returns typed nonretryable410 for every old mutation, including invalid/emptyJSON, without auth/pool/query", async () => {
    const app = Fastify({ logger: false });
    let connects = 0,
      queries = 0,
      auth = 0;
    const pool = {
      connect: async () => {
        connects++;
        throw Error("DATABASE_MUST_NOT_BE_CONTACTED");
      },
      query: async () => {
        queries++;
        throw Error("DATABASE_MUST_NOT_BE_CONTACTED");
      },
    };
    registerHubProfileRoutes(app, {
      pool: pool as any,
      identity: {
        authenticate: async () => {
          auth++;
          throw Error("AUTH_MUST_NOT_BE_CONTACTED");
        },
      } as any,
      encryptionKey: "fixture-only",
    });
    await app.ready();
    try {
      for (const [method, path] of writes)
        for (const payload of [
          "{",
          "",
          JSON.stringify({ payload: "ignored" }),
        ]) {
          const r = await app.inject({
            method,
            url: base + path + "?ignored=1",
            headers: { "content-type": "application/json" },
            payload,
          });
          expect(r.statusCode, r.body).toBe(410);
          expect(r.json().error).toMatchObject({
            code: "PROFILE_LEGACY_SYNC_RETIRED",
            retryable: false,
          });
          expect(r.headers["cache-control"]).toBe("no-store");
        }
      expect({ connects, queries, auth }).toEqual({
        connects: 0,
        queries: 0,
        auth: 0,
      });
    } finally {
      await app.close();
    }
  });
  it("does not retire authentication, transport, support/admin, normalpreferences or any backup-v2 route", async () => {
    const app = Fastify({ logger: false });
    registerLegacyProfileWriteRetirement(app);
    const retained: Array<["GET" | "POST" | "PUT" | "DELETE", string]> = [
      ["GET", base],
      ["POST", base + "/stream"],
      ["GET", base + "/preferences"],
      ["POST", base + "/preferences"],
      ["GET", base + "/chunks/hash"],
      ["GET", base + "/recoveries/id"],
      ["POST", "/api/hub/branch/session"],
      ["POST", "/api/hub/branch/exchange"],
      ["POST", "/api/hub/branch/support/tickets"],
      ["DELETE", "/api/admin/users/id"],
      ["GET", base + "/backups/v2/checkpoints/latest"],
      ["POST", base + "/backups/v2/replicas/id/checkpoints"],
      ["PUT", base + "/backups/v2/staging/id/parts/hash"],
      ["POST", base + "/backups/v2/staging/id/publish"],
      ["POST", base + "/backups/v2/replicas/id/adopt"],
      ["DELETE", base + "/backups/v2/replicas/id"],
      ["GET", base + "/backups/v2/legacy-conversions/id"],
    ];
    for (const [method, url] of retained)
      app.route({ method, url, handler: async () => ({ retained: true }) });
    await app.ready();
    try {
      for (const [method, url] of retained) {
        expect(isRetiredLegacyProfileWrite(method, url)).toBe(false);
        const r = await app.inject({ method, url });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toEqual({ retained: true });
      }
    } finally {
      await app.close();
    }
  });
  it("removes legacy conversion execution from external and internal automatic worker paths", async () => {
    const worker = await readFile(
        new URL("./hubBackupsV2Worker.ts", import.meta.url),
        "utf8",
      ),
      legacy = await readFile(
        new URL("./hubBackupsV2Legacy.ts", import.meta.url),
        "utf8",
      );
    expect(worker).not.toContain("runLegacyConversionJob");
    const registration = legacy.slice(
      legacy.indexOf("export function registerHubLegacyConversionRoutes"),
      legacy.indexOf("async function finishConversionJob"),
    );
    expect(registration).not.toContain("setInterval");
    expect(registration).not.toContain("runLegacyConversionJob");
  });
});
