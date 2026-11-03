import type { ReactNode } from "react";
import "./entry-v21.css";
import { useEntryCopy } from "./use-entry-copy";
import { AtlasBrandMark } from "./AtlasBrandMark";
/** Consistent card throughout checking, verification, authorization and transfer. */
export function HubEntry({ stage = "Checking your Atlas session…", title = "Opening Atlas", busy = true, children }: { stage?: string; title?: string; busy?: boolean; children?: ReactNode }) {
  const copyVisible = useEntryCopy(busy);
  return <main className="auth-shell hub-entry" aria-busy={busy}>
    <section className="card hub-entry-card entry-card" data-entry-card data-entry-react aria-labelledby={copyVisible ? "hub-entry-title" : undefined}>
      <div className="brand"><AtlasBrandMark /><strong>Atlas</strong></div>
      <div className="hub-entry-copy" style={{ visibility: copyVisible ? undefined : "hidden" }} aria-hidden={!copyVisible || undefined}><h1 id="hub-entry-title">{title}</h1><p className="entry-stage" role={copyVisible ? "status" : undefined} aria-live={copyVisible ? "polite" : undefined}>{busy && <span className="entry-spinner" aria-hidden="true" />}<span>{stage}</span></p></div>
      <div className="hub-entry-actions">{children}</div>
    </section>
  </main>;
}
