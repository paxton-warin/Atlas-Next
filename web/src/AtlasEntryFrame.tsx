import type { ReactNode } from "react";
import "./entry-v21.css";
import { ShieldAlert } from "lucide-react";
import { useEntryCopy } from "./use-entry-copy";
/** One stable presentation for checking, handoff, hydration and bundle loading. */
export function AtlasEntryFrame({ title = "Opening Atlas", message = "Opening your browser…", pending = true, error = "", children }: { title?: string; message?: string; pending?: boolean; error?: string; children?: ReactNode }) {
  const copyVisible = useEntryCopy(pending && !error);
  return (
    <main className="hub-gate" aria-busy={pending}>
      <section className="entry-card" data-entry-card data-entry-react aria-labelledby={copyVisible ? "hub-gate-title" : undefined}>
        <header className="hub-gate-brand"><span className="hub-gate-mark" aria-hidden="true">A</span><span>Atlas</span></header>
        <div className="hub-gate-copy" style={{ visibility: copyVisible ? undefined : "hidden" }} aria-hidden={!copyVisible || undefined}>
          <h1 id="hub-gate-title">{title}</h1>
          {!error && <p className="entry-stage" role={copyVisible ? "status" : undefined} aria-live={copyVisible ? "polite" : undefined}>{pending && <span className="entry-spinner" aria-hidden="true" />}<span>{message}</span></p>}
        </div>
        {error && <p className="hub-gate-error" role="alert"><ShieldAlert size={18} aria-hidden="true" />{error}</p>}
        <div className="hub-gate-actions">{children}</div>
      </section>
    </main>
  );
}
