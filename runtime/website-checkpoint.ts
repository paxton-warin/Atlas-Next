/** Native checkpoints are explicit site-owned save operations, not JavaScript
 * execution transfer. Unknown sites only export their already committed data.
 * This adapter never finds a frame by name or searches website descendants. */
export type ProfileCheckpointCandidate = {
  origin: string;
  visible: boolean;
  lastActiveAt: number;
  checkpoint(): Promise<void>;
};
export type ProfileCheckpointRequest = {
  siteGroup: string;
  candidates: ProfileCheckpointCandidate[];
};
export type WebsiteCheckpointResult = { supported: boolean };
const fail = (code: string) => Object.assign(new Error(code), { code });

function officialCookieClicker(url: URL) {
  return url.protocol === "https:" && url.hostname === "orteil.dashnet.org" &&
    !url.port && !url.username && !url.password && url.pathname === "/cookieclicker/";
}

/** Match the game's actual utf8_to_b64 + escape format using trusted intrinsic
 * functions, rather than trusting its save method's return or export mode. */
export function cookieClickerStoredSave(raw: string): string {
  return escape(btoa(unescape(encodeURIComponent(raw))) + "!END!");
}

export function checkpointWebsiteRoot(
  input: {
    root: Window & typeof globalThis;
    website: string;
    expectedOrigin: string;
  },
): WebsiteCheckpointResult {
  const url = new URL(input.website);
  if (url.origin !== input.expectedOrigin) throw fail("PROFILE_CHECKPOINT_ORIGIN_CHANGED");
  if (!officialCookieClicker(url)) return { supported: false };
  const root = input.root as typeof input.root & { Game?: any };
  const game = root.Game;
  if (!game || !game.ready || typeof game.WriteSave !== "function" ||
      game.WriteSave.constructor?.name === "AsyncFunction" ||
      game.SaveTo !== "CookieClickerGame" || !game.useLocalStorage)
    throw fail("PROFILE_CHECKPOINT_NOT_READY");
  // Match the native Logic save gate. An initialized page can still have a
  // minigame loading, in which case serializing now would omit its live data.
  if (game.OnAscend || game.isSaving || !game.Objects || typeof game.Objects !== "object")
    throw fail("PROFILE_CHECKPOINT_SAVE_BUSY");
  for (const key in game.Objects) {
    if (game.Objects[key]?.minigameLoading) throw fail("PROFILE_CHECKPOINT_SAVE_BUSY");
  }
  const storage = root.localStorage;
  // Default mode synchronously calls the game's actual persistence operation.
  // Modes 1/2/3 only export strings and must never be used as proof of saving.
  const result = game.WriteSave();
  if (result && typeof result.then === "function") throw fail("PROFILE_CHECKPOINT_ASYNC_UNSUPPORTED");
  if (root.Game !== game || game.SaveTo !== "CookieClickerGame" ||
      typeof game.lastSaveData !== "string" || !game.lastSaveData.length)
    throw fail("PROFILE_CHECKPOINT_SAVE_UNVERIFIED");
  const expected = cookieClickerStoredSave(game.lastSaveData);
  // The native localStorageSet wrapper swallows exceptions. A stale nonempty
  // key and a freshly assigned lastSaveData therefore do NOT prove success.
  if (storage.getItem("CookieClickerGame") !== expected)
    throw fail("PROFILE_CHECKPOINT_SAVE_FAILED");
  return { supported: true };
}

/** Validate the controller-owned physical root again at command execution.
 * Website window.name/rewritten parent/top getters never establish identity. */
export function checkpointControllerRoot(
  record: {
    element: { contentWindow: Window | null };
    checkpointRoot?: {
      window: Window & typeof globalThis;
      document: Document;
      logicalURL(): string;
    };
  } | undefined,
  expectedOrigin: string,
): WebsiteCheckpointResult {
  const root = record?.checkpointRoot;
  if (!root || record!.element.contentWindow !== root.window ||
      root.window.document !== root.document)
    throw fail("PROFILE_CHECKPOINT_DOCUMENT_CHANGED");
  return checkpointWebsiteRoot({ root: root.window, website: root.logicalURL(), expectedOrigin });
}

export function checkpointElementVisible(element: HTMLElement): boolean {
  if (element.isConnected === false) return false;
  const view = element.ownerDocument?.defaultView;
  const style = view?.getComputedStyle?.(element);
  if (style?.visibility === "hidden" || style?.display === "none") return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.style?.display === "none" || node.style?.visibility === "hidden") return false;
  }
  // getClientRects also catches stylesheet-hidden ancestors without forcing an
  // arbitrary fixed size, and is queried only on an explicit handoff request.
  return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
}
