import { Download, Eye, Maximize2, Minus, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import "./support-media.css";

export type SupportAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};
export type SupportUpload = { name: string; mimeType: string; dataBase64: string };
export type SupportMediaResult = { attachment: SupportAttachment; dataBase64: string };
const MIB = 1024 * 1024;
export const SUPPORT_FILE_LIMIT = 10 * MIB;
export const SUPPORT_MESSAGE_LIMIT = 20 * MIB;
export const SUPPORT_FILE_COUNT = 3;
const supported = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm",
]);
const normalizeMime = (mime: string) => ({ "audio/x-wav": "audio/wav", "audio/x-m4a": "audio/mp4" } as Record<string, string>)[mime] || mime;
export function supportMediaSize(bytes: number) {
  return bytes < MIB ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB` : `${(bytes / MIB).toFixed(1)} MiB`;
}
export function validateSupportFiles(files: readonly Pick<File, "name" | "type" | "size">[]): string {
  if (files.length > SUPPORT_FILE_COUNT) return "Attach up to 3 files per message.";
  for (const file of files) {
    if (!supported.has(normalizeMime(file.type))) return `${file.name}: choose a PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MP3, WAV, OGG or M4A file.`;
    if (!file.size) return `${file.name}: this file is empty.`;
    if (file.size > SUPPORT_FILE_LIMIT) return `${file.name}: files must be 10 MiB or smaller.`;
  }
  if (files.reduce((bytes, file) => bytes + file.size, 0) > SUPPORT_MESSAGE_LIMIT) return "Attachments must total 20 MiB or less per message.";
  return "";
}
/** File bytes are read only when the user sends; picking a file creates no preview or upload. */
export async function encodeSupportFiles(files: readonly File[]): Promise<SupportUpload[]> {
  const error = validateSupportFiles(files);
  if (error) throw Error(error);
  const uploads: SupportUpload[] = [];
  for (const file of files) {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(Error(`${file.name} could not be read. Please choose it again.`));
      reader.onabort = () => reject(Error(`${file.name} could not be read. Please choose it again.`));
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string" || !result.includes(",")) reject(Error(`${file.name} could not be read.`));
        else resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.readAsDataURL(file);
    });
    uploads.push({ name: file.name, mimeType: normalizeMime(file.type), dataBase64 });
  }
  return uploads;
}
export function SupportMediaPicker({ files, onChange, disabled = false }: {
  files: readonly File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const id = useId(), hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  return <div className="support-media support-media-picker">
    <div className="support-media-choose">
      <button className="support-media-button" type="button" disabled={disabled} onClick={() => input.current?.click()} aria-controls={id} aria-describedby={hintId}><Paperclip size={16} aria-hidden="true" />Attach media</button>
      <input className="support-media-input" id={id} ref={input} tabIndex={-1} type="file" multiple disabled={disabled} aria-label="Choose support media" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a,audio/webm,.m4a" onChange={(event) => {
        const added = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = "";
        if (!added.length) return;
        const next = [...files, ...added];
        const problem = validateSupportFiles(next);
        setError(problem);
        if (!problem) onChange(next);
      }} />
      <small id={hintId}>Images, video or audio · Up to 3 files · 10 MiB each, 20 MiB per message, 100 MiB per account</small>
    </div>
    {!!files.length && <ul className="support-media-pending" aria-label="Attached files">{files.map((file, index) => <li key={`${index}-${file.name}`}><span><strong>{file.name}</strong><small>{supportMediaSize(file.size)}</small></span><button className="support-media-button" type="button" aria-label={`Remove ${file.name}`} disabled={disabled} onClick={() => { setError(""); onChange(files.filter((_, position) => position !== index)); }}><X size={16} aria-hidden="true" /></button></li>)}</ul>}
    {error && <p className="support-media-error" role="alert">{error}</p>}
  </div>;
}
/** Fit never upscales. Camera images can need less than 1% on a narrow screen. */
export function supportImageFit(width: number, height: number, availableWidth: number, availableHeight: number) {
  if (![width, height, availableWidth, availableHeight].every(value => Number.isFinite(value) && value > 0)) return 1;
  return Math.min(1, availableWidth / width, availableHeight / height);
}
export function supportImageZoom(value: number, minimum = 0.1) {
  const floor = Number.isFinite(minimum) && minimum > 0 ? Math.min(0.1, minimum) : 0.1;
  return Number.isFinite(value) ? Math.max(floor, Math.min(4, value)) : 1;
}
const visibilitySubscribers = new Set<() => void>();
const visibleSnapshot = () => typeof document === "undefined" || document.visibilityState !== "hidden";
function visibilityChanged() { visibilitySubscribers.forEach(notify => notify()); }
function subscribeVisibility(notify: () => void) {
  visibilitySubscribers.add(notify);
  if (visibilitySubscribers.size === 1) document.addEventListener("visibilitychange", visibilityChanged);
  return () => {
    visibilitySubscribers.delete(notify);
    if (!visibilitySubscribers.size) document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
// Two visible images at a time, never one request per row in a long thread.
let imageJobsRunning = 0;
const imageJobs: Array<() => void> = [];
function imageSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    imageJobs.push(() => {
      imageJobsRunning++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { imageJobsRunning--; drainImageJobs(); });
    });
    drainImageJobs();
  });
}
function drainImageJobs() {
  while (imageJobsRunning < 2 && imageJobs.length) imageJobs.shift()!();
}
function ImageViewer({ attachment, url, onClose }: { attachment: SupportAttachment; url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1), [fitted, setFitted] = useState(true), [error, setError] = useState("");
  const latest = useRef({ zoom, fitted, natural, area });
  latest.current = { zoom, fitted, natural, area };
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const titleId = useId();
  function fitValue() {
    const { natural, area } = latest.current;
    return supportImageFit(natural.width, natural.height, area.width, area.height);
  }
  function zoomTo(value: number) {
    const panel = stage.current, prior = latest.current.zoom;
    const next = supportImageZoom(value, fitValue());
    const left = panel ? (panel.scrollLeft + panel.clientWidth / 2) * next / prior - panel.clientWidth / 2 : 0;
    const top = panel ? (panel.scrollTop + panel.clientHeight / 2) * next / prior - panel.clientHeight / 2 : 0;
    setFitted(false); setZoom(next);
    requestAnimationFrame(() => panel?.scrollTo({ left, top }));
  }
  function fit() {
    setFitted(true); setZoom(fitValue());
    requestAnimationFrame(() => stage.current?.scrollTo({ left: 0, top: 0 }));
  }
  function close() { dialog.current?.close(); }
  useEffect(() => {
    const panel = dialog.current;
    if (panel && !panel.open) panel.showModal();
    panel?.querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]')?.focus();
    return () => { if (panel?.open) panel.close(); };
  }, []);
  useEffect(() => {
    const panel = stage.current;
    if (!panel) return;
    const resize = () => {
      const width = Math.max(1, panel.clientWidth - 32), height = Math.max(1, panel.clientHeight - 32);
      setArea({ width, height });
      if (latest.current.fitted) setZoom(supportImageFit(latest.current.natural.width, latest.current.natural.height, width, height));
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(panel);
    const wheel = (event: WheelEvent) => {
      if (!latest.current.natural.width || !event.deltaY) return;
      event.preventDefault();
      zoomTo(latest.current.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2));
    };
    panel.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); panel.removeEventListener("wheel", wheel); window.removeEventListener("resize", resize); };
  }, []);
  const imageWidth = natural.width * zoom, imageHeight = natural.height * zoom;
  return <dialog ref={dialog} className="support-image-viewer" aria-label={`Image viewer: ${attachment.name}`} onClose={(event) => { if (!event.currentTarget.open) onClose(); }} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="support-image-viewer-header"><div><strong id={titleId}>{attachment.name}</strong><small>{natural.width ? `${natural.width} × ${natural.height} · ` : ""}{supportMediaSize(attachment.size)}</small></div><button type="button" className="support-media-button" aria-label="Close image viewer" onClick={close}><X size={18} aria-hidden="true" /></button></header>
    <div className="support-image-viewer-tools" role="group" aria-label="Image viewer tools">
      <button type="button" className="support-media-button" aria-label="Zoom out" disabled={!natural.width || zoom <= Math.min(0.1, fitValue())} onClick={() => zoomTo(zoom / 1.25)}><Minus size={17} aria-hidden="true" /></button>
      <output aria-label="Image zoom" aria-live="polite">{Math.round(zoom * 100)}%</output>
      <button type="button" className="support-media-button" aria-label="Zoom in" disabled={!natural.width || zoom >= 4} onClick={() => zoomTo(zoom * 1.25)}><Plus size={17} aria-hidden="true" /></button>
      <button type="button" className="support-media-button" aria-label="Fit image" onClick={fit} disabled={!natural.width}><Maximize2 size={16} aria-hidden="true" />Fit</button>
      <button type="button" className="support-media-button" aria-label="Actual size" onClick={() => zoomTo(1)} disabled={!natural.width}>100%</button>
      <a className="support-media-button" href={url} download={attachment.name} aria-label={`Download ${attachment.name}`}><Download size={16} aria-hidden="true" />Download</a>
    </div>
    {error ? <p className="support-media-error" role="alert">{error}</p> : <div ref={stage} className="support-image-stage" tabIndex={0} aria-label="Image canvas. Use arrow keys to pan, plus or minus to zoom." onKeyDown={(event) => {
      if (["+", "="].includes(event.key)) { event.preventDefault(); zoomTo(zoom * 1.25); }
      if (event.key === "-") { event.preventDefault(); zoomTo(zoom / 1.25); }
      if (event.key === "0") { event.preventDefault(); fit(); }
    }} onPointerDown={(event) => {
      if (event.button !== 0 || !stage.current) return;
      const panel = stage.current;
      if (panel.scrollWidth <= panel.clientWidth && panel.scrollHeight <= panel.clientHeight) return;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: panel.scrollLeft, top: panel.scrollTop };
      panel.setPointerCapture(event.pointerId); panel.focus(); event.preventDefault();
    }} onPointerMove={(event) => {
      const current = drag.current;
      if (current && current.id === event.pointerId) stage.current?.scrollTo({ left: current.left + current.x - event.clientX, top: current.top + current.y - event.clientY });
    }} onPointerUp={(event) => { if (drag.current?.id === event.pointerId) drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div className="support-image-canvas" style={{ width: Math.max(area.width, imageWidth), height: Math.max(area.height, imageHeight) }}>
        <img src={url} alt={attachment.name} draggable={false} decoding="async" style={{ width: natural.width ? imageWidth : undefined, height: natural.height ? imageHeight : undefined, visibility: natural.width ? "visible" : "hidden" }} onLoad={(event) => {
          const image = event.currentTarget, dimensions = { width: image.naturalWidth, height: image.naturalHeight };
          setNatural(dimensions);
          if (latest.current.fitted) setZoom(supportImageFit(dimensions.width, dimensions.height, stage.current ? stage.current.clientWidth - 32 : 1, stage.current ? stage.current.clientHeight - 32 : 1));
        }} onError={() => setError("This image could not be displayed. You can still download the original.")} />
      </div>
    </div>}
    <footer className="support-image-viewer-footer">Scroll to zoom · Drag or use arrow keys to move · Esc to close</footer>
  </dialog>;
}
function MediaItem({ attachment, load, active }: { attachment: SupportAttachment; load: (id: string) => Promise<SupportMediaResult>; active: boolean }) {
  const [url, setUrl] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [near, setNear] = useState(false), [viewer, setViewer] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  const image = attachment.mimeType.startsWith("image/");
  const visible = useSyncExternalStore(subscribeVisibility, visibleSnapshot, () => true);
  // Only image auto-preview follows page visibility; user-started AV keeps its
  // original playback lifetime until the message/ticket itself unmounts.
  const eligible = !image || (active && visible);
  const current = useRef({ live: true, url: "", request: 0, busy: false, attempted: false });
  const latest = useRef({ attachment, load, eligible, near });
  latest.current = { attachment, load, eligible, near };
  function release() {
    current.current.request++;
    current.current.busy = false;
    if (current.current.url) URL.revokeObjectURL(current.current.url);
    current.current.url = "";
    setUrl(""); setBusy(false); setViewer(false);
  }
  useEffect(() => {
    const state = current.current;
    state.live = true;
    return () => { state.live = false; state.request++; if (state.url) URL.revokeObjectURL(state.url); state.url = ""; };
  }, []);
  useEffect(() => {
    setNear(false);
    current.current.attempted = false;
    if (!eligible) { release(); setError(""); return; }
    if (!image || !item.current) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: "160px" });
    observer.observe(item.current);
    return () => observer.disconnect();
  }, [eligible, image, attachment.id, attachment.mimeType, attachment.size]);
  useEffect(() => {
    if (image && eligible && near && !current.current.url && !current.current.attempted) {
      current.current.attempted = true;
      void open(true);
    }
  }, [image, eligible, near]);
  useEffect(() => {
    if (image && !near && !viewer && (current.current.url || current.current.busy)) { release(); current.current.attempted = false; }
  }, [image, near, viewer]);
  async function open(automatic = false) {
    if (current.current.busy || current.current.url || !latest.current.eligible) return;
    const request = ++current.current.request;
    const expected = latest.current.attachment;
    current.current.busy = true;
    setBusy(true); setError("");
    const ownsRequest = () => current.current.live && request === current.current.request && latest.current.attachment.id === expected.id;
    const valid = () => ownsRequest() && latest.current.eligible && (!automatic || latest.current.near);
    try {
      const fetchMedia = async () => valid() ? latest.current.load(expected.id) : null;
      const result = automatic ? await imageSlot(fetchMedia) : await fetchMedia();
      if (!valid() || !result) { if (ownsRequest()) current.current.attempted = false; return; }
      if (result.attachment.id !== expected.id || result.attachment.mimeType !== expected.mimeType || result.attachment.size !== expected.size || !supported.has(expected.mimeType) || expected.size < 1 || expected.size > SUPPORT_FILE_LIMIT || typeof result.dataBase64 !== "string" || result.dataBase64.length > Math.ceil(SUPPORT_FILE_LIMIT / 3) * 4) throw Error("This attachment could not be verified. Try again.");
      const nativeDecode = (Uint8Array as typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array<ArrayBuffer> }).fromBase64;
      let bytes: Uint8Array<ArrayBuffer>;
      if (nativeDecode) bytes = nativeDecode.call(Uint8Array, result.dataBase64);
      else {
        const decoded = atob(result.dataBase64);
        bytes = new Uint8Array(decoded.length);
        for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      }
      if (bytes.length !== expected.size) throw Error("This attachment is incomplete. Try again.");
      const next = URL.createObjectURL(new Blob([bytes], { type: expected.mimeType }));
      current.current.url = next;
      setUrl(next);
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : "This attachment could not be loaded.");
    } finally {
      if (ownsRequest()) { current.current.busy = false; setBusy(false); }
    }
  }
  return <li ref={item} className={`support-media-item${image ? " support-media-image" : ""}`}>
    <div className="support-media-item-heading"><span><strong>{attachment.name}</strong><small>{supportMediaSize(attachment.size)}</small></span>{image ? url && <a className="support-media-button" href={url} download={attachment.name} aria-label={`Download ${attachment.name}`}><Download size={16} aria-hidden="true" />Download</a> : url ? <button className="support-media-button" type="button" onClick={release}><X size={16} aria-hidden="true" />Close preview</button> : <button className="support-media-button" type="button" disabled={busy || !eligible} onClick={() => void open()} aria-label={`View ${attachment.name}`} aria-busy={busy || undefined}><Eye size={16} aria-hidden="true" />{busy ? "Loading…" : "View"}</button>}</div>
    {error && <div className="support-media-error" role="alert"><p>{error}</p>{image && <button className="support-media-button" type="button" disabled={busy || !eligible} onClick={() => { release(); current.current.attempted = true; void open(true); }} aria-label={`Retry image ${attachment.name}`}>Retry image</button>}</div>}
    {image ? url ? <button type="button" className="support-image-thumbnail" aria-label={`Enlarge ${attachment.name}`} onClick={() => setViewer(true)}><img src={url} alt={attachment.name} decoding="async" loading="lazy" onError={() => setError("This image could not be displayed. You can still download the original.")} /><span>Click to enlarge</span></button> : !error && <div className="support-image-placeholder" role="status">{busy ? "Loading image…" : "Image preview"}</div> : url && <div className="support-media-preview">{attachment.mimeType.startsWith("video/") ? <video src={url} controls preload="none" playsInline /> : <audio src={url} controls preload="none" />}<a className="support-media-button" href={url} download={attachment.name}><Download size={16} aria-hidden="true" />Download</a></div>}
    {image && viewer && url && eligible && <ImageViewer attachment={attachment} url={url} onClose={() => setViewer(false)} />}
  </li>;
}
export function SupportMediaList({ attachments = [], load, active = true }: {
  attachments?: readonly SupportAttachment[];
  load: (id: string) => Promise<SupportMediaResult>;
  active?: boolean;
}) {
  if (!attachments.length) return null;
  return <ul className="support-media support-media-list" aria-label="Message attachments">{attachments.map(attachment => <MediaItem key={`${attachment.id}:${attachment.mimeType}:${attachment.size}`} attachment={attachment} load={load} active={active} />)}</ul>;
}
