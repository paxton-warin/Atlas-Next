/** Admission only. All JSON/base64/record hashing/graph work runs off the Hub event loop. */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { BACKUP_V2 } from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
export type IndexedBackupRecord = {
  recordId: string;
  store: string;
  storeEpoch: number;
  operation: string;
  sha256: string;
  totalBytes: number;
  fragments: Array<{ sha256: string; index: number }>;
};
let active = 0;
export async function validateBackupParts(
  namespaceVersionId: string,
  parts: Array<{ sha256: string; bytes: Buffer }>,
  signal?: AbortSignal,
  namespace?: unknown,
  localCut = Number.MAX_SAFE_INTEGER,
): Promise<IndexedBackupRecord[]> {
  if (active >= 2)
    throw new AppError(
      "BACKUP_BUSY",
      "Backup validation is busy. Local saves are retained.",
      503,
    );
  if (
    parts.length > BACKUP_V2.maxParts ||
    parts.reduce((n, p) => n + p.bytes.length, 0) > BACKUP_V2.cycleBytes ||
    parts.some((p) => p.bytes.length > BACKUP_V2.partBytes)
  )
    throw new AppError(
      "BACKUP_INVALID",
      "Backup validation byte budget exceeded.",
    );
  if (signal?.aborted)
    throw new AppError(
      "BACKUP_BUSY",
      "Backup validation was interrupted.",
      503,
    );
  const adjacent = new URL(
      "./hubBackupsV2ValidationWorker.js",
      import.meta.url,
    ),
    compiled = new URL(
      "../dist/hubBackupsV2ValidationWorker.js",
      import.meta.url,
    ),
    entry = existsSync(adjacent) ? adjacent : compiled;
  active++;
  try {
    return await new Promise<IndexedBackupRecord[]>((resolve, reject) => {
      const worker = new Worker(entry, {
        workerData: { namespaceVersionId, parts, namespace, localCut },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
        },
      });
      let settled = false;
      const finish = (error?: unknown, value?: IndexedBackupRecord[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void worker.terminate();
        error ? reject(error) : resolve(value!);
      };
      const abort = () =>
          finish(
            new AppError(
              "BACKUP_BUSY",
              "Backup validation was interrupted.",
              503,
            ),
          ),
        timer = setTimeout(
          () =>
            finish(
              new AppError(
                "BACKUP_BUSY",
                "Backup validation exceeded its work budget.",
                503,
              ),
            ),
          5000,
        );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", (value) =>
        value?.ok === true
          ? finish(undefined, value.records)
          : finish(
              new AppError("BACKUP_INVALID", "Backup record data is invalid."),
            ),
      );
      worker.once("error", () =>
        finish(
          new AppError(
            "BACKUP_BUSY",
            "Backup validation actor stopped. Local saves are retained.",
            503,
          ),
        ),
      );
      worker.once("exit", () => {
        if (!settled)
          finish(
            new AppError(
              "BACKUP_BUSY",
              "Backup validation actor stopped before completion.",
              503,
            ),
          );
      });
    });
  } finally {
    active--;
  }
}
