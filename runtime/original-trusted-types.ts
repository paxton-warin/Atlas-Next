/** Native Trusted Types survive rewriting: original values pass native checks
 * FIRST, then only their rewritten result receives a private, non-default brand.
 * The internal policy never leaves this closure or enters RuntimeKit's client.
 * https://www.w3.org/TR/trusted-types/#get-trusted-type-compliant-string
 */
import type { OriginalDocumentPolicy } from "./original-document-policy.ts";
type TrustedKind = "HTML" | "Script" | "ScriptURL";
type Realm = Window & typeof globalThis;
export function captureOriginalTrustedTypes(global: Realm) {
  const apply = global.Reflect.apply,
    define = global.Object.defineProperty,
    descriptor = global.Object.getOwnPropertyDescriptor,
    nativeString = global.String,
    factory = (global as any).trustedTypes,
    createElement = global.Document.prototype.createElement,
    setAttribute = global.Element.prototype.setAttribute,
    getAttribute = global.Element.prototype.getAttribute,
    parse = global.DOMParser.prototype.parseFromString,
    queryAll = global.Document.prototype.querySelectorAll,
    attributeNames = global.Element.prototype.getAttributeNames,
    write = global.Document.prototype.write,
    textContent = descriptor(global.Node.prototype, "textContent")!,
    scriptText = descriptor(global.HTMLScriptElement.prototype, "text")!,
    scriptSrc = descriptor(global.HTMLScriptElement.prototype, "src")!,
    srcdoc = descriptor(global.HTMLIFrameElement.prototype, "srcdoc")!,
    nativeFunction = global.Function,
    nativeFunctionToString = global.Function.prototype.toString,
    nativeEval = global.eval,
    nativeSetTimeout = global.setTimeout,
    nativeSetInterval = global.setInterval;
  const native = {
    createPolicy: factory?.createPolicy,
    isHTML: factory?.isHTML,
    isScript: factory?.isScript,
    isScriptURL: factory?.isScriptURL,
    getAttributeType: factory?.getAttributeType,
  };
  const make = (tag: string) => apply(createElement, global.document, [tag]);
  const checks = factory
    ? {
        HTML: {
          element: make("iframe"),
          set: srcdoc.set!,
          attribute: "srcdoc",
        },
        Script: {
          element: make("script"),
          set: scriptText.set!,
          get: scriptText.get!,
        },
        ScriptURL: {
          element: make("script"),
          set: scriptSrc.set!,
          attribute: "src",
        },
      }
    : undefined;
  const random = new Uint8Array(16);
  global.crypto.getRandomValues(random);
  const privatePolicy: any = factory
    ? apply(native.createPolicy, factory, [
        "atlas-internal-" +
          [...random].map((v) => v.toString(16).padStart(2, "0")).join(""),
        {
          createHTML: (v: string) => v,
          createScript: (v: string) => v,
          createScriptURL: (v: string) => v,
        },
      ])
    : undefined;
  const privateCreators = privatePolicy && {
    HTML: privatePolicy.createHTML,
    Script: privatePolicy.createScript,
    ScriptURL: privatePolicy.createScriptURL,
  };
  const brand = (kind: TrustedKind, value: string) =>
    privatePolicy
      ? apply(privateCreators![kind], privatePolicy, [value])
      : value;
  let required = false,
    active = false,
    context: { sink: string } | undefined;
  const undo: (() => void)[] = [];
  function string(value: unknown, kind: TrustedKind, sink: string) {
    const checker = checks?.[kind];
    if (!required || !checker) return nativeString(value);
    // A detached native sink performs real brand/default-policy handling,
    // including null returns, exceptions and native type mismatch reporting.
    // It cannot navigate or execute. Its getter preserves the exact compliant
    // value (unlike innerHTML parsing/serialization).
    const prior = context;
    context = { sink };
    try {
      apply(checker.set, checker.element, [value]);
      return "attribute" in checker
        ? (apply(getAttribute, checker.element, [checker.attribute]) ?? "")
        : apply(checker.get, checker.element, []);
    } finally {
      context = prior;
    }
  }
  function replace(target: object, name: string, value: unknown) {
    const old = descriptor(target, name);
    if (old && !old.configurable && !old.writable)
      throw new TypeError("Original Trusted Types sink is not replaceable.");
    define(target, name, { ...old, configurable: true, writable: true, value });
    undo.push(() =>
      old ? define(target, name, old) : Reflect.deleteProperty(target, name),
    );
  }
  const trusted = {
    installEval(
      client: any,
      _global: Realm,
      rewriter: { javascript(source: string, sourceURL?: string): string },
    ) {
      const rewrite = (value: unknown) => {
        if (
          typeof value !== "string" &&
          !(factory && apply(native.isScript, factory, [value]))
        )
          return value;
        const result = rewriter.javascript(
          string(value, "Script", "eval"),
          client.url.href,
        );
        return required ? brand("Script", result) : result;
      };
      define(global, client.config.globals.rewritefn, {
        value: rewrite,
        configurable: false,
        writable: false,
        enumerable: false,
      });
      client.indirectEval = (value: unknown) => {
        const accepted = rewrite(value);
        if (
          typeof accepted !== "string" &&
          !(factory && apply(native.isScript, factory, [accepted]))
        )
          return accepted;
        return apply(nativeEval, global, [accepted]);
      };
    },
    parseFromString(
      this: DOMParser,
      value: string,
      type: DOMParserSupportedType,
    ) {
      return apply(parse, this, [brand("HTML", value), type]);
    },
    setAttribute(this: Element, name: string, value: string) {
      const kind =
        factory &&
        apply(native.getAttributeType, factory, [
          this.localName,
          name,
          this.namespaceURI,
        ]);
      const type =
        kind === "TrustedHTML"
          ? "HTML"
          : kind === "TrustedScript"
            ? "Script"
            : kind === "TrustedScriptURL"
              ? "ScriptURL"
              : undefined;
      return apply(setAttribute, this, [
        name,
        type ? brand(type, value) : value,
      ]);
    },
    setScriptText(element: HTMLScriptElement, value: string) {
      apply(textContent.set!, element, [brand("Script", value)]);
    },
    write(document: Document, value: string) {
      apply(write, document, [brand("HTML", value)]);
    },
    install(options: {
      policy: OriginalDocumentPolicy;
      rewriter: {
        html(source: string): string;
        javascript(
          source: string,
          sourceURL?: string,
          isModule?: boolean,
        ): string;
      };
    }) {
      if (active)
        throw new TypeError("Original Trusted Types is already installed.");
      active = true;
      required = options.policy.trustedTypes.required;
      if (!factory) {
        if (required)
          throw Object.assign(
            new DOMException(
              "Native Trusted Types is required.",
              "NotSupportedError",
            ),
            { code: "original_trusted_types_unavailable" },
          );
        return;
      }
      // Native createPolicy still owns name restrictions, duplicates, native
      // brands, options conversion and actual CSP violation dispatch. Only the
      // default callback's sink label is rebound during our detached check.
      const factoryPrototype = global.Object.getPrototypeOf(factory);
      replace(
        factoryPrototype,
        "createPolicy",
        function (this: unknown, name: unknown, rules: any) {
          const policyName = nativeString(name);
          if (this !== factory || policyName !== "default")
            return apply(native.createPolicy, this, [name, rules]);
          const dictionary = rules == null ? {} : Object(rules);
          const callbacks = new Proxy(dictionary, {
            get(target, key) {
              const callback = Reflect.get(target, key, target);
              if (
                !["createHTML", "createScript", "createScriptURL"].includes(
                  String(key),
                ) ||
                typeof callback !== "function"
              )
                return callback;
              return function (this: unknown, ...args: unknown[]) {
                if (context && args.length >= 3) args[2] = context.sink;
                return apply(callback, this, args);
              };
            },
          });
          return apply(native.createPolicy, this, [name, callbacks]);
        },
      );
      if (!required) return;
      const rewriter = options.rewriter,
        htmlSource = (source: string) => {
          // Trusted Types and original CSP are independent. A policy-created
          // TrustedHTML is not an exemption for inline handler/JavaScript-URL
          // sinks which this runtime has not qualified. Parse inertly with the
          // same captured native sink, before any rewritten live-DOM mutation.
          const inert = apply(parse, new global.DOMParser(), [
            brand("HTML", source),
            "text/html",
          ]);
          for (const element of apply(queryAll, inert, [
            "*",
          ]) as NodeListOf<Element>)
            for (const name of apply(attributeNames, element, []) as string[]) {
              const value = apply(getAttribute, element, [name]) || "";
              if (
                /^on/i.test(name) ||
                /^[\u0000-\u0020]*javascript\s*:/i.test(value)
              )
                throw new DOMException(
                  "This original document attribute sink is not qualified.",
                  "NotSupportedError",
                );
              if (name.toLowerCase() === "style")
                options.policy.authorizeStyleAttribute(value);
            }
          return rewriter.html(source);
        },
        scriptSource = (element: Element, source: string) => {
          const bytes = new global.TextEncoder().encode(source),
            encoded = global.btoa(global.String.fromCharCode(...bytes));
          apply(setAttribute, element, [
            "runtimekit-attr-script-source-src",
            encoded,
          ]);
          const module = apply(getAttribute, element, ["type"]) === "module";
          return rewriter.javascript(
            source,
            options.policy.documentURL,
            module,
          );
        };
      function setter(
        prototype: object,
        property: string,
        kind: TrustedKind,
        sink: string,
        transform: (element: Element, value: string) => string,
      ) {
        const original = descriptor(prototype, property);
        if (!original?.set || !original.configurable) return;
        const raw =
          property === "innerHTML" || property === "outerHTML"
            ? descriptor(global.Element.prototype, property)!.set!
            : property === "text"
              ? scriptText.set!
              : textContent.set!;
        // Capture the native HTML setters from the pre-hook table below, never
        // RuntimeKit's already-stringifying wrappers.
        const nativeSetter = htmlSetters.get(property) ?? raw;
        define(prototype, property, {
          ...original,
          set: function (this: Element, value: unknown) {
            if (
              (property === "textContent" || property === "innerText") &&
              this.localName !== "script"
            )
              return apply(original.set!, this, [value]);
            const accepted = string(value, kind, sink);
            return apply(nativeSetter, this, [
              brand(kind, transform(this, accepted)),
            ]);
          },
        });
        undo.push(() => define(prototype, property, original));
      }
      setter(
        global.Element.prototype,
        "innerHTML",
        "HTML",
        "Element innerHTML",
        (element, value) =>
          element.localName === "script"
            ? scriptSource(element, value)
            : htmlSource(value),
      );
      setter(
        global.Element.prototype,
        "outerHTML",
        "HTML",
        "Element outerHTML",
        (_element, value) => htmlSource(value),
      );
      setter(
        global.HTMLScriptElement.prototype,
        "text",
        "Script",
        "HTMLScriptElement text",
        scriptSource,
      );
      setter(
        global.Node.prototype,
        "textContent",
        "Script",
        "HTMLScriptElement textContent",
        scriptSource,
      );
      // RuntimeKit defines a shadowing script-specific descriptor as well.
      setter(
        global.HTMLScriptElement.prototype,
        "textContent",
        "Script",
        "HTMLScriptElement textContent",
        scriptSource,
      );
      const previousSet = global.Element.prototype.setAttribute;
      replace(
        global.Element.prototype,
        "setAttribute",
        function (this: Element, name: string, value: unknown) {
          const type = apply(native.getAttributeType, factory, [
            this.localName,
            nativeString(name).toLowerCase(),
            this.namespaceURI,
          ]);
          if (type === "TrustedScriptURL" && this.localName === "script")
            return apply(previousSet, this, [
              name,
              brand(
                "ScriptURL",
                string(value, "ScriptURL", "HTMLScriptElement src"),
              ),
            ]);
          if (type === "TrustedScript" || type === "TrustedHTML")
            throw new DOMException(
              "This original document attribute sink is not qualified.",
              "NotSupportedError",
            );
          return apply(previousSet, this, [name, value]);
        },
      );
      const previousSrc = descriptor(
        global.HTMLScriptElement.prototype,
        "src",
      )!;
      define(global.HTMLScriptElement.prototype, "src", {
        ...previousSrc,
        set(this: HTMLScriptElement, value: unknown) {
          return apply(previousSrc.set!, this, [
            brand(
              "ScriptURL",
              string(value, "ScriptURL", "HTMLScriptElement src"),
            ),
          ]);
        },
      });
      undo.push(() =>
        define(global.HTMLScriptElement.prototype, "src", previousSrc),
      );
      for (const [prototype, name, index, sink] of [
        [
          global.Element.prototype,
          "insertAdjacentHTML",
          1,
          "Element insertAdjacentHTML",
        ],
        [
          global.DOMParser.prototype,
          "parseFromString",
          0,
          "DOMParser parseFromString",
        ],
        [
          global.Range.prototype,
          "createContextualFragment",
          0,
          "Range createContextualFragment",
        ],
      ] as const) {
        const raw = htmlMethods.get(name);
        if (!raw) continue;
        replace(prototype, name, function (this: unknown, ...args: unknown[]) {
          args[index] = brand(
            "HTML",
            htmlSource(string(args[index], "HTML", sink)),
          );
          return apply(raw, this, args);
        });
      }
      // Keep native eval/Function sink enforcement rather than changing trusted
      // scripts back to strings in the stock RuntimeKit compilation hooks.
      replace(
        global,
        "Function",
        new Proxy(nativeFunction, {
          apply(_target, thisArg, args) {
            const checked = apply(nativeFunction, thisArg, args),
              source = apply(nativeFunctionToString, checked, []);
            return apply(nativeFunction, global, [
              brand(
                "Script",
                rewriter.javascript(
                  "return " + source,
                  options.policy.documentURL,
                ),
              ),
            ])();
          },
          construct(target, args, newTarget) {
            const checked = global.Reflect.construct(target, args, newTarget),
              source = apply(nativeFunctionToString, checked, []);
            return apply(nativeFunction, global, [
              brand(
                "Script",
                rewriter.javascript(
                  "return " + source,
                  options.policy.documentURL,
                ),
              ),
            ])();
          },
        }),
      );
      for (const [name, fn] of [
        ["setTimeout", nativeSetTimeout],
        ["setInterval", nativeSetInterval],
      ] as const)
        replace(global, name, function (...args: unknown[]) {
          if (typeof args[0] !== "function")
            args[0] = brand(
              "Script",
              rewriter.javascript(
                string(args[0], "Script", "Window " + name),
                options.policy.documentURL,
              ),
            );
          return apply(fn, global, args);
        });
    },
    dispose() {
      for (const restore of undo.splice(0).reverse()) restore();
    },
  };
  const htmlSetters = new Map<string, Function>();
  for (const property of ["innerHTML", "outerHTML"])
    htmlSetters.set(
      property,
      descriptor(global.Element.prototype, property)!.set!,
    );
  const htmlMethods = new Map<string, Function>([
    ["insertAdjacentHTML", global.Element.prototype.insertAdjacentHTML],
    ["parseFromString", parse],
    [
      "createContextualFragment",
      global.Range.prototype.createContextualFragment,
    ],
  ]);
  return trusted;
}
