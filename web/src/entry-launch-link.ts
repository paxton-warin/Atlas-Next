export type DocumentAnnouncement = {
  url: string;
  host: string;
  announcementId: string;
};

/** Do not interrupt popouts, support, owner tools, helpers, or embedded pages. */
export function isBrowserEntry(pathname: string, topLevel: boolean) {
  return topLevel && pathname === "/";
}

export function browserDocumentAnnouncement(
  value: unknown,
): DocumentAnnouncement | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Record<string, unknown>;
  if (
    config.browserEnabled !== true ||
    config.acknowledged !== false ||
    typeof config.url !== "string" ||
    typeof config.announcementId !== "string" ||
    !config.announcementId ||
    config.announcementId.length > 256
  )
    return null;
  const text = config.url.trim();
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return {
      url: url.href,
      host: url.host,
      announcementId: config.announcementId,
    };
  } catch {
    return null;
  }
}

/** Once per authenticated identity/document; no opening, polling or local writes.
 * Explicit account acknowledgements live on the Hub, shared with the Hub UI.
 */
export function createDocumentAnnouncementClient(request: typeof fetch) {
  const pending = new Map<string, Promise<DocumentAnnouncement | null>>();
  const dismissed = new Set<string>();
  return {
    load(identity: string) {
      if (!identity || dismissed.has(identity)) return Promise.resolve(null);
      if (!pending.has(identity)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        pending.set(
          identity,
          Promise.resolve()
            .then(() =>
              request("/api/hub/document-announcement", {
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                signal: controller.signal,
              }),
            )
            .then(async (response) =>
              response.ok
                ? browserDocumentAnnouncement(await response.json())
                : null,
            )
            .catch(() => null)
            .finally(() => clearTimeout(timeout)),
        );
      }
      return pending.get(identity)!;
    },
    dismiss(identity: string) {
      dismissed.add(identity);
    },
    async acknowledge(announcement: DocumentAnnouncement, csrf: string) {
      const response = await request("/api/hub/document-announcement/ack", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: {
          "content-type": "application/json",
          "x-atlas-hub-csrf": csrf,
        },
        body: JSON.stringify({ announcementId: announcement.announcementId }),
      });
      const result = await response.json();
      if (
        !response.ok ||
        result.acknowledged !== true ||
        result.announcementId !== announcement.announcementId
      )
        throw new Error("Saving your preference failed. Please try again.");
    },
  };
}
