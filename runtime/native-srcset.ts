/** Bounded, strict supported subset of HTML's srcset tokenization.
 * https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
 * URL collection stops on ASCII whitespace, NOT commas (data: includes them).
 * Malformed/nonconforming descriptors are explicit unsupported inputs rather
 * than reinterpreted URLs. Candidate selection remains the native browser's.
 */
export type NativeSrcsetCandidate = Readonly<{
  url: string;
  descriptor: string;
}>;
const fail = () =>
  new DOMException("Unsupported srcset syntax", "NotSupportedError");
const space = (c: string) => /[\t\n\f\r ]/.test(c || "");
export function parseNativeSrcset(
  source: string,
): readonly NativeSrcsetCandidate[] {
  if (typeof source !== "string" || source.length > 65536) throw fail();
  const result: NativeSrcsetCandidate[] = [];
  let position = 0,
    mode: string | undefined;
  const descriptors = new Set<string>();
  while (position < source.length) {
    while (space(source[position])) position++;
    if (position === source.length) break;
    if (source[position] === ",") throw fail();
    const start = position;
    while (position < source.length && !space(source[position])) position++;
    let url = source.slice(start, position),
      descriptor = "";
    if (url.endsWith(",")) url = url.slice(0, -1);
    else {
      const begin = position;
      while (position < source.length && source[position] !== ",") {
        if (source[position] === "(" || source[position] === ")") throw fail();
        position++;
      }
      descriptor = source.slice(begin, position).trim();
      if (source[position] === ",") position++;
    }
    if (!url || /[\x00-\x20\x7f]/.test(url) || url.length > 16384) throw fail();
    let candidateMode = "x",
      canonical = "1x";
    if (descriptor) {
      if (/^[1-9]\d*w$/.test(descriptor)) {
        candidateMode = "w";
        const n = Number(descriptor.slice(0, -1));
        if (!Number.isSafeInteger(n)) throw fail();
        canonical = n + "w";
      } else if (
        /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?x$/.test(descriptor)
      ) {
        const n = Number(descriptor.slice(0, -1));
        if (!Number.isFinite(n) || n <= 0) throw fail();
        canonical = n + "x";
      } else throw fail();
    }
    if ((mode && mode !== candidateMode) || descriptors.has(canonical))
      throw fail();
    mode = candidateMode;
    descriptors.add(canonical);
    result.push(Object.freeze({ url, descriptor }));
    if (result.length > 64) throw fail();
  }
  return Object.freeze(result);
}
export function serializeNativeSrcset(
  candidates: readonly NativeSrcsetCandidate[],
): string {
  if (!Array.isArray(candidates) || candidates.length > 64) throw fail();
  const source = candidates
    .map((c) => {
      if (
        !c ||
        typeof c.url !== "string" ||
        typeof c.descriptor !== "string" ||
        /[\x00-\x20\x7f]/.test(c.url) ||
        c.url.endsWith(",")
      )
        throw fail();
      return c.url + (c.descriptor ? " " + c.descriptor : "");
    })
    .join(", ");
  const parsed = parseNativeSrcset(source);
  if (parsed.length !== candidates.length) throw fail();
  return source;
}
