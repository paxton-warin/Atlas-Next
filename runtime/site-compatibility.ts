import { ruleFor, type CompatibilityStatus } from "./compatibility-policy.ts";
export type DocumentGuard = {
  update: (enabled?: boolean) => void;
  title: () => string;
  dispose: () => void;
};
const guards = new WeakMap<Document, DocumentGuard>();
// Narrow presentation-only adjustments. No executable code/body text is rewritten.
export function installDocumentGuard(
  win: Window & typeof globalThis,
  options: {
    id: string;
    pageUrl: () => string;
    enabled: () => boolean;
    fixture?: boolean;
    /** Metadata-only opaque runtime does not resume body/category detection. */
    sampleRisk?: boolean;
    report: (value: CompatibilityStatus) => void;
    onTitle?: (title: string) => void;
  },
): DocumentGuard {
  const doc = win.document;
  const existing = guards.get(doc);
  if (existing) return existing;
  let originalTitle = doc.title;
  let titleApplied = false;
  let enabled = options.enabled();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let riskTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReport = "";
  let lastTitle = "";
  let work = 0,
    workStart = Date.now(),
    throttled = false;
  const values = new Map<Element, { before: string; after: string }>();
  const metadata =
    'meta[name="description"],meta[property="og:title"],meta[property="og:description"],meta[name="twitter:title"],meta[name="twitter:description"]';
  function restore() {
    if (titleApplied && doc.title === "Website") doc.title = originalTitle;
    else if (doc.title !== "Website") originalTitle = doc.title;
    titleApplied = false;
    for (const [element, value] of values)
      if (
        element.isConnected &&
        element.getAttribute("content") === value.after
      )
        element.setAttribute("content", value.before);
    values.clear();
  }
  function apply() {
    if (disposed || doc.readyState === "loading") return;
    const url = new URL(options.pageUrl());
    const rule = ruleFor(url.href, options.fixture);
    let risk = false;
    // Counts only; do not send website text or pixels to the frontend.
    let sample = "";
    if (options.sampleRisk !== false && doc.body) {
      const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT);
      for (let n = 0; n < 256 && sample.length < 8192; n++) {
        const node = walker.nextNode();
        if (!node) break;
        if (!["SCRIPT", "STYLE"].includes(node.parentElement?.tagName || ""))
          sample +=
            (node.textContent || "").slice(0, 8192 - sample.length) + " ";
      }
    }
    risk =
      options.sampleRisk !== false &&
      (/\b(gameplay|play game|game controls|game instructions)\b/i.test(
        sample,
      ) ||
        !!doc.querySelector("canvas"));
    if (enabled && rule) {
      if (doc.title !== "Website") originalTitle = doc.title;
      if (!titleApplied && doc.title === "Website") originalTitle = "Website";
      titleApplied = true;
      if (doc.title !== "Website") doc.title = "Website";
      const elements: Element[] = [];
      if (doc.head) {
        const walker = doc.createTreeWalker(
          doc.head,
          win.NodeFilter.SHOW_ELEMENT,
        );
        for (let n = 0; n < 256 && elements.length < 64; n++) {
          const element = walker.nextNode() as Element | null;
          if (!element) break;
          if (element.matches(metadata)) elements.push(element);
        }
      }
      for (const element of elements) {
        const current = element.getAttribute("content");
        if (current === null) continue;
        const previous = values.get(element);
        if (!previous || current !== previous.after)
          values.set(element, { before: current, after: "" });
        if (current !== "") element.setAttribute("content", "");
      }
      for (const element of values.keys())
        if (!element.isConnected) values.delete(element);
    } else restore();
    const displayTitle = titleApplied ? originalTitle : doc.title;
    if (displayTitle !== lastTitle) {
      lastTitle = displayTitle;
      options.onTitle?.(displayTitle.slice(0, 160));
    }
    const report: CompatibilityStatus = {
      id: options.id,
      origin: url.origin,
      rule: rule || "runtime-only-v1",
      applied: titleApplied ? 1 + values.size : 0,
      risk,
      throttled,
    };
    const signature = JSON.stringify(report);
    if (signature !== lastReport) {
      lastReport = signature;
      options.report(report);
    }
  }
  const observer = new win.MutationObserver(() => {
    if (disposed || timer) return;
    const now = Date.now();
    if (now - workStart > 1000) {
      workStart = now;
      work = 0;
    }
    if (++work > 8) {
      throttled = true;
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      observer.disconnect();
      apply();
      observe();
    }, 125);
  });
  function observe() {
    if (!disposed && (doc.head || doc.documentElement))
      observer.observe(doc.head || doc.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["content", "name", "property"],
      });
  }
  const ready = () => {
    observer.disconnect();
    apply();
    observe();
  };
  const guard: DocumentGuard = {
    update(next = options.enabled()) {
      enabled = next;
      ready();
    },
    title: () =>
      titleApplied && doc.title === "Website" ? originalTitle : doc.title,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(riskTimer);
      doc.removeEventListener("DOMContentLoaded", ready);
      win.removeEventListener("pagehide", hide);
      restore();
      guards.delete(doc);
    },
  };
  function hide(event: PageTransitionEvent) {
    if (!event.persisted) guard.dispose();
  }
  guards.set(doc, guard);
  ready();
  doc.addEventListener("DOMContentLoaded", ready, { once: true });
  // One delayed classification sample, not a full-body mutation observer.
  riskTimer = setTimeout(ready, 1000);
  win.addEventListener("pagehide", hide);
  return guard;
}
export function originalDocumentTitle(doc: Document): string {
  return guards.get(doc)?.title() ?? doc.title;
}
