type KeyboardLock = {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
};

/** Keyboard Lock must be requested by the top-level document, not a game iframe.
 * Leave key events untouched so the focused game receives real, trusted input.
 * Native hold-Escape / fullscreen exit controls remain owned by the browser.
 */
export function attachFullscreenKeyboard(
  doc: Document,
  nav: Navigator & { keyboard?: KeyboardLock },
  ownsFullscreen: () => boolean,
  report: (state: "locked" | "unavailable" | "denied") => void,
) {
  const keyboard = nav.keyboard;
  let owned = false;
  let requested = false;
  let generation = 0;
  function release() {
    if (!requested) return;
    requested = false;
    keyboard!.unlock();
  }
  function changed() {
    const next = !!doc.fullscreenElement && ownsFullscreen();
    if (next === owned) return;
    owned = next;
    const attempt = ++generation;
    if (!owned) {
      release();
      return;
    }
    if (!keyboard?.lock || !keyboard?.unlock) {
      report("unavailable");
      return;
    }
    requested = true;
    // Invoke immediately on fullscreenchange; no timer or permission preflight.
    // Exit cancels outstanding requests via unlock; stale promises never retry.
    try {
      Promise.resolve(keyboard.lock(["Escape"])).then(
        () => {
          if (attempt === generation) report("locked");
        },
        () => {
          if (attempt === generation) {
            release();
            report("denied");
          }
        },
      );
    } catch {
      release();
      report("denied");
    }
  }
  doc.addEventListener("fullscreenchange", changed);
  changed();
  return () => {
    ++generation;
    doc.removeEventListener("fullscreenchange", changed);
    release();
  };
}
