import { useEffect, useState } from "react";
import { api } from "./model";

export type CcuSnapshot = {
  activeSessions: number;
  complete: boolean;
  reportingNodes: number;
  totalNodes: number;
  updatedAt: number;
  freshnessMs: number;
};

export function CcuSummary({
  snapshot,
  unavailable = false,
}: {
  snapshot: CcuSnapshot | null;
  unavailable?: boolean;
}) {
  const current = unavailable ? null : snapshot;
  return (
    <section className="setting-card ccu-summary" aria-label="CCU">
      <div className="ccu-heading">
        <h2>CCU</h2>
        <strong className="stat-value" aria-live="polite">
          {current
            ? `${current.complete ? "" : "≥ "}${current.activeSessions.toLocaleString()}`
            : "—"}
        </strong>
      </div>
      {(!current || !current.complete) && (
        <p className="small muted ccu-status" role="status">
          {unavailable
            ? "Unavailable"
            : !current
              ? "Loading…"
              : `${current.reportingNodes}/${current.totalNodes} nodes`}
        </p>
      )}
    </section>
  );
}

export function NodeCcuCount({
  node,
  unavailable = false,
}: {
  node: { online: boolean; activeSessions?: number | null };
  unavailable?: boolean;
}) {
  const known =
    !unavailable &&
    node.online &&
    Number.isSafeInteger(node.activeSessions) &&
    (node.activeSessions as number) >= 0;
  return (
    <p className="node-ccu">
      <strong>{known ? node.activeSessions!.toLocaleString() : "—"} CCU</strong>
      {!known && <span className="small muted"> · Unavailable</span>}
    </p>
  );
}

export default function AdminCcuMetrics({ csrf }: { csrf: string }) {
  const [snapshot, setSnapshot] = useState<CcuSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 10000);
      try {
        const result = await api<CcuSnapshot>("/admin/ccu", {
          signal: request.signal,
          headers: { "x-atlas-csrf": csrf },
        });
        if (controller.signal.aborted) return;
        setSnapshot(result);
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [csrf]);
  return <CcuSummary snapshot={snapshot} unavailable={unavailable} />;
}
