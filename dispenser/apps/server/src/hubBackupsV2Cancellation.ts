/** PostgreSQL CancelRequest, not a second authenticated SQL/pool connection.
 * Never log backend PID/key/address. SQL's2s deadline remains the failure fallback. */
import { createConnection } from "node:net";
import type { PoolClient } from "pg";
export function cancelBackupStatement(
  client: PoolClient,
  timeoutMs = 200,
): Promise<boolean> {
  const wire = client as PoolClient & {
    host?: string;
    port?: number;
    processID?: number;
    secretKey?: number;
  };
  if (
    typeof wire.host !== "string" ||
    !Number.isInteger(wire.port) ||
    !Number.isInteger(wire.processID) ||
    !Number.isInteger(wire.secretKey) ||
    wire.port! < 1 ||
    wire.port! > 65535 ||
    wire.processID! < 1 ||
    wire.processID! > 2147483647 ||
    wire.secretKey! < -2147483648 ||
    wire.secretKey! > 2147483647
  )
    return Promise.resolve(false);
  const packet = Buffer.alloc(16);
  packet.writeInt32BE(16, 0);
  packet.writeInt16BE(1234, 4);
  packet.writeInt16BE(5678, 6);
  packet.writeInt32BE(wire.processID!, 8);
  packet.writeInt32BE(wire.secretKey!, 12);
  return new Promise((resolve) => {
    let settled = false,
      sent = false;
    const socket = wire.host!.startsWith("/")
      ? createConnection({ path: wire.host + "/.s.PGSQL." + wire.port })
      : createConnection({ host: wire.host, port: wire.port });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      socket.end(packet, () => {
        sent = true;
      });
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(sent));
    socket.once("end", () => finish(sent));
  });
}
