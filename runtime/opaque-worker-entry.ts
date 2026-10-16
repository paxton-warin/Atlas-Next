/** Bundled with the exact copied core, then embedded byte-for-byte in the
 * trusted document asset. Its native Blob never fetches frontend script bytes. */
import {
  workerBootstrap,
  bootOpaqueDedicatedWorker,
} from "./opaque-workers.ts";
workerBootstrap(bootOpaqueDedicatedWorker);
