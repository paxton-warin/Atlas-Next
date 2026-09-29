import {
  createDirectTabUrl,
  directTabTarget,
} from "../../runtime/direct-tab.ts";

export type PopoutLaunch = {
  target: string;
  session?: string;
  youtubeAdblock: boolean;
};

function validSession(session: string | undefined) {
  if (
    session !== undefined &&
    (!/^[A-Za-z0-9_-]+$/.test(session) || session.length > 4096)
  )
    throw Error(
      "Invalid browsing session. Return to Atlas and open this page again.",
    );
}

/** Same frontend top-level site, same runtime storage partition. No node URL
 * or transport ticket is accepted from the caller: the API resolves the lease. */
export function createPopoutUrl(
  frontendOrigin: string,
  target: string,
  session?: string,
  youtubeAdblock = true,
): string {
  validSession(session);
  const result = new URL(
    createDirectTabUrl(frontendOrigin, target, undefined, youtubeAdblock),
  );
  result.pathname = "/popout";
  const fragment = new URLSearchParams(result.hash.slice(1));
  if (session) fragment.set("session", session);
  result.hash = fragment.toString();
  return result.href;
}

export function parsePopoutLaunch(href = location.href): PopoutLaunch {
  const url = new URL(href);
  const params = new URLSearchParams(url.hash.slice(1));
  const target = directTabTarget(params);
  if (!target) throw Error("No website selected. Open a popout from Atlas.");
  const session = params.has("session") ? params.get("session")! : undefined;
  const youtubeAdblock = params.get("adblock") !== "0";
  // Reuse strict web-origin/target validation and reject malformed handoffs.
  createPopoutUrl(url.origin, target, session, youtubeAdblock);
  return { target: new URL(target).href, session, youtubeAdblock };
}
