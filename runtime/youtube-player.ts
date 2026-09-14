// Player-side completion for ads missed by response filtering. The SSAP/AD
// diagnostic and player progress API are used by maintained uAssets rules:
// https://github.com/uBlockOrigin/uAssets/blob/master/filters/quick-fixes.txt
// Never seek a video's raw media element or change its speed, volume, or mute.
const SKIP_BUTTONS = [
  ".ytp-skip-ad-button",
  ".ytp-skip-ad-button-modern",
  ".ytp-ad-skip-button",
  ".ytp-ad-skip-button-modern",
].join(",");
const installed = new WeakMap<Document, () => void>();

export function youtubeAdSeekTarget(
  stats: unknown,
  progress: unknown,
): number | undefined {
  const s = stats as { debug_info?: unknown } | null;
  const p = progress as { current?: unknown; duration?: unknown } | null;
  if (
    typeof s?.debug_info !== "string" ||
    !/^SSAP,\s*AD(?:[,\s]|$)/.test(s.debug_info)
  )
    return;
  if (
    typeof p?.current !== "number" ||
    typeof p.duration !== "number" ||
    !Number.isFinite(p.current) ||
    !Number.isFinite(p.duration)
  )
    return;
  if (
    p.current < 0 ||
    p.duration <= 0 ||
    p.duration > 600 ||
    p.duration - p.current < 0.25
  )
    return;
  return p.duration;
}

function youtubePage(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    return (
      /^https?:$/.test(url.protocol) &&
      ["youtube.com", "youtube-nocookie.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      )
    );
  } catch {
    return false;
  }
}

export function installYouTubePlayerAdHandling(
  win: Window & typeof globalThis,
  pageUrl: () => string,
  enabled: () => boolean,
): () => void {
  const doc = win.document;
  const previous = installed.get(doc);
  if (previous) return previous;
  if (!youtubePage(pageUrl())) return () => {};
  let stopped = false;
  let pending: number | undefined;
  let poll: number | undefined;
  let observer: MutationObserver | undefined;
  const clicks = new WeakMap<HTMLElement, number>();
  const seeks = new WeakMap<Element, string>();

  function visible(button: HTMLElement) {
    if (
      button.matches(":disabled, [disabled], [aria-disabled='true']") ||
      button.closest("[hidden], [inert], [aria-hidden='true']")
    )
      return false;
    const style = win.getComputedStyle(button);
    if (
      style.display === "none" ||
      style.visibility !== "visible" ||
      style.pointerEvents === "none" ||
      Number(style.opacity) === 0
    )
      return false;
    const box = button.getBoundingClientRect();
    return (
      box.width > 0 && box.height > 0 && button.getClientRects().length > 0
    );
  }
  function tick() {
    pending = undefined;
    if (stopped) return;
    try {
      if (!enabled() || !youtubePage(pageUrl())) return;
      for (const element of Array.from(
        doc.querySelectorAll<HTMLElement>("#movie_player, .html5-video-player"),
      )) {
        if (
          !element.classList.contains("ad-showing") &&
          !element.classList.contains("ad-interrupting")
        ) {
          seeks.delete(element);
          continue;
        }
        // An official ready skip control is preferable to touching progress.
        // No generic text-based button match, hidden countdown, or ad click URL.
        let readyButton = false;
        for (const button of Array.from(
          element.querySelectorAll<HTMLElement>(SKIP_BUTTONS),
        )) {
          if (!visible(button)) continue;
          readyButton = true;
          const now = Date.now();
          if (now - (clicks.get(button) ?? 0) >= 1000) {
            clicks.set(button, now);
            button.click();
          }
          break;
        }
        if (readyButton) continue;
        const player = element as HTMLElement & {
          getStatsForNerds?: () => unknown;
          getProgressState?: () => unknown;
          seekTo?: (time: number) => void;
        };
        if (
          typeof player.getStatsForNerds !== "function" ||
          typeof player.getProgressState !== "function" ||
          typeof player.seekTo !== "function"
        )
          continue;
        const target = youtubeAdSeekTarget(
          player.getStatsForNerds(),
          player.getProgressState(),
        );
        if (target === undefined) {
          seeks.delete(element);
          continue;
        }
        const video = element.querySelector("video");
        const signature = `${video?.currentSrc || video?.getAttribute("src") || ""}|${target}`;
        if (seeks.get(element) === signature) continue;
        seeks.set(element, signature);
        player.seekTo(target);
      }
    } catch {
      // A changing/unsupported player API must not break page scripts.
    }
  }
  function schedule() {
    if (!stopped && pending === undefined) pending = win.setTimeout(tick, 150);
  }
  function suspend() {
    observer?.disconnect();
    if (pending !== undefined) win.clearTimeout(pending);
    if (poll !== undefined) win.clearInterval(poll);
    pending = poll = undefined;
  }
  function resume() {
    if (stopped) return;
    suspend();
    observer ??= new win.MutationObserver(schedule);
    observer.observe(doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "disabled",
        "aria-disabled",
      ],
    });
    poll = win.setInterval(schedule, 1000);
    schedule();
  }
  function dispose() {
    if (stopped) return;
    stopped = true;
    suspend();
    win.removeEventListener("pagehide", suspend);
    win.removeEventListener("pageshow", resume);
    win.removeEventListener("unload", dispose);
    installed.delete(doc);
  }
  installed.set(doc, dispose);
  win.addEventListener("pagehide", suspend);
  win.addEventListener("pageshow", resume);
  win.addEventListener("unload", dispose, { once: true });
  resume();
  return dispose;
}
