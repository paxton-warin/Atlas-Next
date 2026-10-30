import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";

export const SIDEBAR_HOVER_DELAY = 250;
export const SIDEBAR_LEAVE_DELAY = 250;

/** One cancellable intent timer, not a mousemove listener or a polling loop. */
export function sidebarHoverIntent(
  show: (open: boolean) => void,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  return {
    enter() { clear(); timer = schedule(() => { timer = undefined; show(true); }, SIDEBAR_HOVER_DELAY); },
    leave() { clear(); timer = schedule(() => { timer = undefined; show(false); }, SIDEBAR_LEAVE_DELAY); },
    cancel: clear,
    close() { clear(); show(false); },
  };
}

function useMedia(query: string) {
  const [matches, set] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query), change = () => set(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [query]);
  return matches;
}

export function useSidebarPeek(enabled: boolean) {
  const fineHover = useMedia("(min-width: 600px) and (hover: hover) and (pointer: fine)");
  const compactViewport = useMedia("(min-width: 600px) and (max-height: 760px), (min-width: 600px) and (max-width: 1200px)");
  const [open, show] = useState(false);
  const header = useRef<HTMLElement>(null);
  const ignoreFocus = useRef(false);
  const intent = useRef<ReturnType<typeof sidebarHoverIntent> | null>(null);
  if (!intent.current) intent.current = sidebarHoverIntent(show);
  const allowed = enabled && fineHover;
  useEffect(() => {
    if (!allowed) intent.current!.close();
    return () => intent.current!.cancel();
  }, [allowed]);
  useEffect(() => {
    const close = () => intent.current!.close();
    const hidden = () => { if (document.hidden) close(); };
    window.addEventListener("blur", close);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", close); document.removeEventListener("visibilitychange", hidden); intent.current!.cancel(); };
  }, []);
  return {
    header, open: allowed && open, compactViewport,
    events: {
      onPointerEnter(event: PointerEvent<HTMLElement>) {
        if (allowed && event.pointerType !== "touch") intent.current!.enter();
      },
      onPointerLeave() {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && header.current?.contains(focused) && focused.matches(":focus-visible")) return;
        intent.current!.leave();
      },
      onFocusCapture(event: FocusEvent<HTMLElement>) {
        if (ignoreFocus.current) { ignoreFocus.current = false; return; }
        if (allowed && header.current?.contains(event.target) && event.target.matches(":focus-visible")) {
          intent.current!.cancel(); show(true);
        }
      },
      onBlurCapture(event: FocusEvent<HTMLElement>) {
        if (!header.current?.contains(event.relatedTarget as Node | null)) intent.current!.leave();
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.key !== "Escape" || !open || !header.current?.contains(event.target as Node)) return;
        event.preventDefault(); intent.current!.close();
        const toggle = header.current.querySelector<HTMLButtonElement>(".sidebar-toggle");
        if (toggle && document.activeElement !== toggle) { ignoreFocus.current = true; toggle.focus({ preventScroll: true }); }
      },
    },
  };
}
