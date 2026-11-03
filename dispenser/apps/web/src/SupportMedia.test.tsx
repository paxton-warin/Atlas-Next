import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SupportMediaList,
  SupportMediaPicker,
  encodeSupportFiles,
  validateSupportFiles,
  SUPPORT_FILE_LIMIT,
  SUPPORT_MESSAGE_LIMIT,
  supportImageFit,
  supportImageZoom,
} from "./SupportMedia";
import { filterUserTickets, filterAdminTickets } from "./HubSupport";

const file = (name: string, type = "image/png", size = 12) => ({ name, type, size });
afterEach(() => vi.unstubAllGlobals());
describe("Support media and previous tickets", () => {
  it("fits camera images inside narrow viewers without upscaling or a 10-percent floor", () => {
    const scale = supportImageFit(5712, 4284, 272, 550);
    expect(scale).toBeLessThan(0.1);
    expect(5712 * scale).toBeLessThanOrEqual(272);
    expect(4284 * scale).toBeLessThanOrEqual(550);
    expect(supportImageFit(100, 80, 1000, 800)).toBe(1);
    expect(supportImageFit(0, 80, 1000, 800)).toBe(1);
    expect(supportImageFit(NaN, 80, 1000, 800)).toBe(1);
  });
  it("bounds zoom while allowing the fitted small-image scale", () => {
    expect(supportImageZoom(20)).toBe(4);
    expect(supportImageZoom(0)).toBe(0.1);
    expect(supportImageZoom(0, 0.025)).toBe(0.025);
    expect(supportImageZoom(0.05, 0.025)).toBe(0.05);
    expect(supportImageZoom(NaN)).toBe(1);
    expect(supportImageZoom(0, NaN)).toBe(0.1);
  });
  it("renders an inline image placeholder rather than a manual View gate", () => {
    const load = vi.fn();
    const markup = renderToStaticMarkup(<SupportMediaList attachments={[{ id: "photo", name: "test.png", mimeType: "image/png", size: 2000 }]} load={load} />);
    expect(markup).toContain("support-media-image");
    expect(markup).toContain("support-image-placeholder");
    expect(markup).not.toContain('aria-label="View test.png"');
    expect(markup).not.toContain("<dialog");
    expect(load).not.toHaveBeenCalled();
    const inactive = renderToStaticMarkup(<SupportMediaList active={false} attachments={[{ id: "photo", name: "test.png", mimeType: "image/png", size: 2000 }]} load={load} />);
    expect(inactive).toContain("support-image-placeholder");
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps closed tickets out of the active list without deleting history", () => {
    const tickets = [
      { id: "open", subject: "Open", status: "open", unread: 0, updated_at: "now" },
      { id: "awaiting", subject: "Awaiting", status: "awaiting_you", unread: 1, updated_at: "now" },
      { id: "closed", subject: "Closed", status: "closed", unread: 0, updated_at: "now" },
    ];
    expect(filterUserTickets(tickets).map(ticket => ticket.id)).toEqual(["open", "awaiting"]);
    expect(filterUserTickets(tickets, true).map(ticket => ticket.id)).toEqual(["closed"]);
    expect(filterAdminTickets(tickets, "all", "all", "")).toHaveLength(3);
    expect(tickets).toHaveLength(3);
  });
  it("bounds file count, individual and aggregate bytes before any reads", () => {
    expect(validateSupportFiles([file("a.png", "image/png", SUPPORT_FILE_LIMIT)])).toBe("");
    expect(validateSupportFiles([file("a.png", "image/png", SUPPORT_FILE_LIMIT + 1)])).toMatch("10 MiB");
    expect(validateSupportFiles([file("a.png", "image/png", 0)])).toMatch("empty");
    expect(validateSupportFiles(Array.from({ length: 4 }, (_, index) => file(index + ".png")))).toMatch("3 files");
    expect(validateSupportFiles([file("a.png", "image/png", SUPPORT_MESSAGE_LIMIT / 2), file("b.png", "image/png", SUPPORT_MESSAGE_LIMIT / 2), file("c.png")])).toMatch("20 MiB");
  });
  it("allows raster images and supported audio/video but rejects active documents", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm", "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/x-m4a", "audio/x-wav"]) expect(validateSupportFiles([file("media", mime)])).toBe("");
    for (const mime of ["image/svg+xml", "text/html", "application/javascript", ""]) expect(validateSupportFiles([file("document", mime)])).not.toBe("");
  });
  it("renders accessible attachment selection and removals without reading file bytes", () => {
    const markup = renderToStaticMarkup(<SupportMediaPicker files={[file("<screenshot>.png") as File]} onChange={() => {}} />);
    expect(markup).toContain('type="file"');
    expect(markup).toContain('aria-label="Choose support media"');
    expect(markup).toContain('aria-label="Remove &lt;screenshot&gt;.png"');
    expect(markup).toContain("10 MiB each, 20 MiB per message, 100 MiB per account");
    expect(markup).not.toContain("data:");
  });
  it("does not fetch attachment bytes or create media players until explicitly opened", () => {
    const load = vi.fn();
    const markup = renderToStaticMarkup(<SupportMediaList attachments={[{ id: "media-id", name: "recording.webm", mimeType: "video/webm", size: 2000 }]} load={load} />);
    expect(markup).toContain('aria-label="View recording.webm"');
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("<audio");
    expect(markup).not.toContain("<img");
    expect(load).not.toHaveBeenCalled();
  });
  it("encodes attachments sequentially only on explicit submission and normalizes aliases", async () => {
    const reads: string[] = [];
    class Reader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(value: File) {
        reads.push(value.name);
        this.result = "data:audio/mp4;base64,AQID";
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("FileReader", Reader);
    expect(await encodeSupportFiles([file("clip.m4a", "audio/x-m4a", 3) as File, file("second.png") as File])).toEqual([
      { name: "clip.m4a", mimeType: "audio/mp4", dataBase64: "AQID" },
      { name: "second.png", mimeType: "image/png", dataBase64: "AQID" },
    ]);
    expect(reads).toEqual(["clip.m4a", "second.png"]);
  });
  it("fails invalid uploads before FileReader starts", async () => {
    const reader = vi.fn();
    vi.stubGlobal("FileReader", reader);
    await expect(encodeSupportFiles([file("unsafe.svg", "image/svg+xml") as File])).rejects.toThrow("choose");
    expect(reader).not.toHaveBeenCalled();
  });
  it("reports file read errors for retry rather than silently discarding media", async () => {
    class Reader {
      onerror: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal("FileReader", Reader);
    await expect(encodeSupportFiles([file("image.png") as File])).rejects.toThrow("Please choose it again");
  });
});
