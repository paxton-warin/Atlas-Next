import { useEffect, useState } from "react";
import { ExternalLink, FileText } from "lucide-react";
import { api } from "./api";
import { normalizeEntryLaunchLink, type EntryLaunchLink } from "./EntryLaunchLink";
import "./HubDocumentResource.css";

export const DOCUMENT_RESOURCE_UPDATED = "atlas:document-resource-updated";
export function publishDocumentResourceConfig(value: EntryLaunchLink) {
  const config = normalizeEntryLaunchLink(value);
  if (config && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DOCUMENT_RESOURCE_UPDATED, { detail: config }));
}

export function createDocumentResourceStore(load: () => Promise<unknown>) {
  let started = false, version = 0, url: string | null = null;
  const listeners = new Set<() => void>();
  const update = (value: unknown) => {
    const config = normalizeEntryLaunchLink(value);
    if (!config) return;
    version++;
    url = config.url;
    listeners.forEach((listener) => listener());
  };
  return {
    snapshot: () => url,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update,
    start() {
      if (started) return;
      started = true;
      const requestedVersion = version;
      void load().then((value) => {
        // A save completed after this GET began: never replace its acknowledged URL with stale data.
        if (version === requestedVersion) update(value);
      }).catch(() => { /* No invented fallback link on optional configuration failures. */ });
    },
  };
}

const stores = new WeakMap<Document, ReturnType<typeof createDocumentResourceStore>>();
function documentResourceStore() {
  let store = stores.get(document);
  if (!store) {
    store = createDocumentResourceStore(() => api<EntryLaunchLink>("/hub/launch-link"));
    stores.set(document, store);
    const current = store;
    window.addEventListener(DOCUMENT_RESOURCE_UPDATED, (event) => current.update((event as CustomEvent).detail));
  }
  return store;
}

export function DocumentResourceLink({ url }: { url: string }) {
  return <section className="hub-document-resources" aria-label="Resources">
    <h2>Resources</h2>
    <a href={url} target="_blank" rel="noopener noreferrer" title="Document link (opens in a new tab)" aria-label="Document link (opens in a new tab)" className="hub-document-resource">
      <FileText size={16} aria-hidden="true" /><span>Document link</span><ExternalLink size={12} aria-hidden="true" className="hub-document-resource__external" />
    </a>
  </section>;
}

export function HubDocumentResource() {
  const [url, setURL] = useState<string | null>(null);
  useEffect(() => {
    const store = documentResourceStore();
    const update = () => setURL(store.snapshot());
    const unsubscribe = store.subscribe(update);
    update(); store.start();
    return unsubscribe;
  }, []);
  return url ? <DocumentResourceLink url={url} /> : null;
}
