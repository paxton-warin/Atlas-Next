import { createHash } from "node:crypto";

// The corresponding upstream archive remains unchanged. Apply this small,
// source-distributed adaptation only to its exact qualified transport artifact.
export const HTTP_ENGINE_UPSTREAM_SHA256 =
  "f2a17fa85d71f8a82990650dcf16ba952a86cb90dec1acb1c07413f11d0a94e4";
export const HTTP_ENGINE_ROTATION_SHA256 =
  "6623320777867c8c86b93a3da9c4e02f445537d4844e2db41313b8cbea263bd8";
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function adaptRelayCredentialRotation(bytes) {
  if (hash(bytes) !== HTTP_ENGINE_UPSTREAM_SHA256)
    throw Error("Relay rotation requires the qualified HTTP engine artifact.");
  let source = bytes.toString();
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw Error("HTTP engine relay adaptation anchor changed.");
    source = source.replace(before, after);
  };
  replace(
    `    on_conn_close() {
      delete _relay_connections[this.real_url];
    }`,
    `    on_conn_close() {
      // Credential rotation can move this connection to a newer ticket key.
      // Remove only this exact closed connection, never a replacement socket.
      for (const [key, connection] of Object.entries(_relay_connections)) {
        if (connection === this.connection) delete _relay_connections[key];
      }
    }`,
  );
  replace(
    `    this.session = new httpengine.HTTPSession({
      proxy: this.proxy
    });`,
    `    // Repeated initialization must not leak a native curl session/pool.
    this.session ??= new httpengine.HTTPSession({
      proxy: this.proxy
    });`,
  );
  replace(
    `  ready = false;
  async meta() {`,
    `  // Renewable leases authorize established sockets independently of the
  // short-lived upgrade ticket. Reuse that live multiplexed connection while
  // future reconnects use the newest ticket, without replacing curl sessions.
  updateRelay(relay) {
    if (typeof relay !== "string" ||
        !/^wss?:\\/\\//.test(relay) || !relay.endsWith("/")) {
      throw new TypeError("Invalid relay credential URL.");
    }
    const connections = httpengine.relay.relay_connections;
    const current = connections[this.relay];
    const next = connections[relay];
    if (current && (current.connected || current.connecting) &&
        (!next || next === current || (!next.connected && !next.connecting))) {
      if (this.relay !== relay) delete connections[this.relay];
      connections[relay] = current;
    }
    httpengine.set_websocket(relay);
    this.relay = relay;
  }
  ready = false;
  async meta() {`,
  );
  const result = Buffer.from(source);
  if (hash(result) !== HTTP_ENGINE_ROTATION_SHA256)
    throw Error("Adapted HTTP engine hash differs from the qualified artifact.");
  return result;
}
