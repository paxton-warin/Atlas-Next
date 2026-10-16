/** Pure bounded local-byte decoder for readable CSS image/font destinations.
 * Caller MUST authorize the original img-src/font-src data: URL first. This is
 * not a generic URL fetcher or executable/style/worker/media resource loader.
 * No network, document namespace, cookie, relay or native-resource authority. */
const failure = (code: string) =>
  Object.assign(new TypeError("local_css_" + code), {
    code: "local_css_" + code,
  });
export function decodeLocalCSSDataResource(
  value: string,
  kind: "image" | "font",
  maxBodyBytes = 8 * 1024 * 1024,
) {
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > 8 * 1024 * 1024
  )
    throw failure("invalid_limit");
  const url = new URL(value);
  url.hash = "";
  if (url.protocol !== "data:" || !["image", "font"].includes(kind))
    throw failure("destination_denied");
  if (url.href.length > maxBodyBytes * 4 + 65536) throw failure("byte_limit");
  const comma = url.href.indexOf(",");
  if (comma < 0) throw failure("invalid_data");
  const metadata = url.href.slice(5, comma),
    mime = metadata.split(";")[0].trim().toLowerCase();
  if (
    !(
      kind === "font"
        ? /^font\/(?:woff2?|ttf|otf)$/
        : /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/
    ).test(mime)
  )
    throw failure("mime_denied");
  const encoded = new TextEncoder().encode(url.href.slice(comma + 1));
  let length = 0;
  for (let i = 0; i < encoded.length; i++)
    if (
      encoded[i] === 37 &&
      i + 2 < encoded.length &&
      /^[0-9a-f]{2}$/i.test(String.fromCharCode(encoded[i + 1], encoded[i + 2]))
    ) {
      encoded[length++] = parseInt(
        String.fromCharCode(encoded[i + 1], encoded[i + 2]),
        16,
      );
      i += 2;
    } else encoded[length++] = encoded[i];
  let body = encoded.slice(0, length);
  if (/;base64[\t\n\f\r ]*$/i.test(metadata))
    try {
      body = Uint8Array.from(
        atob(new TextDecoder("utf-8", { fatal: true }).decode(body)),
        (c) => c.charCodeAt(0),
      );
    } catch {
      throw failure("invalid_data");
    }
  if (!body.byteLength) throw failure("invalid_data");
  if (body.byteLength > maxBodyBytes) throw failure("byte_limit");
  return Object.freeze({ url: url.href, mime, body });
}
