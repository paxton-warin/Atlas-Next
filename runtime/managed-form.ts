type ManagedFormTarget = {
  window: Window;
  pageUrl: string;
  encode: (url: string) => string;
};

// Only the owning runtime calls this helper with one of its actual iframe Windows.
// Keep form data in its trusted document, never in an untrusted target document.
export function createManagedFormSubmitter(host: Window & typeof globalThis) {
  const document = host.document;
  const name = Object.getOwnPropertyDescriptor(host, "name")!;
  const nativeSubmit = host.HTMLFormElement.prototype.submit;
  const setAttribute = host.Element.prototype.setAttribute;
  return (
    form: HTMLFormElement,
    submitter: HTMLElement | null | undefined,
    target: ManagedFormTarget,
  ) => {
    const button = submitter as HTMLButtonElement | HTMLInputElement | null;
    const effective = (
      attribute: string,
      buttonValue: string | undefined,
      formValue: string,
    ) => (button?.hasAttribute(attribute) ? buttonValue! : formValue);
    // The engine restores URL attributes, but not the camel-case formAction getter.
    const action = button?.hasAttribute("formaction")
      ? button.getAttribute("formaction")!
      : form.getAttribute("action") || target.pageUrl;
    const submitted = document.createElement("form");
    submitted.action = target.encode(
      new URL(action || target.pageUrl, form.baseURI || target.pageUrl).href,
    );
    submitted.method = effective("formmethod", button?.formMethod, form.method);
    submitted.enctype = effective(
      "formenctype",
      button?.formEnctype,
      form.enctype,
    );
    submitted.acceptCharset = form.acceptCharset || "UTF-8";
    submitted.hidden = true;
    // This also runs the original form's formdata listeners before choosing the
    // native target name, so their synchronous changes cannot stale the target.
    for (const [field, value] of new host.FormData(form, button)) {
      const input = document.createElement("input");
      input.name = field;
      if (typeof value === "string") {
        input.type = "hidden";
        input.value = value;
      } else {
        input.type = "file";
        const transfer = new host.DataTransfer();
        transfer.items.add(value);
        input.files = transfer.files;
      }
      submitted.append(input);
    }
    document.body.append(submitted);
    // iframe.name can be stale after a page changes window.name. Resolve the
    // actual Window to a unique native name only for synchronous target selection;
    // restore its original name immediately, including empty names and clobbers.
    const previous = name.get!.call(target.window);
    const alias = "atlas-form-" + host.crypto.randomUUID();
    setAttribute.call(submitted, "target", alias);
    try {
      name.set!.call(target.window, alias);
      nativeSubmit.call(submitted);
    } finally {
      if (name.get!.call(target.window) === alias)
        name.set!.call(target.window, previous);
      host.setTimeout(() => submitted.remove(), 0);
    }
  };
}
