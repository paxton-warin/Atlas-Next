/** Worker-only private per-origin routing keys. Values never enter plans or HTTP responses. */
import { readFileSync, lstatSync } from "node:fs";
import { CloudError, validateOrigin } from "./hubCloudWorker.js";
export function loadCloudOriginKeys(path?: string): Readonly<Record<string, string>> | undefined {
  if (!path) return undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 262144)
      throw Error();
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 128)
      throw Error();
    const keys: Record<string, string> = Object.create(null);
    for (const [host, value] of Object.entries(raw)) {
      if (validateOrigin(host) !== host || typeof value !== "string" || value.length < 16 || value.length > 2048 || /[\r\n]/.test(value))
        throw Error();
      keys[host] = value;
    }
    return Object.freeze(keys);
  } catch {
    // JSON parse/OS errors may include private contents; expose only this code.
    throw new CloudError("ORIGIN_KEYS_FILE_INVALID");
  }
}
