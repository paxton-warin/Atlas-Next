/** Explicit DOM API adaptation for resource elements created by website script.
 * No MutationObserver races an already-issued frontend request. URL setters and
 * common insertion APIs are intercepted BEFORE they invoke native loading.
 * HTML-string sinks, CSSOM mutation, shadow trees and parser writes still need
 * separately qualified hooks; this component does not silently claim them.
 */
import type { createOpaqueResourceGraph } from "./opaque-resource-graph.ts";
export function installOpaqueDynamicResources(options: {
  global: Window & typeof globalThis;
  client: any;
  graph: ReturnType<typeof createOpaqueResourceGraph>;
}) {
  const { global, client, graph } = options;
  const native = (key: string) => client.natives.store[key];
  const set = native("Element.prototype.setAttribute"),
    get = native("Element.prototype.getAttribute"),
    remove = native("Element.prototype.removeAttribute");
  const pending = new WeakMap<Element, Promise<void>>(),
    generation = new WeakMap<Element, number>();
  const restore: (() => void)[] = [];
  let live = true;
  const linkResource = (element: Element) =>
    /(?:^|\s)(?:stylesheet|icon|apple-touch-icon|mask-icon)(?:\s|$)/i.test(
      get.call(element, "rel") || "",
    );
  const attribute = (element: Element, name: string) =>
    (element.localName === "script" && name === "src") ||
    (element.localName === "img" && ["src", "srcset"].includes(name)) ||
    (element.localName === "source" && ["src", "srcset"].includes(name)) ||
    (["video", "audio"].includes(element.localName) && name === "src") ||
    (element.localName === "video" && name === "poster") ||
    (element.localName === "link" && name === "href" && linkResource(element));
  const relevant = (element: Element) =>
    ["script", "img", "style", "source", "picture", "video", "audio"].includes(
      element.localName,
    ) ||
    (element.localName === "link" && linkResource(element));
  const error = (element: Element) =>
    element.dispatchEvent(new global.Event("error"));
  function schedule(element: Element, parentHint?: Element) {
    if (
      element.localName === "source" &&
      !element.parentElement &&
      !parentHint?.matches("picture,video,audio")
    )
      return Promise.resolve();
    const number = (generation.get(element) || 0) + 1;
    generation.set(element, number);
    const task = Promise.resolve().then(async () => {
      if (!live || generation.get(element) !== number) return;
      await graph.prepareElement(
        element,
        () => live && generation.get(element) === number,
        parentHint,
      );
    });
    pending.set(element, task);
    void task.catch(() => {
      if (live && generation.get(element) === number) error(element);
    });
    return task;
  }
  function setURL(element: Element, name: string, value: unknown) {
    const text = String(value);
    set.call(element, "runtimekit-attr-" + name, text);
    // A previously connected element must never briefly load the rewritten
    // frontend HTTP URL while its broker request is pending.
    remove.call(element, name);
    void schedule(element);
  }
  function replace(target: object, name: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor?.configurable) return;
    Object.defineProperty(target, name, { ...descriptor, value });
    restore.push(() => Object.defineProperty(target, name, descriptor));
  }
  const previousSet = global.Element.prototype.setAttribute;
  replace(
    global.Element.prototype,
    "setAttribute",
    function (this: Element, name: string, value: string) {
      if (live && attribute(this, String(name).toLowerCase())) {
        setURL(this, String(name).toLowerCase(), value);
        return;
      }
      const result = previousSet.call(this, name, value);
      if (
        live &&
        this.localName === "link" &&
        String(name).toLowerCase() === "rel" &&
        linkResource(this)
      ) {
        const href =
          get.call(this, "runtimekit-attr-href") ?? get.call(this, "href");
        if (href !== null) setURL(this, "href", href);
      }
      return result;
    },
  );
  for (const [constructor, name] of [
    [global.HTMLScriptElement, "src"],
    [global.HTMLImageElement, "src"],
    [global.HTMLImageElement, "srcset"],
    [global.HTMLSourceElement, "src"],
    [global.HTMLSourceElement, "srcset"],
    [global.HTMLMediaElement, "src"],
    [global.HTMLVideoElement, "poster"],
    [global.HTMLLinkElement, "href"],
  ] as const) {
    const prototype = constructor.prototype,
      descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.configurable) continue;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      set: function (this: Element, value: string) {
        if (live && attribute(this, name)) {
          setURL(this, name, value);
          return;
        }
        descriptor.set!.call(this, value);
      },
    });
    restore.push(() => Object.defineProperty(prototype, name, descriptor));
  }
  const selector =
    "script[src],script[type=module],img[src],img[srcset],link[rel],style,source[src],source[srcset],video,audio";
  async function prepare(node: Node, parentHint?: Element) {
    const elements: Element[] = [];
    if (node instanceof global.Element && relevant(node)) elements.push(node);
    if (
      node instanceof global.Element ||
      node instanceof global.DocumentFragment
    )
      elements.push(...Array.from(node.querySelectorAll(selector)));
    for (const element of elements) {
      const task = pending.get(element);
      if (task) await task;
      else await schedule(element, parentHint);
    }
    return elements.length > 0;
  }
  function hasResource(node: unknown): node is Node {
    return (
      node instanceof global.Node &&
      ((node instanceof global.Element && relevant(node)) ||
        ((node instanceof global.Element ||
          node instanceof global.DocumentFragment) &&
          !!node.querySelector(selector)))
    );
  }
  for (const name of ["appendChild", "insertBefore", "replaceChild"] as const) {
    const previous = global.Node.prototype[name];
    replace(global.Node.prototype, name, function (this: Node, ...args: any[]) {
      const node = args[0];
      if (!live || !hasResource(node))
        return Reflect.apply(previous, this, args);
      const parent = this,
        returned = name === "replaceChild" ? args[1] : node;
      void prepare(node, parent instanceof global.Element ? parent : undefined)
        .then(() => {
          if (live) Reflect.apply(previous, parent, args);
        })
        .catch(() => {
          if (node instanceof global.Element) error(node);
        });
      return returned;
    });
  }
  for (const prototype of [
    global.Element.prototype,
    global.DocumentFragment.prototype,
  ])
    for (const name of ["append", "prepend"] as const) {
      const previous = prototype[name];
      replace(
        prototype,
        name,
        function (
          this: Element | DocumentFragment,
          ...args: (Node | string)[]
        ) {
          if (!live || !args.some(hasResource))
            return Reflect.apply(previous, this, args);
          const parent = this;
          void Promise.all(
            args
              .filter(hasResource)
              .map((node) =>
                prepare(
                  node,
                  parent instanceof global.Element ? parent : undefined,
                ),
              ),
          )
            .then(() => {
              if (live) Reflect.apply(previous, parent, args);
            })
            .catch(() => {
              for (const node of args)
                if (node instanceof global.Element) error(node);
            });
        },
      );
    }
  return {
    dispose() {
      if (!live) return;
      live = false;
      for (const undo of restore.reverse()) undo();
    },
  };
}
