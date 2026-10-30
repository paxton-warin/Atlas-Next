import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export function anchoredPopover(
  rect: Pick<DOMRect, "left" | "top" | "bottom">,
  viewport: { width: number; height: number },
  preferredWidth = 360,
): CSSProperties {
  const margin = 12, gap = 10;
  const width = Math.min(preferredWidth, viewport.width - margin * 2);
  const left = Math.max(margin, Math.min(rect.left, viewport.width - width - margin));
  return rect.top > viewport.height / 2
    ? { width, left, right: "auto", top: "auto", bottom: Math.max(margin, viewport.height - rect.top + gap), maxHeight: Math.max(120, rect.top - margin - gap) }
    : { width, left, right: "auto", bottom: "auto", top: Math.max(margin, rect.bottom + gap), maxHeight: Math.max(120, viewport.height - rect.bottom - margin - gap) };
}

/** Geometry only; a menu never changes a session, site owner or read cursor. */
export function useAnchoredPopover(open: boolean, trigger: RefObject<HTMLElement | null>): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (trigger.current) setStyle(anchoredPopover(trigger.current.getBoundingClientRect(), { width: innerWidth, height: innerHeight }));
    };
    update();
    addEventListener("resize", update);
    addEventListener("scroll", update, true);
    return () => {
      removeEventListener("resize", update);
      removeEventListener("scroll", update, true);
    };
  }, [open, trigger]);
  return style;
}
