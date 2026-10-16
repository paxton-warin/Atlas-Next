/** Virtual self-target forms. Native submission stays denied by the physical
 * sandbox/CSP; successful controls travel only over the original private port. */
import {
  FORM_NAVIGATION_BYTES,
  type FormNavigation,
} from "./form-navigation.ts";
import type { OriginalDocumentPolicy } from "./original-document-policy.ts";
type Owner = Window & typeof globalThis;
const unsupported = (code: string) =>
  new DOMException(code, "NotSupportedError");
export function captureOpaqueFormNatives(w: Owner) {
  const descriptor = (p: object, k: string) =>
    Object.getOwnPropertyDescriptor(p, k)!;
  const iterator = new w.FormData().entries();
  return {
    get: w.Element.prototype.getAttribute,
    has: w.Element.prototype.hasAttribute,
    matches: w.Element.prototype.matches,
    dispatch: w.EventTarget.prototype.dispatchEvent,
    FormData: w.FormData,
    Request: w.Request,
    URLSearchParams: w.URLSearchParams,
    entries: w.FormData.prototype.entries,
    next: Object.getPrototypeOf(iterator).next,
    requestBytes: w.Request.prototype.arrayBuffer,
    requestHeaders: descriptor(w.Request.prototype, "headers").get!,
    headerGet: w.Headers.prototype.get,
    blobSize: descriptor(w.Blob.prototype, "size").get!,
    fileName: descriptor(w.File.prototype, "name").get!,
    elements: descriptor(w.HTMLFormElement.prototype, "elements").get!,
    reportValidity: w.HTMLFormElement.prototype.reportValidity,
    buttonForm: descriptor(w.HTMLButtonElement.prototype, "form").get!,
    inputForm: descriptor(w.HTMLInputElement.prototype, "form").get!,
    buttonType: descriptor(w.HTMLButtonElement.prototype, "type").get!,
    inputType: descriptor(w.HTMLInputElement.prototype, "type").get!,
    defaultPrevented: descriptor(w.Event.prototype, "defaultPrevented").get!,
    eventTarget: descriptor(w.Event.prototype, "target").get!,
    key: descriptor(w.KeyboardEvent.prototype, "key").get!,
    SubmitEvent: w.SubmitEvent,
    Event: w.Event,
    TextEncoder: w.TextEncoder,
    add: w.addEventListener.bind(w),
    remove: w.removeEventListener.bind(w),
    later: w.setTimeout.bind(w),
  };
}
export function installOpaqueForms(options: {
  window: Owner;
  documentURL: string;
  baseURL: string;
  forbiddenOrigins?: readonly string[];
  natives: ReturnType<typeof captureOpaqueFormNatives>;
  restoreURL: (value: string) => string;
  policy?: OriginalDocumentPolicy;
  liveDocument: () => boolean;
  navigate: (navigation: FormNavigation) => void;
}) {
  const w = options.window,
    n = options.natives,
    doc = new URL(options.documentURL),
    base = new URL(options.baseURL);
  const restorers: (() => void)[] = [],
    submitting = new WeakSet<HTMLFormElement>();
  const forbidden = new Set(
    (options.forbiddenOrigins ?? []).map((value) => new URL(value).hostname),
  );
  let live = true;
  const original = (e: Element, key: string) =>
    n.get.call(e, "runtimekit-attr-" + key) ?? n.get.call(e, key);
  const value = (e: Element, key: string) => original(e, key) ?? "";
  const crlf = (value: string) => value.replace(/\r\n|\r|\n/g, "\r\n");
  const fieldText = (v: FormDataEntryValue) =>
    typeof v === "string" ? v : n.fileName.call(v);
  const encode = (text: string) => new n.TextEncoder().encode(text);
  function replace(
    target: object,
    key: string,
    descriptor: PropertyDescriptor,
  ) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    if (!previous?.configurable)
      throw unsupported("form_native_descriptor_unavailable");
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: previous.enumerable,
      ...descriptor,
    });
    restorers.push(() => Object.defineProperty(target, key, previous));
  }
  const formOf = (e: Element) =>
    e instanceof w.HTMLButtonElement
      ? n.buttonForm.call(e)
      : e instanceof w.HTMLInputElement
        ? n.inputForm.call(e)
        : null;
  const type = (e: Element) =>
    e instanceof w.HTMLButtonElement
      ? n.buttonType.call(e)
      : e instanceof w.HTMLInputElement
        ? n.inputType.call(e)
        : "";
  const submitter = (e: Element) =>
    (e instanceof w.HTMLButtonElement && type(e) === "submit") ||
    (e instanceof w.HTMLInputElement && ["submit", "image"].includes(type(e)));
  function attributes(form: HTMLFormElement, button?: HTMLElement | null) {
    const chosen = (field: string) =>
      button && n.has.call(button, "form" + field)
        ? value(button, "form" + field)
        : value(form, field);
    const action = chosen("action"),
      target =
        chosen("target") ||
        value(w.document.querySelector("base[target]") ?? form, "target");
    if (target && target.toLowerCase() !== "_self")
      throw unsupported("form_target_unsupported");
    const method = chosen("method").toLowerCase();
    if (method === "dialog") throw unsupported("form_dialog_unsupported");
    const charset = value(form, "accept-charset").trim();
    if (charset && !/^utf-?8$/i.test(charset))
      throw unsupported("form_encoding_unsupported");
    const url = action
      ? new URL(options.restoreURL(action), base)
      : new URL(doc);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      forbidden.has(url.hostname)
    )
      throw new DOMException("form_destination_denied", "SecurityError");
    options.policy?.checkURL({ url: url.href, kind: "form" });
    const enctype = chosen("enctype").toLowerCase();
    return {
      url,
      method: method === "post" ? ("POST" as const) : ("GET" as const),
      enctype: ["multipart/form-data", "text/plain"].includes(enctype)
        ? enctype
        : "application/x-www-form-urlencoded",
    };
  }
  async function serialize(
    form: HTMLFormElement,
    button?: HTMLElement | null,
  ): Promise<FormNavigation> {
    const fields = attributes(form, button);
    const data = button ? new n.FormData(form, button) : new n.FormData(form);
    const it = n.entries.call(data),
      pairs: [string, FormDataEntryValue][] = [];
    let bytes = 0;
    for (;;) {
      const item = n.next.call(it);
      if (item.done) break;
      const [name, value] = item.value;
      if (pairs.length >= 2048)
        throw new DOMException("form_entry_limit", "QuotaExceededError");
      bytes +=
        encode(name).byteLength +
        (typeof value === "string"
          ? encode(value).byteLength
          : n.blobSize.call(value) + encode(n.fileName.call(value)).byteLength);
      if (bytes > FORM_NAVIGATION_BYTES)
        throw new DOMException("form_body_limit", "QuotaExceededError");
      pairs.push([name, value]);
    }
    const params = new n.URLSearchParams();
    for (const [name, value] of pairs)
      params.append(crlf(name), crlf(fieldText(value)));
    if (fields.method === "GET") {
      fields.url.search = params.toString();
      if (fields.url.href.length > 16384)
        throw new DOMException("form_url_limit", "QuotaExceededError");
      return { url: fields.url.href, method: "GET" };
    }
    let body: ArrayBuffer,
      contentType = fields.enctype;
    if (fields.enctype === "multipart/form-data") {
      const request = new n.Request(fields.url, { method: "POST", body: data });
      contentType = n.headerGet.call(
        n.requestHeaders.call(request),
        "content-type",
      )!;
      body = await n.requestBytes.call(request);
    } else {
      const text =
        fields.enctype === "text/plain"
          ? pairs
              .map(
                ([name, value]) =>
                  crlf(name) + "=" + crlf(fieldText(value)) + "\r\n",
              )
              .join("")
          : params.toString();
      body = encode(text).buffer as ArrayBuffer;
    }
    if (body.byteLength > FORM_NAVIGATION_BYTES)
      throw new DOMException("form_body_limit", "QuotaExceededError");
    return { url: fields.url.href, method: "POST", contentType, body };
  }
  function report(form: HTMLFormElement, error: unknown) {
    if (!live || !options.liveDocument()) return;
    // No exception text/URL/body is reflected into the trusted controller.
    n.dispatch.call(form, new n.Event("error"));
    try {
      w.reportError(error);
    } catch {}
  }
  function submit(
    form: HTMLFormElement,
    button: HTMLElement | null,
    request: boolean,
  ) {
    if (!(form instanceof w.HTMLFormElement))
      throw new TypeError("Illegal invocation");
    if (button && (!submitter(button) || formOf(button) !== form))
      throw new DOMException(
        "Submitter does not belong to form",
        "NotFoundError",
      );
    if (!live || !options.liveDocument() || submitting.has(form)) return;
    if (button && type(button) === "image")
      throw unsupported("form_image_submitter_unsupported");
    // Sandbox-native requestSubmit does not dispatch submit at all. Keep the
    // validation/cancelable event ordering in this explicit virtual algorithm.
    if (
      request &&
      !n.has.call(form, "novalidate") &&
      !(button && n.has.call(button, "formnovalidate")) &&
      !n.reportValidity.call(form)
    )
      return;
    submitting.add(form);
    if (
      request &&
      !n.dispatch.call(
        form,
        new n.SubmitEvent("submit", {
          bubbles: true,
          cancelable: true,
          submitter: button,
        }),
      )
    ) {
      submitting.delete(form);
      return;
    }
    void serialize(form, button)
      .then((navigation) => {
        if (live && options.liveDocument()) options.navigate(navigation);
      })
      .catch((error) => report(form, error))
      .finally(() => submitting.delete(form));
  }
  replace(w.HTMLFormElement.prototype, "submit", {
    writable: true,
    value: function (this: HTMLFormElement) {
      submit(this, null, false);
    },
  });
  replace(w.HTMLFormElement.prototype, "requestSubmit", {
    writable: true,
    value: function (this: HTMLFormElement, button?: HTMLElement) {
      submit(this, button ?? null, true);
    },
  });
  const click = (event: Event) => {
    const target = n.eventTarget.call(event);
    if (!(target instanceof w.Element)) return;
    let button: Element | null = target;
    while (button && !submitter(button)) button = button.parentElement;
    if (!button || n.matches.call(button, ":disabled")) return;
    const form = formOf(button),
      chosen = button;
    if (!form) return;
    n.later(() => {
      if (!n.defaultPrevented.call(event)) {
        try {
          submit(form, chosen as HTMLElement, true);
        } catch (error) {
          report(form, error);
        }
      }
    }, 0);
  };
  const enter = (event: KeyboardEvent) => {
    if (n.key.call(event) !== "Enter") return;
    const input = n.eventTarget.call(event);
    if (
      !(input instanceof w.HTMLInputElement) ||
      !["text", "search", "tel", "url", "email", "password", "number"].includes(
        type(input),
      )
    )
      return;
    const form = formOf(input);
    if (!form) return;
    const elements = Array.from(n.elements.call(form)) as Element[],
      button = elements.find(submitter);
    if (button && n.matches.call(button, ":disabled")) return;
    if (
      !button &&
      elements.filter(
        (e) =>
          e instanceof w.HTMLInputElement &&
          [
            "text",
            "search",
            "tel",
            "url",
            "email",
            "password",
            "number",
          ].includes(type(e)),
      ).length > 1
    )
      return;
    n.later(() => {
      if (!n.defaultPrevented.call(event)) {
        try {
          submit(form, (button as HTMLElement) ?? null, true);
        } catch (error) {
          report(form, error);
        }
      }
    }, 0);
  };
  n.add("click", click, true);
  n.add("keydown", enter as EventListener, true);
  // Physical base URLs never point at frontend resources. The logical value is
  // fixed by the trusted first-base plan; mutation is an explicit unsupported path.
  replace(w.Node.prototype, "baseURI", {
    get() {
      return base.href;
    },
  });
  replace(w.HTMLBaseElement.prototype, "href", {
    get: function (this: HTMLBaseElement) {
      const href = original(this, "href");
      return href === null ? "" : new URL(options.restoreURL(href), doc).href;
    },
    set() {
      throw unsupported("dynamic_base_unsupported");
    },
  });
  const previousSet = w.Element.prototype.setAttribute,
    previousRemove = w.Element.prototype.removeAttribute;
  replace(w.Element.prototype, "setAttribute", {
    writable: true,
    value: function (this: Element, key: string, v: string) {
      if (
        this instanceof w.HTMLBaseElement &&
        String(key).toLowerCase() === "href"
      )
        throw unsupported("dynamic_base_unsupported");
      return previousSet.call(this, key, v);
    },
  });
  replace(w.Element.prototype, "removeAttribute", {
    writable: true,
    value: function (this: Element, key: string) {
      if (
        this instanceof w.HTMLBaseElement &&
        String(key).toLowerCase() === "href"
      )
        throw unsupported("dynamic_base_unsupported");
      return previousRemove.call(this, key);
    },
  });
  return {
    dispose() {
      if (!live) return;
      live = false;
      n.remove("click", click, true);
      n.remove("keydown", enter as EventListener, true);
      for (const restore of restorers.reverse()) restore();
    },
  };
}
