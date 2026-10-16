/** Image-destination-only raster fallback for absent/octet-stream metadata.
 * WHATWG MIME Sniffing 6.1/8.2 fixed binary patterns; never text/XML/SVG/HTML
 * guessing, never script/style/font/media promotion. Existing declared supported
 * image MIME handling is retained. A signature is not full decoder validation:
 * malformed bitstreams still fail in the browser's native image decoder.
 * https://mimesniff.spec.whatwg.org/#matching-an-image-type-pattern
 * https://mimesniff.spec.whatwg.org/#sniffing-in-an-image-context
 */
const supported =
  /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;
export function imageResourceMIME(
  supplied: string,
  body: Uint8Array,
): string | undefined {
  const mime = supplied.split(";")[0].trim().toLowerCase();
  if (supported.test(mime)) return mime;
  if (mime && mime !== "application/octet-stream") return undefined;
  const match = (pattern: readonly number[]) =>
    body.length >= pattern.length &&
    pattern.every((byte, index) => byte < 0 || body[index] === byte);
  if (match([0, 0, 1, 0]) || match([0, 0, 2, 0])) return "image/x-icon";
  if (match([71, 73, 70, 56, 55, 97]) || match([71, 73, 70, 56, 57, 97]))
    return "image/gif";
  if (match([82, 73, 70, 70, -1, -1, -1, -1, 87, 69, 66, 80, 86, 80]))
    return "image/webp";
  if (match([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (match([255, 216, 255])) return "image/jpeg";
  return undefined;
}
