// Keep icon requests in the browsing runtime. Only a small raster image crosses
// the app bridge; the app never fetches a website or a favicon lookup service.
export function watchFavicon(
  doc: Document,
  proxyUrl: (url: string) => string,
  publish: (png: string) => void,
  fetchIcon: typeof fetch = fetch,
) {
  let disposed = false;
  let signature = "";
  let pending: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const href = Object.getOwnPropertyDescriptor(
    HTMLLinkElement.prototype,
    "href",
  )!.get!;
  const attr = Element.prototype.getAttribute;
  async function scan() {
    const links = [...doc.querySelectorAll<HTMLLinkElement>("link[rel][href]")];
    const icons = links.filter((link) =>
      /(?:^|\s)icon(?:\s|$)/i.test(attr.call(link, "rel") || ""),
    );
    const touch = links.filter((link) =>
      /^apple-touch-icon(?:-precomposed)?$/i.test(attr.call(link, "rel") || ""),
    );
    const candidates = [...icons, ...touch]
      .slice(0, 4)
      .map((link) => href.call(link) as string);
    candidates.push("/favicon.ico");
    const key = JSON.stringify(candidates);
    if (key === signature || disposed) return;
    signature = key;
    pending?.abort();
    const request = (pending = new AbortController());
    publish("");
    for (const candidate of candidates) {
      if (request.signal.aborted || disposed) return;
      const timeout = setTimeout(() => request.abort(), 8000);
      let objectUrl = "";
      try {
        const response = await fetchIcon(proxyUrl(candidate), {
          signal: request.signal,
          credentials: "same-origin",
          redirect: "follow",
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          continue;
        }
        const mime = (response.headers.get("content-type") || "")
          .split(";")[0]
          .trim();
        if (
          !/^image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i.test(
            mime,
          )
        ) {
          await response.body.cancel();
          continue;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let bytes = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 256 * 1024) throw Error("Icon too large");
            chunks.push(new Uint8Array(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const icon = new Image();
        objectUrl = URL.createObjectURL(new Blob(chunks, { type: mime }));
        icon.src = objectUrl;
        await Promise.race([
          icon.decode(),
          new Promise<never>((_, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(Error("Icon canceled")),
              { once: true },
            ),
          ),
        ]);
        if (
          !icon.naturalWidth ||
          !icon.naturalHeight ||
          request.signal.aborted ||
          disposed
        )
          return;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const context = canvas.getContext("2d")!;
        const scale = Math.min(32 / icon.naturalWidth, 32 / icon.naturalHeight);
        const width = icon.naturalWidth * scale,
          height = icon.naturalHeight * scale;
        context.drawImage(
          icon,
          (32 - width) / 2,
          (32 - height) / 2,
          width,
          height,
        );
        const png = canvas.toDataURL("image/png");
        if (png.length <= 16384) publish(png);
        return;
      } catch {
        // Missing/broken icons leave the normal globe, without a broken image.
      } finally {
        clearTimeout(timeout);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    }
  }
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), 120);
  });
  observer.observe(doc.head || doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["href", "rel"],
  });
  void scan();
  return () => {
    disposed = true;
    observer.disconnect();
    clearTimeout(timer);
    pending?.abort();
  };
}
