/** One explicit user-selected image, decoded locally and bounded before it enters
 * preferences or their retry journal. No network access or persistent writes. */
export const WALLPAPER_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const WALLPAPER_MAX_OUTPUT_BYTES = 256 * 1024;
export const WALLPAPER_MAX_EDGE = 1920;
const MAX_SOURCE_PIXELS = 64_000_000;
type WallpaperMime = "image/jpeg" | "image/png" | "image/webp";
type ImageFile = Pick<File, "name" | "type" | "size">;

export function wallpaperMime(file: ImageFile): WallpaperMime {
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    throw Error("This image is empty. Choose a JPG, PNG or WebP photo.");
  if (file.size > WALLPAPER_MAX_INPUT_BYTES)
    throw Error("Choose an image of 20 MiB or smaller.");
  const mime = file.type.trim().toLowerCase();
  if (["image/jpeg", "image/jpg", "image/pjpeg"].includes(mime)) return "image/jpeg";
  if (mime === "image/png" || mime === "image/webp") return mime;
  if (!mime) {
    if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
    if (/\.png$/i.test(file.name)) return "image/png";
    if (/\.webp$/i.test(file.name)) return "image/webp";
  }
  throw Error("Choose a JPG, PNG or WebP image.");
}

export function wallpaperSignature(bytes: Uint8Array, mime: WallpaperMime): boolean {
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === "image/jpeg") return starts([0xff, 0xd8, 0xff]);
  if (mime === "image/png") return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return starts([0x52, 0x49, 0x46, 0x46]) &&
    [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value);
}

export function wallpaperDimensions(width: number, height: number, maxEdge = WALLPAPER_MAX_EDGE) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width * height > MAX_SOURCE_PIXELS || !Number.isFinite(maxEdge) || maxEdge < 1)
    throw Error("This image is too large to process. Choose a smaller photo.");
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Also useful to canonicalize a JPEG alias; never accepts quotes or URL schemes. */
export function canonicalWallpaperDataUrl(value: unknown): string {
  if (typeof value !== "string") throw Error("This image could not be read. Choose it again.");
  const match = /^data:image\/(jpeg|jpg|pjpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[2].length % 4 !== 0)
    throw Error("This image could not be read. Choose it again.");
  const type = /^(?:jpe?g|pjpeg)$/i.test(match[1]) ? "jpeg" : match[1].toLowerCase();
  return `data:image/${type};base64,${match[2]}`;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(Error("This image could not be read. Choose it again."));
    reader.onload = () => {
      try { resolve(canonicalWallpaperDataUrl(reader.result)); }
      catch (error) { reject(error); }
    };
    reader.readAsDataURL(blob);
  });
}

type DecodedImage = { source: CanvasImageSource; width: number; height: number; close(): void };
async function decode(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      // The native decoder applies EXIF orientation; drawing must not rotate twice.
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // A native Image fallback covers decoder differences, still without upload.
    }
  }
  const url = URL.createObjectURL(blob), image = new Image();
  image.decoding = "async";
  try {
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight,
      close: () => { image.src = ""; URL.revokeObjectURL(url); } };
  } catch {
    image.src = "";
    URL.revokeObjectURL(url);
    throw Error("This JPG, PNG or WebP file could not be opened. Choose a different image.");
  }
}

function encode(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(Error("This image could not be prepared. Try another photo.")), mime, quality);
  });
}

export async function prepareWallpaper(file: File): Promise<string> {
  const mime = wallpaperMime(file);
  let header: Uint8Array;
  try { header = new Uint8Array(await file.slice(0, 16).arrayBuffer()); }
  catch { throw Error("This image could not be read. Choose it again."); }
  if (!wallpaperSignature(header, mime))
    throw Error("This file is not a valid JPG, PNG or WebP image. Choose another photo.");
  // Canonical MIME fixes .jpg aliases and empty OS MIME metadata before decode/read.
  const imageBlob = new Blob([file], { type: mime });
  const decoded = await decode(imageBlob);
  let canvas: HTMLCanvasElement | undefined;
  try {
    const dimensions = wallpaperDimensions(decoded.width, decoded.height);
    if (file.size <= WALLPAPER_MAX_OUTPUT_BYTES && decoded.width <= WALLPAPER_MAX_EDGE && decoded.height <= WALLPAPER_MAX_EDGE)
      return await dataUrl(imageBlob);
    canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw Error("This image could not be prepared. Try another photo.");
    let outputMime = "image/webp";
    // At most25 native encode calls; noisy photos also get a smaller pixel budget.
    for (const scale of [1, 0.75, 0.5, 0.35, 0.25, 0.125]) {
      canvas.width = Math.max(1, Math.round(dimensions.width * scale));
      canvas.height = Math.max(1, Math.round(dimensions.height * scale));
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      for (const quality of outputMime === "image/png" ? [undefined] : [0.86, 0.7, 0.54, 0.38]) {
        let blob = await encode(canvas, outputMime, quality);
        if (outputMime === "image/webp" && blob.type !== "image/webp") {
          // Preserve alpha when WebP is unavailable; JPG inputs are opaque.
          outputMime = mime === "image/jpeg" ? "image/jpeg" : "image/png";
          blob = await encode(canvas, outputMime, quality);
        }
        if (blob.size > 0 && blob.size <= WALLPAPER_MAX_OUTPUT_BYTES)
          return await dataUrl(blob);
        if (outputMime === "image/png") break; // PNG ignores quality; reduce pixels instead.
      }
    }
    throw Error("This image could not be made small enough to save. Choose a simpler photo.");
  } finally {
    decoded.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
