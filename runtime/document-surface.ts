// A document-owned closed rendering tree keeps the original site nodes and
// strings. RuntimeKit's main-world traps expose those same nodes to site code;
// native document traversal does not flatten the rendering tree.
export type DocumentSurface = {
  update(enabled: boolean): void;
  dispose(): void;
};

export function installDocumentSurface(
  win: Window & typeof globalThis,
  client: any,
  initiallyEnabled: boolean,
): DocumentSurface {
  const doc = win.document;
  const bodyDescriptor = Object.getOwnPropertyDescriptor(
    win.Document.prototype,
    "body",
  )!;
  const query = win.Element.prototype.querySelector;
  const queryAll = win.Element.prototype.querySelectorAll;
  const docQuery = win.Document.prototype.querySelector;
  const docQueryAll = win.Document.prototype.querySelectorAll;
  const getId = win.Document.prototype.getElementById;
  const getTags = win.Document.prototype.getElementsByTagName;
  const getClasses = win.Document.prototype.getElementsByClassName;
  const elementTags = win.Element.prototype.getElementsByTagName;
  const elementClasses = win.Element.prototype.getElementsByClassName;
  const append = win.Node.prototype.appendChild;
  const remove = win.Node.prototype.removeChild;
  const insert = win.Node.prototype.insertBefore;
  const replace = win.Node.prototype.replaceChild;
  const parentDescriptor = Object.getOwnPropertyDescriptor(
    win.Node.prototype,
    "parentNode",
  )!;
  const childrenDescriptor = Object.getOwnPropertyDescriptor(
    win.Node.prototype,
    "childNodes",
  )!;
  const atomicMove = (win.Element.prototype as any).moveBefore;
  const addEvent = win.EventTarget.prototype.addEventListener;
  const removeEvent = win.EventTarget.prototype.removeEventListener;
  const contains = win.Node.prototype.contains;
  const rootNode = win.Node.prototype.getRootNode;
  let enabled = initiallyEnabled,
    disposed = false,
    moving = false;
  let nativeBody: HTMLBodyElement | null = null;
  let siteBody: HTMLBodyElement | null = null;
  let host: HTMLElement | null = null;
  let tree: ShadowRoot | null = null;
  let siteHtml: HTMLElement | null = null;
  let siteHead: HTMLHeadElement | null = null;
  // Keep URL-only presentation metadata on its original nodes, outside native
  // document traversal. Charset, viewport, base, scripts and CSS stay in place.
  const metadataSelector = 'link[rel="canonical"],meta[property="og:url"]';
  const metadata = new Map<Element, { parent: Node; anchor: Comment }>();
  const metadataAnchors = new Map<Comment, Element>();
  const sheets = new Map<Element, Element>();
  const names = new Map<
    string,
    { get: () => unknown; assigned: boolean; value: unknown }
  >();
  const delegated = new Set([
    "click",
    "dblclick",
    "mousedown",
    "mouseup",
    "mousemove",
    "pointerdown",
    "pointerup",
    "pointermove",
    "touchstart",
    "touchend",
    "touchmove",
    "keydown",
    "keyup",
    "input",
    "change",
    "submit",
    "focusin",
    "focusout",
  ]);
  type Listener = {
    type: string;
    listener: any;
    options: AddEventListenerOptions;
    callback: EventListener;
    target: EventTarget;
    abort?: EventListener;
  };
  const listeners: Listener[] = [];
  const dispatchTargets = new WeakMap<Event, EventTarget>();
  const actualBody = () =>
    bodyDescriptor.get!.call(doc) as HTMLBodyElement | null;
  function collection(target: any, read: () => any[]) {
    const proxy = new Proxy(target, {
      get(object, key) {
        const values = read();
        if (key === "length") return values.length;
        if (key === Symbol.iterator || key === "values")
          return values.values.bind(values);
        if (key === "keys") return values.keys.bind(values);
        if (key === "entries") return values.entries.bind(values);
        if (key === "forEach")
          return (fn: any, context?: any) =>
            values.forEach((value, index) =>
              fn.call(context, value, index, proxy),
            );
        if (key === "item") return (index: number) => values[index] || null;
        if (key === "namedItem")
          return (name: string) =>
            values.find(
              (node) =>
                node.id === name || node.getAttribute?.("name") === name,
            ) || null;
        if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key))
          return values[Number(key)];
        const value = Reflect.get(object, key, object);
        return typeof value === "function" && key !== "constructor"
          ? value.bind(object)
          : value;
      },
    });
    return proxy;
  }
  function preserveNamedElements(root: Element) {
    for (const element of Array.from(queryAll.call(root, "[id],[name]"))) {
      for (const key of [element.id, element.getAttribute("name") || ""]) {
        if (
          !key ||
          names.has(key) ||
          Object.prototype.hasOwnProperty.call(win, key)
        )
          continue;
        const existing = (win as any)[key];
        if (
          existing !== undefined &&
          existing !== element &&
          existing !== (element as HTMLIFrameElement).contentWindow
        )
          continue;
        const lookup = () =>
          element.isConnected
            ? element.tagName === "IFRAME"
              ? (element as HTMLIFrameElement).contentWindow
              : element
            : undefined;
        const entry = {
          get: () => undefined as unknown,
          assigned: false,
          value: undefined as unknown,
        };
        const get = () => (entry.assigned ? entry.value : lookup());
        entry.get = get;
        names.set(key, entry);
        Object.defineProperty(win, key, {
          configurable: true,
          enumerable: false,
          get,
          set(value) {
            entry.assigned = true;
            entry.value = value;
          },
        });
      }
    }
  }
  function moveNode(parent: Element, node: Node, before: Node | null = null) {
    // Reparenting a connected iframe with appendChild destroys its browsing
    // context. Atomic moves preserve it, along with media/focus/animation state.
    if (atomicMove && parent.isConnected && node.isConnected)
      atomicMove.call(parent, node, before);
    else insert.call(parent, node, before);
  }
  const actualParent = (node: Node) =>
    parentDescriptor.get!.call(node) as Node | null;
  function forgetMetadata(node: Element, restore: boolean) {
    const entry = metadata.get(node);
    if (!entry) return;
    if (
      restore &&
      actualParent(node) === siteHead &&
      actualParent(entry.anchor) === entry.parent
    )
      moveNode(entry.parent as Element, node, entry.anchor);
    if (actualParent(entry.anchor))
      remove.call(actualParent(entry.anchor), entry.anchor);
    metadata.delete(node);
    metadataAnchors.delete(entry.anchor);
  }
  function syncMetadata() {
    const head = doc.head;
    if (!siteHead || !head) return;
    for (const node of metadata.keys())
      if (actualParent(node) !== siteHead || !node.matches(metadataSelector))
        forgetMetadata(node, true);
    preserveNamedElements(head);
    for (const node of Array.from(queryAll.call(head, metadataSelector))) {
      const parent = actualParent(node);
      if (!parent || metadata.has(node)) continue;
      const anchor = doc.createComment("");
      insert.call(parent, anchor, node);
      moveNode(siteHead, node);
      metadata.set(node, { parent, anchor });
      metadataAnchors.set(anchor, node);
    }
  }
  function headNodes(): Node[] {
    const head = doc.head;
    if (!head) return [];
    return Array.from(
      childrenDescriptor.get!.call(head) as NodeListOf<ChildNode>,
    ).map((node) => metadataAnchors.get(node as Comment) || node);
  }
  function forgetListener(entry: Listener) {
    const index = listeners.indexOf(entry);
    if (index >= 0) listeners.splice(index, 1);
    if (entry.abort && entry.options.signal)
      removeEvent.call(entry.options.signal, "abort", entry.abort);
  }
  function transferListeners(target: EventTarget) {
    for (const entry of [...listeners]) {
      if (entry.options.signal?.aborted) {
        forgetListener(entry);
        continue;
      }
      if (entry.target === target) continue;
      removeEvent.call(
        entry.target,
        entry.type,
        entry.callback,
        entry.options.capture,
      );
      addEvent.call(target, entry.type, entry.callback, entry.options);
      entry.target = target;
    }
  }
  function syncSheets() {
    if (!tree || !siteHtml) return;
    const head = doc.head;
    for (const node of sheets.keys()) {
      if (!node.isConnected || !head?.contains(node)) {
        sheets.get(node)?.remove();
        sheets.delete(node);
      }
    }
    if (head)
      for (const node of Array.from(
        queryAll.call(head, 'style,link[rel~="stylesheet"]'),
      )) {
        const old = sheets.get(node);
        if (!old) {
          const clone = node.cloneNode(true) as Element;
          tree.insertBefore(clone, siteHtml);
          sheets.set(node, clone);
        } else {
          // Preserve loaded stylesheets unless their source actually changes.
          const signature = node.outerHTML;
          if (old.outerHTML !== signature) {
            const clone = node.cloneNode(true) as Element;
            old.replaceWith(clone);
            sheets.set(node, clone);
          }
        }
      }
    for (const attr of Array.from(doc.documentElement.attributes)) {
      if (
        !attr.name.startsWith("runtimekit-") &&
        siteHtml.getAttribute(attr.name) !== attr.value
      )
        siteHtml.setAttribute(attr.name, attr.value);
    }
    for (const attr of Array.from(siteHtml.attributes)) {
      if (!doc.documentElement.hasAttribute(attr.name))
        siteHtml.removeAttribute(attr.name);
    }
  }
  function move() {
    if (!enabled || disposed || moving) return;
    const body = actualBody();
    if (!body || body.tagName !== "BODY") return;
    moving = true;
    try {
      preserveNamedElements(body);
      if (!tree || nativeBody !== body) {
        nativeBody = body;
        siteBody = body.cloneNode(false) as HTMLBodyElement;
        siteHtml = doc.createElement("html");
        siteHead = doc.createElement("head");
        host = doc.createElement("main");
        host.style.cssText = "display:block;min-height:100vh";
        tree = host.attachShadow({ mode: "closed" });
        append.call(tree, siteHtml);
        append.call(siteHtml, siteHead);
        append.call(siteHtml, siteBody);
        append.call(body, host);
        observer.observe(tree, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["id", "name", "rel", "property", "href", "content"],
        });
        body.style.cssText = "margin:0;padding:0;min-height:100vh";
        transferListeners(tree);
      }
      for (const child of Array.from(body.childNodes)) {
        if (child !== host) moveNode(siteBody!, child);
      }
      if (host!.parentNode !== body) append.call(body, host!);
      preserveNamedElements(siteBody!);
      syncSheets();
      syncMetadata();
    } finally {
      moving = false;
    }
  }
  function restore() {
    if (!tree || !nativeBody || !siteBody || !host) return;
    moving = true;
    try {
      transferListeners(doc);
      for (const node of [...metadata.keys()]) forgetMetadata(node, true);
      for (const attr of Array.from(nativeBody.attributes))
        if (!siteBody.hasAttribute(attr.name))
          nativeBody.removeAttribute(attr.name);
      for (const attr of Array.from(siteBody.attributes))
        nativeBody.setAttribute(attr.name, attr.value);
      while (siteBody.firstChild)
        moveNode(nativeBody, siteBody.firstChild, host);
      remove.call(nativeBody, host);
      tree = null;
      siteBody = null;
      siteHtml = null;
      siteHead = null;
      host = null;
      sheets.clear();
      for (const [key, entry] of names) {
        const descriptor = Object.getOwnPropertyDescriptor(win, key);
        if (descriptor?.get === entry.get) {
          // Keep explicit site assignments; remove only our virtual named getter.
          delete (win as any)[key];
          if (entry.assigned) (win as any)[key] = entry.value;
        }
      }
      names.clear();
    } finally {
      moving = false;
    }
  }
  client.Trap("Document.prototype.body", {
    get(ctx: any) {
      if (ctx.this !== doc || !enabled) return ctx.get();
      move();
      return siteBody || ctx.get();
    },
    set(ctx: any, value: any) {
      if (ctx.this === doc && tree && value instanceof win.HTMLBodyElement) {
        siteBody!.replaceWith(value);
        siteBody = value;
        return;
      }
      return ctx.set(value);
    },
  });
  client.Proxy("Node.prototype.contains", {
    apply(ctx: any) {
      if (
        !enabled ||
        !siteHtml ||
        (ctx.this !== doc &&
          ctx.this !== doc.documentElement &&
          ctx.this !== doc.head)
      )
        return;
      ctx.return(
        contains.call(ctx.this, ctx.args[0]) ||
          contains.call(
            ctx.this === doc.head ? siteHead! : siteHtml,
            ctx.args[0],
          ),
      );
    },
  });
  for (const key of ["parentNode", "parentElement"])
    client.Trap("Node.prototype." + key, {
      get(ctx: any) {
        if (!enabled) return ctx.get();
        const entry = metadata.get(ctx.this);
        if (!entry) return ctx.get();
        return key === "parentNode"
          ? entry.parent
          : entry.parent instanceof win.Element
            ? entry.parent
            : null;
      },
    });
  for (const [name, elements, one, last] of [
    ["Node.prototype.childNodes", false, false, false],
    ["Element.prototype.children", true, false, false],
    ["Element.prototype.childElementCount", true, true, false],
    ["Node.prototype.firstChild", false, true, false],
    ["Node.prototype.lastChild", false, true, true],
    ["Element.prototype.firstElementChild", true, true, false],
    ["Element.prototype.lastElementChild", true, true, true],
  ] as const)
    client.Trap(name, {
      get(ctx: any) {
        if (!enabled || !siteHead || ctx.this !== doc.head) return ctx.get();
        const read = () =>
          headNodes().filter(
            (node) => !elements || node instanceof win.Element,
          );
        if (name.endsWith("childElementCount")) return read().length;
        if (one) {
          const nodes = read();
          return (last ? nodes.at(-1) : nodes[0]) || null;
        }
        return collection(ctx.get(), read);
      },
    });
  for (const [name, original] of [
    ["Element.prototype.querySelector", query],
    ["Element.prototype.querySelectorAll", queryAll],
    ["Element.prototype.getElementsByTagName", elementTags],
    ["Element.prototype.getElementsByClassName", elementClasses],
  ] as const)
    client.Proxy(name, {
      apply(ctx: any) {
        if (!enabled || !siteHead || ctx.this !== doc.head) return;
        const value = String(ctx.args[0]);
        if (name.endsWith("querySelector"))
          ctx.return(
            (original as any).call(ctx.this, value) ||
              query.call(siteHead, value),
          );
        else {
          const target = (original as any).call(ctx.this, value);
          const read = () => [
            ...Array.from((original as any).call(ctx.this, value)),
            ...Array.from((original as any).call(siteHead, value)),
          ];
          if (name.endsWith("querySelectorAll")) {
            const values = read();
            ctx.return(collection(target, () => values));
          } else ctx.return(collection(target, read));
        }
      },
    });
  for (const [name, original] of [
    ["Node.prototype.removeChild", remove],
    ["Node.prototype.replaceChild", replace],
    ["Node.prototype.insertBefore", insert],
  ] as const)
    client.Proxy(name, {
      apply(ctx: any) {
        if (!enabled || !siteHead) return;
        const old = ctx.args[name.endsWith("removeChild") ? 0 : 1];
        const entry = metadata.get(old);
        if (!entry || entry.parent !== ctx.this) return;
        if (name.endsWith("insertBefore")) {
          ctx.return(insert.call(ctx.this, ctx.args[0], entry.anchor));
        } else if (name.endsWith("removeChild")) {
          const value = remove.call(siteHead, old);
          forgetMetadata(old, false);
          ctx.return(value);
        } else {
          const next = ctx.args[0];
          if (next === old) {
            ctx.return(old);
            return;
          }
          if (next instanceof win.Element && next.matches(metadataSelector)) {
            const value = replace.call(siteHead, next, old);
            metadata.delete(old);
            metadata.set(next, entry);
            metadataAnchors.set(entry.anchor, next);
            ctx.return(value);
          } else {
            insert.call(ctx.this, next, entry.anchor);
            const value = remove.call(siteHead, old);
            forgetMetadata(old, false);
            ctx.return(value);
          }
        }
      },
    });
  client.Proxy("Node.prototype.getRootNode", {
    apply(ctx: any) {
      if (!enabled || !tree) return;
      const value = rootNode.call(ctx.this, ctx.args[0]);
      ctx.return(value === tree ? doc : value);
    },
  });
  // Do not alter selectors, IDs, variable names, URL queries or request bodies.
  // Search the native head first and the same site nodes in the rendering tree.
  for (const [name, original] of [
    ["Document.prototype.querySelector", docQuery],
    ["Document.prototype.querySelectorAll", docQueryAll],
    ["Document.prototype.getElementById", getId],
    ["Document.prototype.getElementsByTagName", getTags],
    ["Document.prototype.getElementsByClassName", getClasses],
  ] as const)
    client.Proxy(name, {
      apply(ctx: any) {
        if (ctx.this !== doc || !enabled) return;
        move();
        if (!siteHtml) return;
        const value = String(ctx.args[0]);
        if (name.endsWith("getElementById")) {
          ctx.return(
            (original as any).call(doc, value) || tree!.getElementById(value),
          );
        } else if (name.endsWith("querySelector")) {
          const outer = (original as any).call(doc, value);
          ctx.return(
            outer === nativeBody
              ? siteBody
              : outer === host
                ? query.call(siteHtml, value)
                : outer || query.call(siteHtml, value),
          );
        } else if (name.endsWith("querySelectorAll")) {
          const found = queryAll.call(siteHtml, value);
          const outer = Array.from((original as any).call(doc, value)).filter(
            (node) => node !== host && node !== nativeBody,
          ) as Element[];
          const values = [
            ...outer,
            ...Array.from(found).filter((node) => node !== siteHead),
          ];
          ctx.return(
            outer.length === 0 && !Array.from(found).includes(siteHead!)
              ? found
              : collection(found, () => values),
          );
        } else {
          const inside = name.endsWith("getElementsByTagName")
            ? siteHtml.getElementsByTagName(value)
            : siteHtml.getElementsByClassName(value);
          ctx.return(
            collection(inside, () => [
              ...(Array.from((original as any).call(doc, value)).filter(
                (node) => node !== host && node !== nativeBody,
              ) as Element[]),
              ...Array.from(inside).filter((node) => node !== siteHead),
            ]),
          );
        }
      },
    });
  client.Trap("Event.prototype.currentTarget", {
    get(ctx: any) {
      return dispatchTargets.get(ctx.this) || ctx.get();
    },
  });
  client.Proxy("EventTarget.prototype.addEventListener", {
    apply(ctx: any) {
      if (disposed || ctx.this !== doc || !delegated.has(String(ctx.args[0])))
        return;
      const type = String(ctx.args[0]),
        listener = ctx.args[1],
        raw = ctx.args[2];
      if (listener == null || !["function", "object"].includes(typeof listener))
        return;
      const dictionary = raw !== null && typeof raw === "object";
      const capture = dictionary ? Boolean(raw.capture) : Boolean(raw);
      const once = dictionary ? Boolean(raw.once) : false;
      const passive = dictionary ? raw.passive : undefined;
      const signal = dictionary ? raw.signal : undefined;
      const options: AddEventListenerOptions = {
        capture,
        once,
        // Retain Document's native default rather than adopting ShadowRoot's.
        passive:
          passive === undefined
            ? ["touchstart", "touchmove", "wheel", "mousewheel"].includes(type)
            : Boolean(passive),
        ...(signal === undefined ? {} : { signal }),
      };
      const existing = listeners.find(
        (x) =>
          x.type === type &&
          x.listener === listener &&
          Boolean(x.options.capture) === capture,
      );
      if (existing) {
        ctx.return(
          addEvent.call(existing.target, type, existing.callback, options),
        );
        return;
      }
      const entry: Listener = {
        type,
        listener,
        options,
        target: enabled && tree ? tree : doc,
        callback: () => {},
      };
      entry.callback = (event: Event) => {
        if (entry.options.once) forgetListener(entry);
        const previous = dispatchTargets.get(event);
        dispatchTargets.set(event, doc);
        try {
          if (typeof listener === "function") listener.call(doc, event);
          else listener.handleEvent(event);
        } finally {
          if (previous) dispatchTargets.set(event, previous);
          else dispatchTargets.delete(event);
        }
      };
      // Native validation must succeed before creating a tracked registration.
      const result = addEvent.call(entry.target, type, entry.callback, options);
      if (!options.signal?.aborted) {
        listeners.push(entry);
        if (options.signal) {
          entry.abort = () => forgetListener(entry);
          addEvent.call(options.signal, "abort", entry.abort, { once: true });
        }
      }
      ctx.return(result);
    },
  });
  client.Proxy("EventTarget.prototype.removeEventListener", {
    apply(ctx: any) {
      if (disposed || ctx.this !== doc || !delegated.has(String(ctx.args[0])))
        return;
      const type = String(ctx.args[0]),
        listener = ctx.args[1],
        raw = ctx.args[2];
      const capture =
        raw !== null && typeof raw === "object"
          ? Boolean(raw.capture)
          : Boolean(raw);
      const entry = listeners.find(
        (x) =>
          x.type === type &&
          x.listener === listener &&
          Boolean(x.options.capture) === capture,
      );
      if (!entry) return;
      const result = removeEvent.call(
        entry.target,
        type,
        entry.callback,
        capture,
      );
      forgetListener(entry);
      ctx.return(result);
    },
  });
  const observer = new win.MutationObserver(() => move());
  observer.observe(doc, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  const ready = () => move();
  addEvent.call(doc, "DOMContentLoaded", ready);
  move();
  return {
    update(next) {
      enabled = next;
      if (enabled) move();
      else restore();
    },
    dispose() {
      observer.disconnect();
      removeEvent.call(doc, "DOMContentLoaded", ready);
      restore();
      for (const entry of [...listeners]) {
        removeEvent.call(
          entry.target,
          entry.type,
          entry.callback,
          entry.options.capture,
        );
        if (!entry.options.signal?.aborted)
          addEvent.call(doc, entry.type, entry.listener, entry.options);
        forgetListener(entry);
      }
      disposed = true;
    },
  };
}
