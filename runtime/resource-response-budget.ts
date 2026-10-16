/** Finite buffered limits, independent of original CSP/CORS/cookie authority.
 * Large application bundles (including Discord's public web bundle) exceed
 * 8MiB decoded. Only script loading gets 32MiB; ordinary fetch/media stays8MiB.
 * Graph-wide limits and the network broker's four-active-request bound still apply. */
export const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;
export const SCRIPT_RESPONSE_BYTES = 32 * 1024 * 1024;
export const AGGREGATE_RELAY_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Count every non-final read, including empty chunks; payload accounting alone
 * would leave chunk object overhead and empty-read work unbounded. This is not
 * a total-heap limit: transport queues and final coalescing also allocate. */
export const RELAY_RESPONSE_CHUNK_LIMIT = 8192;
export function resourceResponseBudget(destination?: string): number {
  return destination === "script"
    ? SCRIPT_RESPONSE_BYTES
    : DEFAULT_RESPONSE_BYTES;
}
