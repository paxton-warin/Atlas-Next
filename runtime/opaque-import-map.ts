/** Logical-origin import-map resolution before module bytes become Blob URLs.
 * Resolution is scoped by ORIGINAL module URL, never by opaque Blob identity.
 * https://html.spec.whatwg.org/multipage/webappapis.html#import-maps
 */
type SpecifierMap = Map<string, string | null>;
const urlLike = (value: string) =>
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\.\/|\.\.\/)/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const normalized = (value: string, base: string) =>
  urlLike(value) ? new URL(value, base).href : value;
export class OpaqueImportMap {
  private imports: SpecifierMap = new Map();
  private scopes = new Map<string, SpecifierMap>();
  private integrity = new Map<string, string>();
  private resolved = new Map<string, string>();
  private active = false;
  private documentURL: string;
  constructor(documentURL: string) {
    new URL(documentURL);
    this.documentURL = documentURL;
  }
  add(value: unknown, base = this.documentURL) {
    if (this.active)
      throw new DOMException(
        "Import-map mutation after module resolution is not qualified.",
        "NotSupportedError",
      );
    if (!record(value))
      throw new TypeError("Import map must be a JSON object.");
    const parse = (source: unknown) => {
      const output: SpecifierMap = new Map();
      if (source === undefined) return output;
      if (!record(source))
        throw new TypeError("Import-map specifier mappings must be objects.");
      for (const [specifier, value] of Object.entries(source)) {
        if (!specifier) continue;
        const name = normalized(specifier, base);
        if (typeof value !== "string") {
          output.set(name, null);
          continue;
        }
        try {
          const target = new URL(value, base).href;
          output.set(
            name,
            name.endsWith("/") && !target.endsWith("/") ? null : target,
          );
        } catch {
          output.set(name, null);
        }
      }
      return output;
    };
    const merge = (target: SpecifierMap, source: SpecifierMap) => {
      for (const [key, value] of source)
        if (!target.has(key)) target.set(key, value);
    };
    merge(this.imports, parse(value.imports));
    if (value.scopes !== undefined) {
      if (!record(value.scopes))
        throw new TypeError("Import-map scopes must be an object.");
      for (const [prefix, source] of Object.entries(value.scopes)) {
        let scope: string;
        try {
          scope = new URL(prefix, base).href;
        } catch {
          continue;
        }
        const target = this.scopes.get(scope) ?? new Map();
        merge(target, parse(source));
        this.scopes.set(scope, target);
      }
    }
    if (value.integrity !== undefined) {
      if (!record(value.integrity))
        throw new TypeError("Import-map integrity must be an object.");
      for (const [url, metadata] of Object.entries(value.integrity)) {
        if (typeof metadata !== "string") continue;
        try {
          const key = new URL(url, base).href;
          if (!this.integrity.has(key)) this.integrity.set(key, metadata);
        } catch {}
      }
    }
  }
  resolve(specifier: string, referrer = this.documentURL) {
    this.active = true;
    const cache = JSON.stringify([referrer, specifier]);
    if (this.resolved.has(cache)) return this.resolved.get(cache)!;
    const name = normalized(specifier, referrer);
    const match = (map: SpecifierMap): string | undefined => {
      if (map.has(name)) {
        const target = map.get(name);
        if (target === null)
          throw new TypeError("Import-map entry blocks this module specifier.");
        return target;
      }
      for (const prefix of [...map.keys()]
        .filter((key) => key.endsWith("/") && name.startsWith(key))
        .sort((a, b) => b.length - a.length)) {
        const target = map.get(prefix);
        if (target === null)
          throw new TypeError(
            "Import-map prefix blocks this module specifier.",
          );
        const output = new URL(name.slice(prefix.length), target).href;
        if (!output.startsWith(target!))
          throw new TypeError("Import-map prefix traversal is blocked.");
        return output;
      }
    };
    let result: string | undefined;
    for (const scope of [...this.scopes.keys()]
      .filter(
        (scope) =>
          referrer === scope ||
          (scope.endsWith("/") && referrer.startsWith(scope)),
      )
      .sort((a, b) => b.length - a.length)) {
      result = match(this.scopes.get(scope)!);
      if (result !== undefined) break;
    }
    result ??= match(this.imports);
    if (result === undefined) {
      if (!urlLike(specifier))
        throw new TypeError("Bare module specifier has no import-map match.");
      result = new URL(specifier, referrer).href;
    }
    this.resolved.set(cache, result);
    return result;
  }
  integrityFor(url: string) {
    return this.integrity.get(url);
  }
}
