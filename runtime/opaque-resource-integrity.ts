/** SRI over ORIGINAL response bytes before any RuntimeKit transformation.
 * Native Blob loads then receive a separate digest of their exact final bytes.
 * https://www.w3.org/TR/sri/#verification-of-html-document-subresources
 */
export type ResourceDigest = (
  algorithm: string,
  body: Uint8Array,
) => Promise<ArrayBuffer>;
const priority = ["sha256", "sha384", "sha512"];
export type ResourceCodecs = {
  encode: (value: string) => Uint8Array;
  base64: (value: Uint8Array) => string;
};
// Defaults are captured at trusted module evaluation, never looked up after
// website script can replace its realm's public prototype methods.
const subtleDigest = crypto.subtle.digest.bind(crypto.subtle);
const encoder = new TextEncoder(),
  encode = TextEncoder.prototype.encode;
const base64 = btoa.bind(globalThis),
  characters = String.fromCharCode;
const nativeDigest: ResourceDigest = (algorithm, bytes) =>
  subtleDigest(algorithm, bytes as BufferSource);
const nativeCodecs: ResourceCodecs = {
  encode: (value) => encode.call(encoder, value),
  base64: (value) => base64(characters(...value)),
};
export async function resourceDigest(
  body: Uint8Array | string,
  digest: ResourceDigest = nativeDigest,
  codecs: ResourceCodecs = nativeCodecs,
) {
  const bytes = typeof body === "string" ? codecs.encode(body) : body;
  return (
    "sha384-" + codecs.base64(new Uint8Array(await digest("SHA-384", bytes)))
  );
}
export async function verifyResourceIntegrity(
  metadata: string | null | undefined,
  body: Uint8Array,
  digest: ResourceDigest = nativeDigest,
  codecs: ResourceCodecs = nativeCodecs,
) {
  const values: { algorithm: string; value: string }[] = [];
  for (const token of (metadata || "").split(/[\t\n\f\r ]+/)) {
    const [expression] = token.split("?");
    const separator = expression.indexOf("-");
    const algorithm = (
      separator < 0 ? expression : expression.slice(0, separator)
    ).toLowerCase();
    if (!priority.includes(algorithm)) continue;
    values.push({
      algorithm,
      value: separator < 0 ? "" : expression.slice(separator + 1),
    });
  }
  if (!values.length) return;
  const strongest = values.reduce(
    (best, value) =>
      priority.indexOf(value.algorithm) > priority.indexOf(best)
        ? value.algorithm
        : best,
    "sha256",
  );
  const actual = codecs.base64(
    new Uint8Array(await digest("SHA-" + strongest.slice(3), body)),
  );
  if (
    !values.some(
      (value) => value.algorithm === strongest && value.value === actual,
    )
  )
    throw new DOMException(
      "Original resource bytes failed integrity verification.",
      "SecurityError",
    );
}
