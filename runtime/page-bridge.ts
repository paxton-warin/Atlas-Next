import { isSearchShortcut } from "./browser-shortcuts";

type Popup = {
  window: Window;
  name: string;
  submit: (form: HTMLFormElement, submitter?: HTMLElement | null) => void;
};
type BridgeOptions = {
  pageUrl: () => string;
  topName: string;
  focusSearch: () => void;
  open: (url: string, name: string, opener: Window, noOpener: boolean) => Popup;
};
const getAttribute = Element.prototype.getAttribute;
const setAttribute = Element.prototype.setAttribute;
const removeAttribute = Element.prototype.removeAttribute;

// Install per document through the engine's initialization hook, before page scripts.
// Keep real browsing contexts: OAuth callers retain Window/opener/postMessage semantics.
export function installPageBridge(
  win: Window & typeof globalThis,
  options: BridgeOptions,
) {
  // WindowProxy survives a navigation, so use the document as the lifecycle key below.
  if (installedDocuments.has(win.document)) return;
  installedDocuments.add(win.document);
  const doc = win.document;
  const nativeOpen = win.open;
  const resolve = (value: string) =>
    new URL(value || "about:blank", options.pageUrl()).href;
  const externalTarget = (name: string) =>
    name === "_blank" ||
    (!!name &&
      !["_self", "_top", "_parent", options.topName].includes(name) &&
      !(name in win.frames));
  win.open = function (url?: string | URL, target = "_blank", features = "") {
    target = String(target || "_blank");
    if (!externalTarget(target))
      return nativeOpen.call(win, url, target, features);
    const href = resolve(String(url ?? ""));
    if (!/^https?:|^about:blank$/.test(href))
      return nativeOpen.call(win, url, target, features);
    const noOpener =
      /(?:^|,)\s*(?:noopener|noreferrer)(?:\s*=\s*(?:1|yes|true))?\s*(?:,|$)/i.test(
        features,
      );
    const popup = options.open(href, target, win, noOpener);
    return noOpener ? null : popup.window;
  };
  // A native GET/POST submission must retain its body, submitter and encoding.
  // Only change its browsing-context destination, never synthesize a GET redirect.
  function prepareForm(form: HTMLFormElement, submitter?: HTMLElement | null) {
    const submitTarget =
      submitter && getAttribute.call(submitter, "formtarget");
    const target =
      submitTarget ??
      getAttribute.call(form, "target") ??
      doc.querySelector("base[target]")?.getAttribute("target") ??
      "";
    if (!externalTarget(target) && !["_top", "_parent"].includes(target))
      return { restore() {}, submit: undefined as (() => void) | undefined };
    const holder =
      submitTarget !== null && submitTarget !== undefined ? submitter! : form;
    const targetAttr = holder === form ? "target" : "formtarget";
    const previousTarget = getAttribute.call(holder, targetAttr);
    if (externalTarget(target)) {
      const popup = options.open("about:blank", target, win, false);
      // Sandboxed sibling frames are not native form targets. The owning runtime
      // submits the same successful controls into its child, preserving POST/files.
      return { restore() {}, submit: () => popup.submit(form, submitter) };
    } else {
      // The root of the proxied site is an Atlas tab, not the outer application.
      setAttribute.call(
        holder,
        targetAttr,
        target === "_parent" && win.parent !== win && win.parent.name
          ? win.parent.name
          : options.topName,
      );
    }
    return {
      submit: undefined as (() => void) | undefined,
      restore() {
        previousTarget === null
          ? removeAttribute.call(holder, targetAttr)
          : setAttribute.call(holder, targetAttr, previousTarget);
      },
    };
  }
  const submit = win.HTMLFormElement.prototype.submit;
  win.HTMLFormElement.prototype.submit = function () {
    const route = prepareForm(this);
    try {
      if (route.submit) return route.submit();
      return submit.call(this);
    } finally {
      route.restore();
    }
  };
  win.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    const route = prepareForm(
      event.target as HTMLFormElement,
      (event as SubmitEvent).submitter,
    );
    if (route.submit) {
      event.preventDefault();
      route.submit();
    }
    // Default navigation runs after event dispatch; restore on the next task.
    win.setTimeout(route.restore, 0);
  });
  win.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.(
      "a[href]",
    ) as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute("download")) return;
    const target =
      anchor.target ||
      doc.querySelector("base[target]")?.getAttribute("target") ||
      "";
    if (!externalTarget(target) && !event.ctrlKey && !event.metaKey) return;
    const href = resolve(anchor.href);
    if (!/^https?:/.test(href)) return;
    event.preventDefault();
    options.open(
      href,
      target || "_blank",
      win,
      !anchor.relList.contains("opener"),
    );
  });
  win.addEventListener(
    "keydown",
    (event) => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        options.focusSearch();
      }
    },
    true,
  );
  // Google's search box is a textarea: before its JS initializes, Enter inserts
  // a newline rather than submitting. Leave working handlers, IME and Shift+Enter alone.
  win.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const input = event.target as HTMLTextAreaElement | null;
    if (input?.tagName !== "TEXTAREA" || input.name !== "q" || !input.form)
      return;
    const url = new URL(options.pageUrl());
    const action = new URL(input.form.action || url.href, url);
    if (
      !/^(?:www\.)?google\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/i.test(
        url.hostname,
      ) ||
      action.origin !== url.origin ||
      action.pathname !== "/search"
    )
      return;
    event.preventDefault();
    input.form.requestSubmit();
  });
}
const installedDocuments = new WeakSet<Document>();
