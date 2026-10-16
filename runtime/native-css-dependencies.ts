/** CSS Syntax token reader for trusted resource planning. It never guesses a
 * destination from the fetched MIME. Only URL tokens, @import's string target,
 * and image-set string candidates are resource references; comments/ordinary
 * strings/namespace/conditional preludes are not. Ranges replace the whole URL
 * token or string, preserving media/layer/supports qualifiers and declarations. */
export type NativeCSSDependency = Readonly<{
  start: number;
  end: number;
  url: string;
  kind: "style" | "image" | "font";
  /** Exact @import suffix, for preserving/evaluating layer/supports/media. */
  qualifiers?: string;
}>;
const invalid = () =>
  new DOMException(
    "Unsupported or malformed CSS resource token",
    "NotSupportedError",
  );
const whitespace = (c: string) => /[\t\n\f\r ]/.test(c);
const hex = (c: string) => /[0-9a-fA-F]/.test(c);
const name = (c: string) =>
  !!c && (/[a-zA-Z0-9_-]/.test(c) || c.charCodeAt(0) >= 128 || c === "\\");
export function scanNativeCSSDependencies(
  source: string,
): NativeCSSDependency[] {
  if (typeof source !== "string" || source.length > 8 * 1024 * 1024)
    throw invalid();
  const refs: NativeCSSDependency[] = [];
  let importReference: NativeCSSDependency | undefined;
  let i = 0,
    prelude: string | undefined,
    importTarget = false,
    pendingFont = false,
    property = "",
    declarationStart = true;
  const blocks: { font: boolean }[] = [],
    functions: string[] = [];
  function escape(): string {
    ++i;
    if (i >= source.length) throw invalid();
    if (hex(source[i])) {
      let digits = "";
      while (i < source.length && digits.length < 6 && hex(source[i]))
        digits += source[i++];
      if (whitespace(source[i])) {
        if (source[i] === "\r" && source[i + 1] === "\n") ++i;
        ++i;
      }
      const point = parseInt(digits, 16);
      return !point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(point);
    }
    if (source[i] === "\n" || source[i] === "\r" || source[i] === "\f")
      throw invalid();
    return source[i++];
  }
  function word() {
    let result = "";
    while (name(source[i]))
      result += source[i] === "\\" ? escape() : source[i++];
    return result;
  }
  function string() {
    const quote = source[i++];
    let value = "";
    while (i < source.length) {
      const c = source[i];
      if (c === quote) {
        ++i;
        return value;
      }
      if (c === "\n" || c === "\r" || c === "\f") throw invalid();
      if (c === "\\" && /[\n\r\f]/.test(source[i + 1] || "")) {
        ++i;
        if (source[i] === "\r" && source[i + 1] === "\n") ++i;
        ++i;
        continue;
      }
      value +=
        c === "\0" ? (++i, "\ufffd") : c === "\\" ? escape() : source[i++];
    }
    throw invalid();
  }
  function skip() {
    for (;;) {
      while (whitespace(source[i])) ++i;
      if (source.slice(i, i + 2) !== "/*") return;
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw invalid();
      i = end + 2;
    }
  }
  function kind(): NativeCSSDependency["kind"] | undefined {
    if (prelude)
      return prelude === "import" && importTarget ? "style" : undefined;
    if (!blocks.length) return undefined;
    if (blocks.at(-1)!.font) return property === "src" ? "font" : undefined;
    return "image";
  }
  function add(
    start: number,
    end: number,
    url: string,
    destination: NativeCSSDependency["kind"] | undefined,
  ) {
    if (destination) {
      if (refs.length >= 1024)
        throw new DOMException("CSS dependency limit", "QuotaExceededError");
      const reference = { start, end, url, kind: destination };
      refs.push(reference);
      if (destination === "style") importReference = reference;
      if (destination === "style") importTarget = false;
    }
  }
  while (i < source.length) {
    skip();
    if (i >= source.length) break;
    const start = i,
      c = source[i];
    if (c === '"' || c === "'") {
      const value = string(),
        destination = kind();
      if (
        destination === "style" ||
        (destination &&
          ["image-set", "-webkit-image-set"].includes(functions.at(-1) || ""))
      )
        add(start, i, value, destination);
      continue;
    }
    if (c === "@") {
      ++i;
      const value = word().toLowerCase();
      if (!functions.length) {
        prelude = value;
        importTarget = value === "import";
        pendingFont = value === "font-face";
      }
      continue;
    }
    if (name(c)) {
      const value = word().toLowerCase();
      if (source[i] === "(") {
        ++i;
        if (value === "url") {
          while (whitespace(source[i])) ++i;
          let value: string;
          if (source[i] === '"' || source[i] === "'") {
            value = string();
            skip();
            if (source[i] !== ")") throw invalid();
            ++i;
          } else {
            value = "";
            while (i < source.length && source[i] !== ")") {
              if (whitespace(source[i])) {
                while (whitespace(source[i])) ++i;
                if (source[i] !== ")") throw invalid();
                break;
              }
              if (
                source[i] === '"' ||
                source[i] === "'" ||
                source[i] === "(" ||
                source.charCodeAt(i) < 0x20
              )
                throw invalid();
              value += source[i] === "\\" ? escape() : source[i++];
            }
            if (source[i] !== ")") throw invalid();
            ++i;
          }
          add(start, i, value, kind());
        } else functions.push(value);
      } else if (declarationStart && !functions.length) {
        const saved = i;
        skip();
        if (source[i] === ":") {
          property = value;
          declarationStart = false;
        }
        i = saved;
      }
      continue;
    }
    ++i;
    if (c === "(") functions.push("");
    else if (c === ")") {
      if (functions.length) functions.pop();
    } else if (!functions.length && c === "{") {
      blocks.push({ font: pendingFont });
      prelude = undefined;
      pendingFont = false;
      property = "";
      declarationStart = true;
    } else if (!functions.length && c === "}") {
      blocks.pop();
      prelude = undefined;
      property = "";
      declarationStart = true;
    } else if (!functions.length && c === ";") {
      if (importReference) {
        (importReference as { qualifiers?: string }).qualifiers = source
          .slice(importReference.end, i - 1)
          .trim();
        importReference = undefined;
      }
      prelude = undefined;
      importTarget = false;
      pendingFont = false;
      property = "";
      declarationStart = true;
    }
  }
  if (functions.length) throw invalid();
  if (importReference)
    (importReference as { qualifiers?: string }).qualifiers = source
      .slice(importReference.end)
      .trim();
  return refs.map((reference) => Object.freeze(reference));
}
/** The quoted string representation is valid both as @import target and as
 * image-set candidate; URL-token replacements wrap it in url(). */
export function quoteNativeCSSURL(value: string) {
  return (
    '"' +
    value.replace(/["\\\x00-\x1f\x7f]/g, (c) =>
      c === '"'
        ? '\\"'
        : c === "\\"
          ? "\\\\"
          : "\\" + c.charCodeAt(0).toString(16) + " ",
    ) +
    '"'
  );
}
