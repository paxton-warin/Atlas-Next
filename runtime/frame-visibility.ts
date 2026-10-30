/** A hidden Atlas tab is a hidden page, not a foreground page inside a hidden
 * div. Deliver the normal visibility signal without freezing scripts, changing
 * clocks, interrupting native media, or remounting the website. */
type Owner = Window & typeof globalThis;
function getter(object: object, key: string): ((this: any) => any) | undefined {
  for (let value: any = object; value; value = Object.getPrototypeOf(value)) {
    const found = Object.getOwnPropertyDescriptor(value, key)?.get;
    if (found) return found;
  }
}
export function createFrameVisibility(owner: Owner, container: HTMLElement, runtimeFrame: HTMLIFrameElement) {
  const nativeFrame = getter(owner, 'frameElement');
  const nativeHidden = getter(owner.document, 'hidden');
  const closest = owner.Element.prototype.closest;
  const bindings = new Map<Document, { update(): void; dispose(): void }>();
  let live = true;
  const visible = (win: Owner) => {
    if (!live || (nativeHidden?.call(owner.document) ?? owner.document.hidden) || closest.call(container, '[hidden]')) return false;
    try {
      let cursor = win;
      for (let depth = 0; cursor !== owner && depth < 32; depth++) {
        const element = nativeFrame?.call(cursor) as HTMLIFrameElement | null | undefined;
        if (!element) break;
        // Only Atlas/controller-owned visibility counts. An arbitrary site's
        // hidden descendant does not become a new browser-tab controller.
        if ((element.ownerDocument === owner.document || element.ownerDocument === runtimeFrame.contentDocument) && closest.call(element, '[hidden]')) return false;
        cursor = element.ownerDocument.defaultView as Owner;
      }
    } catch { return false; }
    return true;
  };
  const update = () => { for (const binding of bindings.values()) binding.update(); };
  const observer = new owner.MutationObserver(update);
  for (let element: Element | null = container; element; element = element.parentElement)
    observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
  owner.document.addEventListener('visibilitychange', update);
  return {
    install(win: Owner) {
      const doc = win.document;
      const found = bindings.get(doc); if (found) return { dispose() {} };
      const previousHidden = Object.getOwnPropertyDescriptor(doc, 'hidden');
      const previousState = Object.getOwnPropertyDescriptor(doc, 'visibilityState');
      let last = visible(win), attached = true;
      const hidden = () => !visible(win), state = () => visible(win) ? 'visible' : 'hidden';
      Object.defineProperties(doc, {
        hidden: { configurable: true, enumerable: true, get: hidden },
        visibilityState: { configurable: true, enumerable: true, get: state },
      });
      const childObserver = new owner.MutationObserver(update);
      const element = nativeFrame?.call(win) as HTMLIFrameElement | null | undefined;
      if (element && element.ownerDocument === runtimeFrame.contentDocument)
        childObserver.observe(element, { attributes: true, attributeFilter: ['hidden'] });
      const binding = {
        update() {
          if (!attached) return;
          const next = visible(win); if (next === last) return; last = next;
          doc.dispatchEvent(new win.Event('visibilitychange'));
        },
        dispose() {
          if (!attached) return; attached = false; childObserver.disconnect(); bindings.delete(doc);
          if (Object.getOwnPropertyDescriptor(doc, 'hidden')?.get === hidden) {
            if (previousHidden) Object.defineProperty(doc, 'hidden', previousHidden); else Reflect.deleteProperty(doc, 'hidden');
          }
          if (Object.getOwnPropertyDescriptor(doc, 'visibilityState')?.get === state) {
            if (previousState) Object.defineProperty(doc, 'visibilityState', previousState); else Reflect.deleteProperty(doc, 'visibilityState');
          }
        },
      };
      bindings.set(doc, binding); return binding;
    },
    dispose() { if (!live) return; observer.disconnect(); owner.document.removeEventListener('visibilitychange', update); for (const binding of [...bindings.values()]) binding.dispose(); live = false; },
  };
}
