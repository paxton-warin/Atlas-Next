// A sandbox with an opaque origin cannot be controlled by a service worker.
// Load the reviewed, self-contained renderer through the same assigned node,
// then execute its original code in srcdoc with its sandbox and CSP intact.
// No runtime hooks, virtual storage, cookies or privileged APIs enter the child.
export type OpaqueResource = {
  status: number;
  type: string;
  text: string;
  policies: string[];
  allowOrigin?: string;
  allowCredentials?: string;
};
export type RendererFetch = (
  url: URL,
  credentials?: "include" | "omit",
  kind?: "document" | "module",
) => Promise<OpaqueResource>;
export function moduleAllowedByPolicy(
  policy: string,
  moduleUrl: URL,
  documentUrl: URL,
) {
  const parts = policy.split(";").map((part) => part.trim().split(/\s+/));
  const directive =
    parts.find((part) => part[0].toLowerCase() === "script-src-elem") ||
    parts.find((part) => part[0].toLowerCase() === "script-src") ||
    parts.find((part) => part[0].toLowerCase() === "default-src");
  if (!directive) return false;
  return directive.slice(1).some((source) => {
    if (source === "'self'") return moduleUrl.origin === documentUrl.origin;
    try {
      const allowed = new URL(source);
      return (
        allowed.origin === moduleUrl.origin &&
        (allowed.pathname.endsWith("/")
          ? moduleUrl.pathname.startsWith(allowed.pathname)
          : moduleUrl.pathname === allowed.pathname)
      );
    } catch {
      return false;
    }
  });
}
export function rendererTarget(
  value: string,
  parentUrl: string,
  fixture = false,
) {
  try {
    const parent = new URL(parentUrl),
      target = new URL(value, parent);
    if (target.username || target.password) return;
    if (
      fixture &&
      parent.origin === "http://127.0.0.1:4199" &&
      parent.pathname === "/compatibility-opaque-parent" &&
      target.origin === parent.origin &&
      target.pathname === "/compatibility-opaque-child"
    )
      return target;
    if (
      ["https://chatgpt.com", "https://chat.openai.com"].includes(
        parent.origin,
      ) &&
      target.origin === "https://cdn.platform.openai.com" &&
      target.pathname === "/deployments/dil/v14/runner.html"
    )
      return target;
  } catch {
    /* Unknown destinations retain the normal engine path. */
  }
}
function rendererParent(value: string, fixture: boolean) {
  try {
    const url = new URL(value);
    return (
      ["https://chatgpt.com", "https://chat.openai.com"].includes(url.origin) ||
      (fixture &&
        url.origin === "http://127.0.0.1:4199" &&
        url.pathname === "/compatibility-opaque-parent")
    );
  } catch {
    return false;
  }
}
function authorizedModule(value: string, documentUrl: URL, fixture: boolean) {
  const url = new URL(value, documentUrl);
  if (url.username || url.password || url.search || url.hash)
    throw Error("renderer_module_address");
  if (
    fixture &&
    url.origin === "http://127.0.0.1:4199" &&
    url.pathname === "/compatibility-opaque-module.js"
  )
    return url;
  if (
    url.origin !== "https://cdn.platform.openai.com" ||
    !/^\/assets\/dil\/runner-[A-Za-z0-9_-]{8,64}\.js$/.test(url.pathname)
  )
    throw Error("renderer_module_address");
  return url;
}
async function scriptHash(source: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
  );
  return "'sha256-" + btoa(String.fromCharCode(...bytes)) + "'";
}
export async function prepareOpaqueDocument(
  win: Window & typeof globalThis,
  url: URL,
  fetchResource: RendererFetch,
  fixture = false,
) {
  const resource = await fetchResource(url, "include", "document");
  if (
    resource.status !== 200 ||
    resource.type !== "text/html" ||
    resource.text.length > 256000
  )
    throw Error("renderer_document_response");
  // Parse in the trusted runtime realm. The website's DOMParser is hooked by
  // the engine and would remove CSP while rewriting this isolated document.
  const doc = new DOMParser().parseFromString(resource.text, "text/html");
  const scripts = [...doc.querySelectorAll<HTMLScriptElement>("script[src]")];
  if (scripts.length > 2 || scripts.some((script) => script.type !== "module"))
    throw Error("renderer_document_shape");
  const policyMeta = [
    ...doc.querySelectorAll<HTMLMetaElement>("meta[http-equiv]"),
  ].filter(
    (meta) => meta.httpEquiv.toLowerCase() === "content-security-policy",
  );
  const policies = [
    ...resource.policies,
    ...policyMeta.map((meta) => meta.content),
  ];
  // Fail closed rather than remove a policy or add a broad script permission.
  if (
    !fixture &&
    (!policies.length ||
      policies.some(
        (policy) =>
          !/\bdefault-src\s+'none'/i.test(policy) ||
          !/\bframe-src\s+'none'/i.test(policy),
      ))
  )
    throw Error("renderer_policy_shape");
  const hashes: string[] = [];
  for (const script of scripts) {
    if (script.hasAttribute("integrity"))
      throw Error("renderer_integrity_not_qualified");
    const moduleUrl = authorizedModule(
      script.getAttribute("src")!,
      url,
      fixture,
    );
    if (
      policies.some((policy) => !moduleAllowedByPolicy(policy, moduleUrl, url))
    )
      throw Error("renderer_module_policy");
    const credentials =
      script.crossOrigin === "use-credentials" ? "include" : "omit";
    const module = await fetchResource(moduleUrl, credentials, "module");
    if (
      !(
        module.allowOrigin === "null" ||
        (credentials === "omit" && module.allowOrigin === "*")
      ) ||
      (credentials === "include" && module.allowCredentials !== "true")
    )
      throw Error("renderer_module_cors");
    if (
      module.status !== 200 ||
      !["application/javascript", "text/javascript"].includes(module.type) ||
      module.text.length > 1024000
    )
      throw Error("renderer_module_response");
    // This reviewed runner is a self-contained module (its worker is embedded).
    // Do not silently inline future modules that need unresolved dependencies.
    if (/(?:\bimport\s*(?:["'{*]|[A-Za-z_$])|\bimport\s*\()/m.test(module.text))
      throw Error("renderer_module_dependencies");
    const code = module.text.replace(/<\/script/gi, "<\\/script");
    hashes.push(await scriptHash(code));
    script.removeAttribute("src");
    script.textContent = code;
  }
  function adapt(policy: string) {
    const parts = policy.split(";");
    const index = parts.findIndex((part) =>
      /^\s*script-src(?:\s|$)/i.test(part),
    );
    if (index < 0 || /(?:^|\s)'none'(?:\s|$)/i.test(parts[index]))
      throw Error("renderer_script_policy");
    // Authorize only exact code fetched from the original approved module URL.
    // Existing unsafe-eval/worker directives are neither added nor expanded.
    parts[index] += " " + hashes.join(" ");
    const elementIndex = parts.findIndex((part) =>
      /^\s*script-src-elem(?:\s|$)/i.test(part),
    );
    if (elementIndex >= 0) parts[elementIndex] += " " + hashes.join(" ");
    return parts.join(";");
  }
  for (const meta of policyMeta) meta.content = adapt(meta.content);
  for (const policy of resource.policies) {
    const meta = doc.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = adapt(policy);
    doc.head.prepend(meta);
  }
  return {
    html: "<!doctype html>" + doc.documentElement.outerHTML,
    resources: 1 + scripts.length,
  };
}
const installed = new WeakSet<Document>();
export function installOpaqueRenderer(
  win: Window & typeof globalThis,
  client: any,
  options: {
    fixture?: boolean;
    fetchResource: RendererFetch;
    /** New opaque runtime prepares reviewed source in the TRUSTED frontend,
     * not in RuntimeKit's hooked DOMParser realm. Legacy path is unchanged. */
    prepareDocument?: (
      url: URL,
    ) => Promise<{ html: string; resources: number }>;
    /** Opaque v2 uses an authenticated reserved native helper navigation; the
     * callback receives the exact element so it can bind its native child slot. */
    reserveNavigation?: (url:URL,element:HTMLIFrameElement)=>Promise<{helperURL:string;ready:Promise<{resources:number}>;cancel():void}>;
    report: (state: "applied" | "error", resources: number) => void;
  },
) {
  const doc = win.document;
  if (!rendererParent(client.url.href, options.fixture === true)) return;
  if (installed.has(doc)) return;
  installed.add(doc);
  const prototype = win.HTMLIFrameElement.prototype;
  const src = Object.getOwnPropertyDescriptor(prototype, "src")!;
  const sandboxDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "sandbox",
  )!;
  const sandboxTokens = new WeakMap<DOMTokenList, HTMLIFrameElement>();
  const setSrcdoc =
    client.descriptors.store["HTMLIFrameElement.prototype.srcdoc"]?.set;
  if (!src?.set || !setSrcdoc) return;
  const original = new WeakMap<HTMLIFrameElement, string>();
  const staged = new WeakMap<
    HTMLIFrameElement,
    { value: string; href: string }
  >();
  const managedSrcdoc = new WeakSet<HTMLIFrameElement>();
  const declaredSandbox = new WeakMap<HTMLIFrameElement, string>();
  const failed = new WeakMap<HTMLIFrameElement, string>();
  const bound = new WeakSet<HTMLIFrameElement>();
  const pending = new Map<HTMLIFrameElement, number>();
  const nativeLoadBindings = new WeakSet<HTMLIFrameElement>();
  const completedNativeLoads = new WeakMap<
    HTMLIFrameElement,
    { src: string | null; srcdoc: string | null }
  >();
  const nativeLoadWaiters = new Map<
    HTMLIFrameElement,
    {
      version: number;
      src: string;
      srcdoc: string | null;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const nativeAttribute = (
    element: HTMLIFrameElement,
    name: string,
  ): string | null =>
    client.natives.call("Element.prototype.getAttribute", element, name);
  function cancelNativeLoad(element: HTMLIFrameElement, version?: number) {
    const waiter = nativeLoadWaiters.get(element);
    if (!waiter || (version !== undefined && waiter.version !== version))
      return;
    nativeLoadWaiters.delete(element);
    clearTimeout(waiter.timer);
    client.natives.call(
      "EventTarget.prototype.removeEventListener",
      element,
      "load",
      recordNativeLoad,
    );
    nativeLoadBindings.delete(element);
    waiter.reject(Error("renderer_initial_navigation_cancelled"));
  }
  const recordNativeLoad = (event: Event) => {
    const element = event.currentTarget;
    if (!event.isTrusted || !isFrame(element)) return;
    client.natives.call(
      "EventTarget.prototype.removeEventListener",
      element,
      "load",
      recordNativeLoad,
    );
    nativeLoadBindings.delete(element);
    if (
      !alive ||
      !rendererTarget(sourceOf(element), client.url.href, options.fixture)
    )
      return;
    const state = {
      src: nativeAttribute(element, "src"),
      srcdoc: nativeAttribute(element, "srcdoc"),
    };
    completedNativeLoads.set(element, state);
    const waiter = nativeLoadWaiters.get(element);
    if (waiter && waiter.src === state.src && waiter.srcdoc === state.srcdoc) {
      nativeLoadWaiters.delete(element);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };
  function watchNativeLoad(element: HTMLIFrameElement) {
    if (nativeLoadBindings.has(element)) return;
    nativeLoadBindings.add(element);
    client.natives.call(
      "EventTarget.prototype.addEventListener",
      element,
      "load",
      recordNativeLoad,
    );
  }
  function settleInitialNativeLoad(
    element: HTMLIFrameElement,
    version: number,
  ) {
    const src = nativeAttribute(element, "src"),
      srcdoc = nativeAttribute(element, "srcdoc");
    // Initial about:blank is synchronously created. A previously installed
    // managed srcdoc also has no outstanding native HTTP document to wait for.
    if (!src || src === "about:blank" || managedSrcdoc.has(element))
      return Promise.resolve();
    const completed = completedNativeLoads.get(element);
    if (completed && completed.src === src && completed.srcdoc === srcdoc)
      return Promise.resolve();
    // Chrome can commit an already-started HTTP error document after a srcdoc
    // update, leaving a real srcdoc attribute on the old blank/error document.
    // Let that initial navigation settle once; never reload or retry it.
    watchNativeLoad(element);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (nativeLoadWaiters.get(element)?.version !== version) return;
        nativeLoadWaiters.delete(element);
        client.natives.call(
          "EventTarget.prototype.removeEventListener",
          element,
          "load",
          recordNativeLoad,
        );
        nativeLoadBindings.delete(element);
        reject(Error("renderer_initial_navigation_timeout"));
      }, 15000);
      nativeLoadWaiters.set(element, {
        version,
        src,
        srcdoc,
        resolve,
        reject,
        timer,
      });
    });
  }

  let generation = 0,
    alive = true;
  let bypass = false;
  const receive = (event: MessageEvent) => {
    if (
      !event.isTrusted ||
      event.origin !== "null" ||
      !event.source ||
      !client.nativeOpaqueWindows.has(event.source)
    )
      return;
    for (const port of event.ports) client.nativeMessagePorts.add(port);
  };
  client.natives.call(
    "EventTarget.prototype.addEventListener",
    win,
    "message",
    receive,
  );
  function normalSource(element: HTMLIFrameElement, value: string) {
    if (nativeAttribute(element, "srcdoc") === null)
      completedNativeLoads.delete(element);
    bypass = true;
    try {
      // Adopted parser nodes can retain a foreign prototype. Use this client's
      // URL-rewriting attribute handler rather than a foreign native src setter.
      nativeSetAttribute.call(element, "src", value);
    } finally {
      bypass = false;
    }
  }
  function stageDetachedSource(element: HTMLIFrameElement, value: string) {
    const target = rendererTarget(value, client.url.href, options.fixture);
    if (!target || element.isConnected) return false;
    // A src-first declaration has not chosen its sandbox yet. Publishing its
    // native encoded src immediately starts an obsolete navigation on append,
    // racing the isolated srcdoc prepared as soon as sandbox is declared.
    // Keep normal reflected attributes immediately, but select the native
    // route once this synchronous declaration finishes. Unknown destinations
    // and connected-frame navigations never enter this path.
    const intent = { value, href: target.href };
    staged.set(element, intent);
    client.natives.call(
      "Element.prototype.setAttribute",
      element,
      "runtimekit-attr-src",
      value,
    );
    if(options.reserveNavigation)client.natives.call("Element.prototype.removeAttribute",element,"src");
    else client.natives.call("Element.prototype.setAttribute", element, "src", "");
    queueMicrotask(() => {
      if (!alive || staged.get(element) !== intent) return;
      staged.delete(element);
      if (element.getAttribute("src") !== value) return;
      if (pending.has(element) || original.has(element)) return;
      if (!load(element, value)) normalSource(element, value);
    });
    return true;
  }
  function sourceOf(element: HTMLIFrameElement, actual = false): string {
    const value =
      (actual ? undefined : original.get(element)) ??
      nativeAttribute(element,"runtimekit-attr-src") ??
      element.getAttribute("src") ??
      String(src.get!.call(element));
    // Parser-created frames can expose the physical encoded route.
    // Decode only the current controller's own prefix, not arbitrary URLs.
    return value.startsWith(client.context.prefix.href)
      ? client.restoreurl(value)
      : value;
  }
  function sandboxChanged(element: HTMLIFrameElement) {
    if (pending.has(element) || original.has(element)) return;
    const value = sourceOf(element);
    if (rendererTarget(value, client.url.href, options.fixture))
      load(element, value);
  }
  Object.defineProperty(prototype, "sandbox", {
    ...sandboxDescriptor,
    get() {
      const tokens = sandboxDescriptor.get!.call(this);
      sandboxTokens.set(tokens, this);
      return tokens;
    },
    set(value) {
      if (sandboxDescriptor.set) sandboxDescriptor.set.call(this, value);
      else sandboxDescriptor.get!.call(this).value = String(value);
      sandboxChanged(this);
    },
  });
  for (const method of ["add", "remove", "toggle", "replace"] as const) {
    const native = win.DOMTokenList.prototype[method];
    (win.DOMTokenList.prototype as any)[method] = function (...args: any[]) {
      const result = Reflect.apply(native, this, args);
      const element = sandboxTokens.get(this);
      if (element) sandboxChanged(element);
      return result;
    };
  }
  const tokenValue = Object.getOwnPropertyDescriptor(
    win.DOMTokenList.prototype,
    "value",
  );
  if (tokenValue?.set)
    Object.defineProperty(win.DOMTokenList.prototype, "value", {
      ...tokenValue,
      set(value) {
        tokenValue.set!.call(this, value);
        const element = sandboxTokens.get(this);
        if (element) sandboxChanged(element);
      },
    });
  function load(element: HTMLIFrameElement, value: string) {
    const url = rendererTarget(value, client.url.href, options.fixture);
    if (!url || !alive) return false;
    if (failed.get(element) === url.href) return !!options.reserveNavigation;
    if(options.reserveNavigation && !element.isConnected)return false;
    watchNativeLoad(element);
    if (!bound.has(element) && !(element instanceof win.HTMLIFrameElement)) {
      // Bind only the reviewed renderer element, not arbitrary website nodes.
      Object.defineProperty(
        element,
        "src",
        Object.getOwnPropertyDescriptor(prototype, "src")!,
      );
      Object.defineProperty(element, "setAttribute", {
        value: win.Element.prototype.setAttribute,
        configurable: true,
        writable: true,
      });
      bound.add(element);
    }
    const declared =
      declaredSandbox.get(element) ?? element.getAttribute("sandbox");
    if (declared !== null && declared !== undefined) {
      client.natives.call(
        "Element.prototype.removeAttribute",
        element,
        "runtimekit-attr-sandbox",
      );
      client.natives.call(
        "Element.prototype.setAttribute",
        element,
        "sandbox",
        declared,
      );
      declaredSandbox.delete(element);
    }
    const opaque =
      element.sandbox.contains("allow-scripts") &&
      !element.sandbox.contains("allow-same-origin");
    if (!opaque || pending.size >= 8) return false;
    const version = ++generation;
    staged.delete(element);
    original.set(element, url.href);
    pending.set(element, version);
    if(options.reserveNavigation) {
      // Never publish RuntimeKit's obsolete encoded HTTP iframe src. The only
      // native navigation is the controller-approved exact frontend helper.
      client.natives.call("Element.prototype.removeAttribute",element,"src");
      client.natives.call("Element.prototype.setAttribute",element,"runtimekit-attr-src",url.href);
      if(!element.isConnected) {pending.delete(element);original.delete(element);return true;}
      void options.reserveNavigation(url,element).then(async reservation=>{
        if(!alive||pending.get(element)!==version||!element.isConnected||!element.sandbox.contains("allow-scripts")||element.sandbox.contains("allow-same-origin")){reservation.cancel();return;}
        client.natives.call("Element.prototype.removeAttribute",element,"srcdoc");
        if(element.contentWindow)client.nativeOpaqueWindows.add(element.contentWindow);
        client.natives.call("Element.prototype.setAttribute",element,"src",reservation.helperURL);
        const result=await reservation.ready;
        if(!alive||pending.get(element)!==version||!element.isConnected)return;
        if(element.contentWindow)client.nativeOpaqueWindows.add(element.contentWindow);
        pending.delete(element);options.report("applied",result.resources);
      }).catch(()=>{if(!alive||pending.get(element)!==version)return;pending.delete(element);failed.set(element,url.href);options.report("error",0)});
      return true;
    }
    const initialLoad = settleInitialNativeLoad(element, version);
    void Promise.all([
      options.prepareDocument
        ? options.prepareDocument(url)
        : prepareOpaqueDocument(
            win,
            url,
            options.fetchResource,
            options.fixture,
          ),
      initialLoad,
    ])
      .then(([{ html, resources }]) => {
        if (!alive || pending.get(element) !== version) return;
        if (!element.isConnected) {
          pending.delete(element);
          original.delete(element);
          return;
        }
        if (
          !element.sandbox.contains("allow-scripts") ||
          element.sandbox.contains("allow-same-origin")
        ) {
          failed.set(element, url.href);
          pending.delete(element);
          original.delete(element);
          options.report("error", 0);
          normalSource(element, value);
          return;
        }
        // Preserve the original sandbox string and native opaque-origin boundary.
        setSrcdoc.call(element, html);
        managedSrcdoc.add(element);
        // srcdoc takes precedence; retain source getters without navigating.
        normalSource(element, value);
        if (element.contentWindow)
          client.nativeOpaqueWindows.add(element.contentWindow);
        pending.delete(element);
        options.report("applied", resources);
      })
      .catch((error) => {
        if (!alive || pending.get(element) !== version) return;
        cancelNativeLoad(element, version);
        pending.delete(element);
        original.delete(element);
        failed.set(element, url.href);
        if (managedSrcdoc.has(element)) {
          client.natives.call(
            "Element.prototype.removeAttribute",
            element,
            "srcdoc",
          );
          managedSrcdoc.delete(element);
        }
        options.report("error", 0);
        if (error?.message !== "renderer_initial_navigation_timeout")
          normalSource(element, value);
      });
    return true;
  }
  Object.defineProperty(prototype, "src", {
    ...src,
    get() {
      return (
        original.get(this) ?? staged.get(this)?.href ?? src.get!.call(this)
      );
    },
    set(value) {
      cancelNativeLoad(this);
      staged.delete(this);
      failed.delete(this);
      if (this.contentWindow)
        client.nativeOpaqueWindows.delete(this.contentWindow);
      pending.delete(this);
      original.delete(this);
      if (!load(this, String(value))) {
        if (managedSrcdoc.has(this)) {
          client.natives.call(
            "Element.prototype.removeAttribute",
            this,
            "srcdoc",
          );
          managedSrcdoc.delete(this);
        }
        if (!stageDetachedSource(this, String(value)))
          normalSource(this, String(value));
      }
    },
  });
  const nativeSetAttribute = win.Element.prototype.setAttribute;
  const isFrame = (value: any): value is HTMLIFrameElement =>
    value?.nodeType === 1 &&
    value.localName === "iframe" &&
    value.namespaceURI === "http://www.w3.org/1999/xhtml" &&
    value.ownerDocument === win.document;
  win.Element.prototype.setAttribute = function (name, value) {
    if (isFrame(this) && String(name).toLowerCase() === "sandbox") {
      declaredSandbox.set(this, String(value));
      if (rendererTarget(sourceOf(this), client.url.href, options.fixture)) {
        client.natives.call(
          "Element.prototype.removeAttribute",
          this,
          "runtimekit-attr-sandbox",
        );
        client.natives.call(
          "Element.prototype.setAttribute",
          this,
          "sandbox",
          String(value),
        );
        declaredSandbox.delete(this);
        sandboxChanged(this);
        return;
      }
    }
    if (!bypass && isFrame(this) && String(name).toLowerCase() === "src") {
      cancelNativeLoad(this);
      staged.delete(this);
      if (this.contentWindow)
        client.nativeOpaqueWindows.delete(this.contentWindow);
      pending.delete(this);
      original.delete(this);
      failed.delete(this);
      if (load(this, String(value))) return;
      if (managedSrcdoc.has(this)) {
        client.natives.call(
          "Element.prototype.removeAttribute",
          this,
          "srcdoc",
        );
        managedSrcdoc.delete(this);
      }
      if (stageDetachedSource(this, String(value))) return;
    }
    return nativeSetAttribute.call(this, name, value);
  };
  function inspect(element: HTMLIFrameElement) {
    if (!alive || pending.has(element)) return;
    const value = sourceOf(element, true);
    const previous = original.get(element);
    if (previous && managedSrcdoc.has(element)) {
      let unchanged = false;
      try {
        unchanged = new URL(value, client.url.href).href === previous;
      } catch {
        /* Normal engine path handles unknown destinations. */
      }
      if (unchanged) return;
      // Parser-created element setters can bypass the property wrapper. Remove
      // only our own srcdoc when its actual src changes, so normal navigation wins.
      client.natives.call(
        "Element.prototype.removeAttribute",
        element,
        "srcdoc",
      );
      if (element.contentWindow)
        client.nativeOpaqueWindows.delete(element.contentWindow);
      managedSrcdoc.delete(element);
      original.delete(element);
      failed.delete(element);
    } else if (previous) return;
    load(element, value);
  }
  const observer = new win.MutationObserver((records) => {
    let budget = 64;
    for (const record of records.slice(0, 64)) {
      if (record.type === "attributes" && isFrame(record.target)) {
        if (
          record.attributeName === "src" &&
          record.oldValue !== nativeAttribute(record.target, "src")
        )
          completedNativeLoads.delete(record.target);
        inspect(record.target);
      }
      for (const node of [...record.addedNodes].slice(0, 32)) {
        if (isFrame(node)) {
          if (budget-- > 0) inspect(node);
        } else if (node instanceof win.Element)
          for (const element of [...node.querySelectorAll("iframe")].slice(
            0,
            64,
          )) {
            if (budget-- > 0) inspect(element as HTMLIFrameElement);
          }
      }
      if (budget <= 0) break;
    }
  });
  observer.observe(doc, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["src", "sandbox"],
  });
  const scan = () => {
    if (!alive) return;
    for (const element of [...win.document.querySelectorAll("iframe")].slice(
      0,
      64,
    ))
      inspect(element);
  };
  scan();
  doc.addEventListener("DOMContentLoaded", scan, { once: true });
  // Parser-created children may arrive after the engine's early init hook.
  // One bounded post-parser scan is not a recurring polling loop.
  const scanTimer = setTimeout(scan, 1000);
  const dispose = () => {
    if (!alive) return;
    alive = false;
    pending.clear();
    for (const element of nativeLoadWaiters.keys()) cancelNativeLoad(element);
    observer.disconnect();
    clearTimeout(scanTimer);
    doc.removeEventListener("DOMContentLoaded", scan);
    client.natives.call(
      "EventTarget.prototype.removeEventListener",
      win,
      "message",
      receive,
    );
  };
  win.addEventListener("pagehide", (event) => {
    if (!(event as PageTransitionEvent).persisted) dispose();
  });
  return dispose;
}
