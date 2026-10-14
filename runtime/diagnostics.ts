export type DiagnosticEntry = {
  at: number;
  event: string;
  origin?: string;
  category?: string;
  method?: string;
  status?: number;
  cookies?: number;
  credentialed?: boolean;
  destination?: string;
  context?: "embedded" | "top-level";
  revision?: string;
  state?: string;
};
export function requestCategory(value: string): string {
  try {
    const path = new URL(value).pathname;
    if (/auth|login|session|callback|oauth/i.test(path))
      return "authentication";
    if (/license|widevine|drm/i.test(path)) return "license";
    if (/\.m3u8$|\.mpd$|\.m4s$|\.mp4$|\/media\//i.test(path)) return "media";
  } catch {
    /* No raw URLs in reports. */
  }
  return "resource";
}
export class DiagnosticLog {
  private entries: DiagnosticEntry[] = [];
  private started = 0;
  private enabled = false;
  enable(value: boolean) {
    this.enabled = value;
    this.entries = [];
    this.started = Date.now();
  }
  active() {
    return this.enabled && Date.now() - this.started < 300000;
  }
  record(event: string, fields: Partial<DiagnosticEntry> = {}) {
    if (
      !this.active() ||
      ![
        "request",
        "response",
        "navigation",
        "document",
        "worker",
        "media",
        "error",
      ].includes(event)
    )
      return;
    const entry: DiagnosticEntry = { at: Date.now() - this.started, event };
    if (["embedded", "top-level"].includes(fields.context || ""))
      entry.context = fields.context;
    if (/^[a-f0-9]{7,40}$/.test(fields.revision || ""))
      entry.revision = fields.revision;
    if (
      [
        "installing",
        "installed",
        "activating",
        "activated",
        "redundant",
        "missing",
      ].includes(fields.state || "")
    )
      entry.state = fields.state;
    if (fields.origin) {
      try {
        entry.origin = new URL(fields.origin).origin;
      } catch {}
    }
    if (
      ["authentication", "license", "media", "resource"].includes(
        fields.category || "",
      )
    )
      entry.category = fields.category;
    if (
      ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        fields.method || "",
      )
    )
      entry.method = fields.method;
    if (
      Number.isInteger(fields.status) &&
      fields.status! >= 100 &&
      fields.status! <= 599
    )
      entry.status = fields.status;
    if (Number.isInteger(fields.cookies) && fields.cookies! >= 0)
      entry.cookies = Math.min(100, fields.cookies!);
    if (typeof fields.credentialed === "boolean")
      entry.credentialed = fields.credentialed;
    if (
      [
        "document",
        "iframe",
        "script",
        "style",
        "image",
        "font",
        "video",
        "audio",
        "worker",
        "websocket",
        "",
      ].includes(fields.destination || "")
    )
      entry.destination = fields.destination;
    this.entries.push(entry);
    if (this.entries.length > 128) this.entries.shift();
  }
  snapshot() {
    return {
      version: 1,
      active: this.active(),
      entries: this.entries.map((e) => ({ ...e })),
    };
  }
}
