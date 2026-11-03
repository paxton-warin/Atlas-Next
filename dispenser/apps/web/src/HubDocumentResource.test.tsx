import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDocumentResourceStore, DocumentResourceLink, HubDocumentResource } from "./HubDocumentResource";

const config = { url: "https://example.test/document", hubEnabled: false, browserEnabled: false };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
describe("always-available configured Hub document link", () => {
  it("uses one shared GET across repeated starts, independently of both popup flags", async () => {
    const load = vi.fn(async () => config), store = createDocumentResourceStore(load);
    const off = store.subscribe(() => {}); store.start(); off(); store.start(); await settle(); store.start();
    expect(load).toHaveBeenCalledTimes(1); expect(store.snapshot()).toBe(config.url);
  });
  it("hides unavailable or invalid config without inventing a fallback document URL", async () => {
    expect(renderToStaticMarkup(<HubDocumentResource />)).toBe("");
    for (const value of [{ ...config, url: "javascript:alert(1)" }, { ...config, url: "https://user:password@example.test" }, {}]) {
      const store = createDocumentResourceStore(async () => value); store.start(); await settle(); expect(store.snapshot()).toBeNull();
    }
    const store = createDocumentResourceStore(async () => { throw Error("offline"); }); store.start(); await settle(); expect(store.snapshot()).toBeNull();
  });
  it("immediately applies an admin save and ignores a stale in-flight public GET", async () => {
    let resolve!: (value: unknown) => void;
    const store = createDocumentResourceStore(() => new Promise((done) => { resolve = done; }));
    store.start(); store.update({ ...config, url: "https://example.test/new-document" }); resolve(config); await settle();
    expect(store.snapshot()).toBe("https://example.test/new-document");
  });
  it("does not accept an invalid update over the last valid configured address", async () => {
    const store = createDocumentResourceStore(async () => config); store.start(); await settle();
    store.update({ ...config, url: "data:text/html,bad" }); expect(store.snapshot()).toBe(config.url);
  });
  it("renders Document link as a direct external anchor with isolated opener and no acknowledgement action", () => {
    const html = renderToStaticMarkup(<DocumentResourceLink url={config.url} />);
    expect(html).toContain(">Document link</span>"); expect(html).toContain('href="https://example.test/document"');
    expect(html).toContain('target="_blank"'); expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('title="Document link (opens in a new tab)"'); expect(html).not.toContain("button");
    expect(html).not.toContain("acknowledg"); expect(html).not.toContain("details");
  });
});
