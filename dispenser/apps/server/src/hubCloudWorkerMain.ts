/** Separate executable: pnpm --filter @atlas-link-dispenser/server exec tsx src/hubCloudWorkerMain.ts */
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { HttpSimulationCoordinator } from "./hubCloudSimulation.js";
import { config } from "./config.js";
import { loadCloudOriginKeys } from "./hubCloudOriginKeys.js";
import { HubCloudWorker } from "./hubCloudWorker.js";
const pool = new Pool({ connectionString: config.databaseUrl });
const simulation =
  process.env.HUB_CLOUD_SIMULATION_AUTO_ACTIVATE === "1"
    ? (() => {
        if (
          process.env.NODE_ENV !== "test" ||
          process.env.HUB_CLOUD_FAKE !== "1" ||
          !process.env.ATLAS_LAB_STATE
        )
          throw Error(
            "Simulation activation requires an explicit local laboratory.",
          );
        const state = JSON.parse(
          readFileSync(process.env.ATLAS_LAB_STATE, "utf8"),
        );
        return {
          coordinator: new HttpSimulationCoordinator(
            config.appUrl,
            config.hubServiceSecret,
          ),
          sessionSecret: config.sessionSecret,
          initialCredentials: { [state.branchId]: state.branchSecret },
        };
      })()
    : undefined;
const worker = new HubCloudWorker(pool, {
  simulation,
  encryptionKey: config.encryptionKey,
  executable: process.env.HUB_CLOUD_AWS_EXECUTABLE,
  originKey: loadCloudOriginKeys(process.env.HUB_CLOUD_ORIGIN_KEYS_FILE) ?? process.env.HUB_CLOUD_ORIGIN_KEY,
  fake: process.env.HUB_CLOUD_FAKE === "1",
});
let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopped = true;
  });
try {
  while (!stopped) {
    try {
      await worker.tick();
    } catch {
      process.stderr.write("Cloud worker tick failed; retrying.\n");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await worker.close();
  await pool.end();
}
