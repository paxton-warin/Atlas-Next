import { useEffect, useRef, type RefObject } from "react";

/** Focus behavior for the existing inline dialogs, without changing their controllers. */
export function useV21ModalFocus<T extends HTMLElement>(
  open: boolean,
  ref: RefObject<T | null>,
  dismiss: () => void,
  initialSelector = "button",
) {
  const close = useRef(dismiss);
  close.current = dismiss;
  useEffect(() => {
    const panel = ref.current;
    if (!open || !panel) return;
    const prior = document.activeElement as HTMLElement | null;
    const items = () =>
      [...panel.querySelectorAll<HTMLElement>(
        "a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])",
      )].filter((el) => el.getClientRects().length && !el.closest("[hidden],[inert]"));
    const focusFirst = () =>
      (panel.querySelector<HTMLElement>(initialSelector) || items()[0] || panel).focus();
    focusFirst();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === "Tab") {
        const controls = items();
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (!controls.length || (event.shiftKey ? index <= 0 : index < 0 || index === controls.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
    };
    const contain = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) focusFirst();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("focusin", contain);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", contain);
      if (prior?.isConnected) prior.focus();
    };
  }, [open, ref, initialSelector]);
}
