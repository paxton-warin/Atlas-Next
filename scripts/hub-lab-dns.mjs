/** Resolve simulated endpoints locally inside lab child processes only. */
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
if (process.env.NODE_ENV !== "test" || !process.env.ATLAS_LAB_STATE)
  throw Error("Lab DNS is test-only.");
const state = JSON.parse(readFileSync(process.env.ATLAS_LAB_STATE, "utf8"));
if (!/^[a-f0-9-]{36}$/i.test(state.id)) throw Error("Invalid lab identity.");
const original = dns.lookup;
dns.lookup = function (hostname, ...args) {
  return original.call(
    this,
    /^(?:[a-z0-9-]+\.){1,2}localhost$/.test(hostname) ? "127.0.0.1" : hostname,
    ...args,
  );
};
const originalPromise = dns.promises.lookup;
dns.promises.lookup = function (hostname, ...args) {
  return originalPromise.call(
    this,
    /^(?:[a-z0-9-]+\.){1,2}localhost$/.test(hostname) ? "127.0.0.1" : hostname,
    ...args,
  );
};
syncBuiltinESMExports();
