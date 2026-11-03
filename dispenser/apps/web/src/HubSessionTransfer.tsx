import { useEffect, useRef, useState } from "react";
import { api, post } from "./api";
import { Notice } from "./ui";
import { HubEntry } from "./HubEntry";
/** The source-origin document enables existing Strict cookies only on same-origin fetches. */
export function HubSessionTransfer() {
  const [query] = useState(() => new URLSearchParams(location.search)),
    started = useRef(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const request = query.get("request");
    history.replaceState(null, "", location.pathname);
    void (async () => {
      if (!request)
        throw Error("This sign-in transfer expired. Continue to Hub.");
      const info = await api<{
        source: string;
        destination: string;
        returnTo: string;
      }>(
        "/hub/session-transfer/context?request=" + encodeURIComponent(request),
      );
      const source = location.pathname.endsWith("/source");
      const value = await post<{ redirect: string }>(
        source
          ? "/hub/session-transfer/authorize"
          : "/hub/session-transfer/exchange",
        source
          ? { request }
          : {
              request,
              code: query.get("code"),
              ...(query.get("failed") === "1" ? { failed: true } : {}),
            },
      );
      const next = new URL(value.redirect, location.origin);
      if (
        source
          ? next.origin !== info.destination
          : next.origin !== location.origin
      )
        throw Error("The Hub destination changed. Continue to Hub.");
      location.replace(next.href);
    })().catch((e) =>
      setError(e instanceof Error ? e.message : "Sign in to continue."),
    );
  }, [query]);
  return <HubEntry stage={error ? "Sign-in needs attention." : "Restoring your Hub session…"} busy={!error}>
    {error && <><Notice tone="danger">{error}</Notice><a className="button button--primary" href="/">Continue to Hub</a></>}
  </HubEntry>;
}

export const HUB_TRANSFER_SIGNED_OUT = "atlas.hub.session-transfer.signed-out";
export const HUB_TRANSFER_ATTEMPTS = "atlas.hub.session-transfer.attempts";
export function clearHubTransferSignOut() {
  localStorage.removeItem(HUB_TRANSFER_SIGNED_OUT);
  sessionStorage.removeItem(HUB_TRANSFER_ATTEMPTS);
}
export function HubSessionRestoring() {
  return <HubEntry stage="Restoring your Hub session…" />;
}
