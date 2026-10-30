import {
  profileDatabaseName,
  appendProfileJournal,
} from "./profile-journal.ts";
import {
  assertProfileWrite,
  assertProfileWriteCached,
} from "./profile-permissions.ts";
/** Frontend-owned browser cookie authority for the opaque runtime.
 * The persistent jar never enters an untrusted document. Document capabilities
 * expose only a URL-bound, path/domain/Secure/SameSite-filtered non-HttpOnly
 * cookie string. Network Set-Cookie commits complete before wrapped fetch does.
 */
import { parse as parseDomain } from "tldts";
import type {
  SandboxNetworkRequest,
  SandboxNetworkResponse,
  SandboxNetworkContext,
} from "./sandbox-network.ts";

export const SANDBOX_COOKIE_DATABASE = "atlas.browsing.cookies.v2";
export const SANDBOX_COOKIE_PROTOCOL = "atlas-cookies-v2";
const LIFETIME = 400 * 24 * 60 * 60 * 1000;
const MAX_LINE = 16384;
const encoder = new TextEncoder();
type SameSite = "strict" | "lax" | "none" | "default";
type Cookie = {
  id: string;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  partition: string | null;
  sessionId: string | null;
  expires: number | null;
  created: number;
  accessed: number;
  site: string;
};
export type CookieRequestContext = {
  requestURL: string;
  documentURL: string;
  topLevelURL: string;
  /** Trusted virtual ancestor calculation; null means an opaque site-for-cookies. */
  siteForCookiesURL?: string | null;
  method?: string;
  credentials?: "omit" | "same-origin" | "include";
  topLevelNavigation?: boolean;
  preflight?: boolean;
  signal?: AbortSignal;
};
export type CookieDocumentContext = {
  documentId: string;
  documentURL: string;
  topLevelURL: string;
  siteForCookiesURL?: string | null;
};
type Context = {
  request: URL;
  document: URL;
  top: URL;
  site: string | null;
  sameSite: boolean;
  navigation: boolean;
  method: string;
  credentials: boolean;
  signal?: AbortSignal;
};
type Outcome = { accepted: number; rejected: string[]; revision: number };
type View = { value: string; revision: number; expiresAt: number | null };
type Options = {
  factory: IDBFactory;
  profileId?: string | null;
  profileContextId?: string;
  onNativeCommit?: (origin: string) => void;
  /** Shared by all tabs in ONE logical browser session, not a per-tab ID. */
  browserSessionId: string;
  forbiddenOrigins: string[];
  now?: () => number;
  maxCookies?: number;
  maxCookiesPerSite?: number;
  maxBytes?: number;
};
const ownKeys = (
  value: unknown,
  names: string[],
): value is Record<string, any> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((name) => names.includes(name));
const bytes = (value: string) => encoder.encode(value).length;
const trim = (value: string) => value.replace(/^[\t ]+|[\t ]+$/g, "");
const invalid = (code: string) => new DOMException(code, "SecurityError");
function url(value: string): URL {
  const result = new URL(value);
  if (
    !/^https?:$/.test(result.protocol) ||
    result.username ||
    result.password ||
    result.href.length > 16384
  )
    throw new TypeError("Cookie URL requires HTTP(S) without credentials");
  result.hash = "";
  return result;
}
/** Schemeful site: registrable domain/private PSL boundary, not a URL origin.
 * Ports matter for fetch credentials, but never distinguish cookie sites.
 */
export function cookieSchemefulSite(value: string | URL): string {
  const target = typeof value === "string" ? url(value) : value;
  const domain = parseDomain(target.hostname, {
    allowPrivateDomains: true,
  }).domain;
  return target.protocol + "//" + (domain || target.hostname);
}
export function cookieDomainMatches(host: string, domain: string): boolean {
  return (
    host === domain || (!parseDomain(host).isIp && host.endsWith("." + domain))
  );
}
export function cookiePathMatches(path: string, scope: string): boolean {
  return (
    path === scope ||
    (path.startsWith(scope) &&
      (scope.endsWith("/") || path[scope.length] === "/"))
  );
}
function defaultPath(target: URL) {
  const last = target.pathname.lastIndexOf("/");
  return last > 0 ? target.pathname.slice(0, last) : "/";
}
function secure(target: URL) {
  const host = target.hostname.toLowerCase();
  return (
    target.protocol === "https:" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
  );
}
function publicSuffix(domain: string) {
  const parsed = parseDomain(domain, { allowPrivateDomains: true });
  return !parsed.isIp && parsed.publicSuffix === domain;
}
/** Liberal cookie-date token parsing, without interpreting arbitrary timezone
 * offsets or depending on locale-specific Date.parse behavior. */
export function parseCookieDate(value: string): number | undefined {
  const tokens = value.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/);
  let time: number[] | undefined,
    day: number | undefined,
    month: number | undefined,
    year: number | undefined;
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  for (const token of tokens) {
    let match;
    if (
      !time &&
      (match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/.exec(token))
    )
      time = match.slice(1).map(Number);
    else if (day === undefined && /^(\d{1,2})(?:\D.*)?$/.test(token))
      day = Number(/^\d+/.exec(token)![0]);
    else if (
      month === undefined &&
      months.includes(token.slice(0, 3).toLowerCase())
    )
      month = months.indexOf(token.slice(0, 3).toLowerCase());
    else if (year === undefined && /^(\d{2,4})(?:\D.*)?$/.test(token))
      year = Number(/^\d+/.exec(token)![0]);
  }
  if (year !== undefined && year < 100) year += year >= 70 ? 1900 : 2000;
  if (
    !time ||
    year === undefined ||
    year < 1601 ||
    day === undefined ||
    day < 1 ||
    day > 31 ||
    month === undefined ||
    time[0] > 23 ||
    time[1] > 59 ||
    time[2] > 59
  )
    return;
  return Date.UTC(year, month, day, ...(time as [number, number, number]));
}
function parseLine(
  line: string,
  context: Context,
  fromHTTP: boolean,
  sessionId: string,
  now: number,
): { cookie?: Cookie; reason?: string } {
  if (
    typeof line !== "string" ||
    bytes(line) > MAX_LINE ||
    /[\x00-\x08\x0a-\x1f\x7f\u0100-\uffff]/.test(line)
  )
    return { reason: "invalid_cookie_syntax" };
  const parts = line.split(";"),
    pair = trim(parts.shift() || ""),
    equal = pair.indexOf("=");
  const name = equal < 0 ? "" : trim(pair.slice(0, equal)),
    value = trim(equal < 0 ? pair : pair.slice(equal + 1));
  if ((!name && !value) || bytes(name + value) > 4096)
    return { reason: "invalid_cookie_size" };
  const attributes = new Map<string, string>();
  let expiry: number | undefined, maxAge: number | undefined;
  for (const part of parts) {
    const index = part.indexOf("="),
      key = trim(index < 0 ? part : part.slice(0, index)).toLowerCase(),
      value = trim(index < 0 ? "" : part.slice(index + 1));
    if (key === "expires") {
      const parsed = parseCookieDate(value);
      if (parsed !== undefined) expiry = parsed;
    } else if (key === "max-age") {
      if (/^-?\d+$/.test(value)) maxAge = Number(value);
    } else if (["domain", "path"].includes(key)) {
      if (bytes(value) <= 1024) attributes.set(key, value);
    } else attributes.set(key, value);
  }
  const host = context.request.hostname.toLowerCase();
  let domain = host,
    hostOnly = true;
  if (attributes.has("domain") && attributes.get("domain")) {
    domain = attributes.get("domain")!.toLowerCase().replace(/^\./, "");
    if (
      /[^a-z0-9.\-]/.test(domain) ||
      !domain ||
      domain.endsWith(".") ||
      domain.startsWith(".") ||
      domain.includes("..") ||
      !cookieDomainMatches(host, domain)
    )
      return { reason: "cookie_domain_denied" };
    if (publicSuffix(domain)) {
      if (domain !== host) return { reason: "cookie_public_suffix_denied" };
      hostOnly = true;
    } else hostOnly = false;
  }
  let path = attributes.get("path") || defaultPath(context.request);
  if (!path.startsWith("/")) path = defaultPath(context.request);
  const isSecure = attributes.has("secure"),
    httpOnly = attributes.has("httponly");
  const sameSite: SameSite = ["strict", "lax", "none"].includes(
    attributes.get("samesite")?.toLowerCase() || "",
  )
    ? (attributes.get("samesite")!.toLowerCase() as SameSite)
    : "default";
  if (isSecure && !secure(context.request))
    return { reason: "cookie_secure_transport_required" };
  if (httpOnly && !fromHTTP)
    return { reason: "cookie_httponly_document_denied" };
  if (sameSite === "none" && !isSecure)
    return { reason: "cookie_samesite_none_requires_secure" };
  if (
    sameSite !== "none" &&
    !context.sameSite &&
    (!fromHTTP || !context.navigation)
  )
    return { reason: "cookie_cross_site_set_denied" };
  const lower = name.toLowerCase();
  if (
    (!name && /^__(?:secure|host|http)-/i.test(value)) ||
    (lower.startsWith("__secure-") && !isSecure) ||
    (lower.startsWith("__host-") &&
      (!isSecure ||
        !hostOnly ||
        attributes.has("domain") ||
        attributes.get("path") !== "/")) ||
    ((lower.startsWith("__http-") || lower.startsWith("__host-http-")) &&
      (!isSecure || !httpOnly || !fromHTTP))
  )
    return { reason: "cookie_prefix_denied" };
  const partition = attributes.has("partitioned")
    ? cookieSchemefulSite(context.top)
    : null;
  if (partition && !isSecure)
    return { reason: "cookie_partition_requires_secure" };
  const expires =
    maxAge !== undefined
      ? maxAge <= 0
        ? 0
        : now + Math.min(maxAge * 1000, LIFETIME)
      : expiry === undefined
        ? null
        : Math.min(expiry, now + LIFETIME);
  const cookie: Cookie = {
    id: JSON.stringify([partition, domain, hostOnly, path, name]),
    name,
    value,
    domain,
    hostOnly,
    path,
    secure: isSecure,
    httpOnly,
    sameSite,
    partition,
    sessionId: expires === null ? sessionId : null,
    expires,
    created: now,
    accessed: now,
    site: parseDomain(domain, { allowPrivateDomains: true }).domain || domain,
  };
  return { cookie };
}
function cookieMatches(
  cookie: Cookie,
  context: Context,
  fromHTTP: boolean,
  sessionId: string,
  now: number,
) {
  if (
    (cookie.expires !== null && cookie.expires <= now) ||
    (cookie.sessionId !== null && cookie.sessionId !== sessionId) ||
    (cookie.hostOnly
      ? cookie.domain !== context.request.hostname
      : !cookieDomainMatches(context.request.hostname, cookie.domain)) ||
    (!cookie.hostOnly && publicSuffix(cookie.domain)) ||
    !cookiePathMatches(context.request.pathname, cookie.path) ||
    (cookie.secure && !secure(context.request)) ||
    (!fromHTTP && cookie.httpOnly) ||
    (cookie.partition !== null &&
      cookie.partition !== cookieSchemefulSite(context.top))
  )
    return false;
  if (!context.sameSite && cookie.sameSite !== "none")
    return (
      fromHTTP &&
      context.navigation &&
      ["GET", "HEAD", "OPTIONS", "TRACE"].includes(context.method) &&
      cookie.sameSite !== "strict"
    );
  return true;
}

export class SandboxCookieJar {
  private readonly factory: IDBFactory;
  private readonly database: Promise<IDBDatabase>;
  private readonly forbidden: Set<string>;
  private readonly options: Required<
    Omit<Options, "factory" | "forbiddenOrigins">
  >;
  private readonly listeners = new Set<() => void>();
  private readonly bindings = new Set<() => void>();
  private readonly transactions = new Set<IDBTransaction>();
  private readonly channel?: BroadcastChannel;
  private closed = false;
  // Access timestamps/expired-row housekeeping are not cookie visibility.
  // Reserve one maintenance read per 15 seconds before awaiting permits, so
  // concurrent resource/header reads cannot all turn into disk writes.
  private nextReadMaintenanceAt = 0;
  constructor(options: Options) {
    this.factory = options.factory;
    if (
      !/^[A-Za-z0-9_-]{16,128}$/.test(options.browserSessionId) ||
      !Array.isArray(options.forbiddenOrigins)
    )
      throw new TypeError(
        "Cookie authority requires a trusted browser session and forbidden frontend origins",
      );
    this.options = {
      browserSessionId: options.profileId
        ? "profile-" + options.profileId
        : options.browserSessionId,
      profileId: options.profileId ?? null,
      profileContextId: options.profileContextId ?? "",
      onNativeCommit: options.onNativeCommit ?? (() => {}),
      now: options.now || Date.now,
      maxCookies: options.maxCookies ?? 3000,
      maxCookiesPerSite: options.maxCookiesPerSite ?? 180,
      maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    };
    for (const value of [
      this.options.maxCookies,
      this.options.maxCookiesPerSite,
      this.options.maxBytes,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("Invalid cookie quota");
    this.forbidden = new Set(
      options.forbiddenOrigins.map((value) => url(value).hostname),
    );
    this.database = new Promise((resolve, reject) => {
      const request = options.factory.open(
        profileDatabaseName(SANDBOX_COOKIE_DATABASE, options.profileId),
        1,
      );
      request.onupgradeneeded = () => {
        request.result.createObjectStore("cookies", { keyPath: "id" });
        request.result.createObjectStore("meta");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(
          new DOMException("Cookie database is blocked", "InvalidStateError"),
        );
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          void this.close();
        };
        if (this.closed) db.close();
        resolve(db);
      };
    });
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(
        profileDatabaseName("atlas.browsing.cookies.v2", options.profileId),
      );
      this.channel.onmessage = (event) => {
        if (event.data?.type === "changed") this.notify(false);
      };
    }
  }
  private journal(
    tx: IDBTransaction,
    origin: string,
    changes: unknown[],
    revision: number,
  ) {
    if (!this.options.profileId || !changes.length) return;
    const payload = { changes, revision };
    appendProfileJournal(tx.objectStore("meta"), {
      profileId: this.options.profileId,
      kind: "cookies",
      origin,
      payload,
      bytes: 2 * JSON.stringify(payload).length,
    });
  }
  private check(value: string) {
    const target = url(value);
    if (this.forbidden.has(target.hostname))
      throw invalid("frontend_cookie_destination_denied");
    return target;
  }
  private context(value: CookieRequestContext): Context {
    const request = this.check(value.requestURL),
      document = this.check(value.documentURL),
      top = this.check(value.topLevelURL);
    const site =
      value.siteForCookiesURL === null
        ? null
        : cookieSchemefulSite(
            this.check(value.siteForCookiesURL || document.href),
          );
    const credentials = value.credentials ?? "same-origin";
    if (!["omit", "same-origin", "include"].includes(credentials))
      throw new TypeError("Invalid cookie credentials policy");
    return {
      request,
      document,
      top,
      site,
      sameSite:
        site !== null &&
        site === cookieSchemefulSite(request) &&
        site === cookieSchemefulSite(top),
      navigation: value.topLevelNavigation === true,
      method: (value.method || "GET").toUpperCase(),
      credentials:
        !value.preflight &&
        credentials !== "omit" &&
        (credentials !== "same-origin" || request.origin === document.origin),
      signal: value.signal,
    };
  }
  private notify(broadcast = true) {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
    if (broadcast) this.channel?.postMessage({ type: "changed" });
  }
  private async read(context: Context, fromHTTP: boolean): Promise<View> {
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    if (context.signal?.aborted)
      throw (
        context.signal.reason ||
        new DOMException("Cookie read aborted", "AbortError")
      );
    let canMutate = false;
    const now = this.options.now();
    if (now >= this.nextReadMaintenanceAt || this.nextReadMaintenanceAt > now + 15000) {
      this.nextReadMaintenanceAt = now + 15000;
      try {
        await assertProfileWrite(
          this.factory,
          this.options.profileId,
          context.request.origin,
          this.options.profileContextId,
        );
        canMutate = true;
      } catch {
        // A fenced reader may still read its committed cookies. Only actual
        // writes/maintenance require the current durable writer permit.
      }
    }
    const db = await this.database;
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
          ["cookies", "meta"],
          canMutate ? "readwrite" : "readonly",
        ),
        store = transaction.objectStore("cookies"),
        meta = transaction.objectStore("meta"),
        revision = meta.get("revision"),
        request = store.getAll();
      this.transactions.add(transaction);
      let result: View,
        changed = false,
        failure: unknown;
      request.onsuccess = () => {
        try {
          const now = this.options.now(),
            selected: Cookie[] = [];
          const journal: unknown[] = [];
          for (const cookie of request.result as Cookie[]) {
            if (cookie.expires !== null && cookie.expires <= now) {
              if (
                canMutate &&
                cookie.site ===
                  (parseDomain(context.request.hostname, {
                    allowPrivateDomains: true,
                  }).domain || context.request.hostname)
              ) {
                assertProfileWriteCached(
                  this.factory,
                  this.options.profileId,
                  context.request.origin,
                  this.options.profileContextId,
                );
                store.delete(cookie.id);
                journal.push({ op: "delete", cookie });
                changed = true;
              }
              continue;
            }
            if (
              cookieMatches(
                cookie,
                context,
                fromHTTP,
                this.options.browserSessionId,
                now,
              )
            ) {
              selected.push(cookie);
              // Last access is sampled metadata, not a document-view change.
              // Reads between maintenance windows remain native readonly I/O.
              if (canMutate && cookie.accessed !== now)
                store.put({ ...cookie, accessed: now });
            }
          }
          selected.sort(
            (a, b) =>
              b.path.length - a.path.length ||
              a.created - b.created ||
              a.id.localeCompare(b.id),
          );
          const version = (revision.result || 0) + (changed ? 1 : 0);
          if (changed) {
            meta.put(version, "revision");
            this.journal(transaction, context.request.origin, journal, version);
          }
          result = {
            value: selected
              .map((cookie) =>
                cookie.name ? cookie.name + "=" + cookie.value : cookie.value,
              )
              .join("; "),
            revision: version,
            expiresAt: selected.reduce<number | null>(
              (time, cookie) =>
                cookie.expires === null
                  ? time
                  : time === null
                    ? cookie.expires
                    : Math.min(time, cookie.expires),
              null,
            ),
          };
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        this.transactions.delete(transaction);
        if (changed) {
          this.notify();
          try {
            this.options.onNativeCommit(context.request.origin);
          } catch {}
        }
        resolve(result!);
      };
      transaction.onabort = () => {
        this.transactions.delete(transaction);
        reject(
          failure ||
            transaction.error ||
            new DOMException("Cookie read aborted", "AbortError"),
        );
      };
      transaction.onerror = () => {};
    });
  }
  private async write(
    lines: string[],
    context: Context,
    fromHTTP: boolean,
  ): Promise<Outcome> {
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    if (context.signal?.aborted)
      throw (
        context.signal.reason ||
        new DOMException("Cookie write aborted", "AbortError")
      );
    if (
      !Array.isArray(lines) ||
      lines.length > 128 ||
      lines.some((line) => typeof line !== "string")
    )
      throw new TypeError("Set-Cookie requires separate bounded header lines");
    await assertProfileWrite(
      this.factory,
      this.options.profileId,
      context.request.origin,
      this.options.profileContextId,
    );
    const db = await this.database;
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      const transaction = db.transaction(["cookies", "meta"], "readwrite", {
        durability: "strict",
      });
      this.transactions.add(transaction);
      const store = transaction.objectStore("cookies"),
        meta = transaction.objectStore("meta"),
        revision = meta.get("revision"),
        request = store.getAll();
      let failure: unknown,
        result: Outcome,
        changed = false;
      const abort = () => {
        failure =
          context.signal?.reason ||
          new DOMException("Cookie write aborted", "AbortError");
        try {
          transaction.abort();
        } catch {}
      };
      context.signal?.addEventListener("abort", abort, { once: true });
      request.onsuccess = () => {
        try {
          assertProfileWriteCached(
            this.factory,
            this.options.profileId,
            context.request.origin,
            this.options.profileContextId,
          );
          if (context.signal?.aborted) return abort();
          const now = this.options.now(),
            all = new Map<string, Cookie>();
          const journal: unknown[] = [];
          for (const cookie of request.result as Cookie[]) {
            if (cookie.expires !== null && cookie.expires <= now) {
              if (
                cookie.site ===
                (parseDomain(context.request.hostname, {
                  allowPrivateDomains: true,
                }).domain || context.request.hostname)
              ) {
                store.delete(cookie.id);
                journal.push({ op: "delete", cookie });
                changed = true;
              }
            } else all.set(cookie.id, cookie);
          }
          let accepted = 0;
          const rejected: string[] = [];
          for (const line of lines) {
            const parsed = parseLine(
                line,
                context,
                fromHTTP,
                this.options.browserSessionId,
                now,
              ),
              cookie = parsed.cookie;
            if (!cookie) {
              rejected.push(parsed.reason!);
              continue;
            }
            const previous = all.get(cookie.id);
            if (!fromHTTP && previous?.httpOnly) {
              rejected.push("cookie_httponly_overwrite_denied");
              continue;
            }
            if (
              !secure(context.request) &&
              !cookie.secure &&
              [...all.values()].some(
                (old) =>
                  old.secure &&
                  old.name === cookie.name &&
                  (cookieDomainMatches(old.domain, cookie.domain) ||
                    cookieDomainMatches(cookie.domain, old.domain)) &&
                  cookiePathMatches(cookie.path, old.path),
              )
            ) {
              rejected.push("cookie_secure_overlay_denied");
              continue;
            }
            accepted++;
            if (cookie.expires !== null && cookie.expires <= now) {
              if (all.delete(cookie.id)) {
                store.delete(cookie.id);
                journal.push({ op: "delete", cookie });
                changed = true;
              }
              continue;
            }
            if (previous) cookie.created = previous.created;
            all.set(cookie.id, cookie);
            store.put(cookie);
            journal.push({ op: "set", cookie });
            changed = true;
          }
          const perSite = new Map<string, number>();
          let size = 0;
          for (const cookie of all.values()) {
            perSite.set(cookie.site, (perSite.get(cookie.site) || 0) + 1);
            size += bytes(JSON.stringify(cookie));
          }
          if (
            all.size > this.options.maxCookies ||
            size > this.options.maxBytes ||
            [...perSite.values()].some(
              (count) => count > this.options.maxCookiesPerSite,
            )
          )
            throw new DOMException(
              "Cookie quota exceeded",
              "QuotaExceededError",
            );
          // IDB requests are processed in order: the meta read predates getAll's
          // success task; its result is available before the later write task.
          const version = (revision.result || 0) + (changed ? 1 : 0);
          if (changed) {
            meta.put(version, "revision");
            // Bounded pre-read certificates for a later explicit local-v2 cut.
            // These do not alter v1 payloads, receipts or writer semantics.
            const storedUpperBound=(request.result as Cookie[]).reduce((n,row)=>n+bytes(JSON.stringify(row)),0)+
              (journal as {op:string;cookie:Cookie}[]).reduce((n,change)=>n+(change.op==="set"?bytes(JSON.stringify(change.cookie)):0),0);
            meta.put({format:2,scope:"complete-stored-jar",revision:version,bytes:storedUpperBound,
              count:request.result.length+journal.length},"local-cookie-migration-size-v2");
            for (const change of journal as {op:string;cookie:Cookie}[]) {
              if (change.op === "delete") meta.delete(["local-cookie-size-v2",change.cookie.id]);
              else meta.put({bytes:bytes(JSON.stringify(change.cookie)),revision:version},["local-cookie-size-v2",change.cookie.id]);
            }
            this.journal(transaction, context.request.origin, journal, version);
          }
          result = { accepted, rejected, revision: version };
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        this.transactions.delete(transaction);
        context.signal?.removeEventListener("abort", abort);
        if (changed) {
          this.notify();
          try {
            this.options.onNativeCommit(context.request.origin);
          } catch {}
        }
        resolve(result!);
      };
      transaction.onabort = () => {
        this.transactions.delete(transaction);
        context.signal?.removeEventListener("abort", abort);
        reject(
          failure ||
            transaction.error ||
            new DOMException("Cookie transaction aborted", "AbortError"),
        );
      };
      transaction.onerror = () => {};
    });
    return outcome;
  }
  async getRequestHeader(value: CookieRequestContext): Promise<string> {
    const context = this.context(value);
    return context.credentials ? (await this.read(context, true)).value : "";
  }
  async storeResponseCookies(
    lines: string[],
    value: CookieRequestContext,
  ): Promise<Outcome> {
    const context = this.context(value);
    return context.credentials
      ? this.write(lines, context, true)
      : {
          accepted: 0,
          rejected: lines.map(() => "cookie_credentials_omitted"),
          revision: 0,
        };
  }
  document(value: CookieDocumentContext) {
    if (!/^[A-Za-z0-9_-]{16,96}$/.test(value.documentId))
      throw new TypeError("Invalid cookie document identity");
    const context = this.context({
      ...value,
      requestURL: value.documentURL,
      credentials: "include",
    });
    const documentId = value.documentId,
      controller = new AbortController(),
      disposers = new Set<() => void>();
    context.signal = controller.signal;
    if (this.closed || this.bindings.size >= 64)
      throw new DOMException(
        "Cookie document limit reached",
        "QuotaExceededError",
      );
    let live = true,
      portBound = false;
    const assertLive = () => {
      if (!live)
        throw new DOMException(
          "Cookie document is disposed",
          "InvalidStateError",
        );
    };
    const snapshot = async () => {
      assertLive();
      const result = await this.read(context, false);
      assertLive();
      return result;
    };
    const set = async (line: string) => {
      assertLive();
      if (typeof line !== "string")
        throw new TypeError("Document cookie must be a string");
      const outcome = await this.write([line], context, false);
      assertLive();
      const current = await snapshot();
      return {
        ...outcome,
        view: current.value,
        revision: current.revision,
        expiresAt: current.expiresAt,
      };
    };
    const subscribe = (listener: (view: View) => void) => {
      assertLive();
      let current = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const update = () => {
        void snapshot()
          .then((value) => {
            if (!current) return;
            clearTimeout(timer);
            if (value.expiresAt !== null)
              timer = setTimeout(
                update,
                Math.max(
                  1,
                  Math.min(24 * 3600000, value.expiresAt - this.options.now()),
                ),
              );
            listener(value);
          })
          .catch(() => {});
      };
      this.listeners.add(update);
      const dispose = () => {
        current = false;
        clearTimeout(timer);
        this.listeners.delete(update);
        disposers.delete(dispose);
      };
      disposers.add(dispose);
      update();
      return dispose;
    };
    const disposeDocument = () => {
      if (!live) return;
      live = false;
      controller.abort(
        new DOMException("Cookie document disposed", "AbortError"),
      );
      for (const dispose of [...disposers]) dispose();
      this.bindings.delete(disposeDocument);
    };
    this.bindings.add(disposeDocument);
    return Object.freeze({
      view: async () => (await snapshot()).value,
      snapshot,
      set,
      subscribe,
      bindPort: (port: MessagePort) => {
        assertLive();
        if (portBound)
          throw new DOMException(
            "Cookie document port already bound",
            "InvalidStateError",
          );
        portBound = true;
        let active = true,
          next = 1,
          pending = 0,
          invalidMessages = 0;
        let tail = Promise.resolve();
        const send = (message: object) => {
          if (active && live)
            port.postMessage({
              protocol: SANDBOX_COOKIE_PROTOCOL,
              documentId,
              ...message,
            });
        };
        const stop = () => {
          if (!active) return;
          active = false;
          port.removeEventListener("message", receive);
          port.close();
          unsubscribe();
          disposers.delete(stop);
          disposeDocument();
        };
        const unsubscribe = subscribe((value) =>
          send({ type: "view", ...value }),
        );
        const receive = (event: MessageEvent) => {
          const message = event.data;
          if (
            !ownKeys(message, [
              "protocol",
              "type",
              "documentId",
              "sequence",
              "cookie",
            ]) ||
            message.protocol !== SANDBOX_COOKIE_PROTOCOL ||
            message.documentId !== documentId ||
            message.sequence !== next ||
            !Number.isSafeInteger(next) ||
            !["get", "set"].includes(message.type) ||
            (message.type === "set"
              ? typeof message.cookie !== "string" ||
                bytes(message.cookie) > MAX_LINE
              : message.cookie !== undefined)
          ) {
            send({ type: "error", code: "invalid_cookie_capability" });
            if (++invalidMessages >= 4) stop();
            return;
          }
          const sequence = next++;
          if (pending >= 8) {
            send({ type: "error", sequence, code: "cookie_backpressure" });
            return;
          }
          pending++;
          tail = tail
            .then(async () => {
              if (!active || !live) return;
              const result =
                message.type === "get"
                  ? await snapshot()
                  : await set(message.cookie);
              send({ type: "result", sequence, ...result });
            })
            .catch((error) =>
              send({
                type: "error",
                sequence,
                code: error?.name || "UnknownError",
              }),
            )
            .finally(() => {
              pending--;
            });
        };
        port.addEventListener("message", receive);
        port.start();
        void snapshot()
          .then((value) => send({ type: "ready", ...value }))
          .catch((error) =>
            send({ type: "error", code: error?.name || "UnknownError" }),
          );
        disposers.add(stop);
        return { dispose: stop };
      },
      dispose: disposeDocument,
    });
  }
  /** Trusted transport integration: callers never choose a Set-Cookie URL from
   * a response body/header. Redirects require a separate checked hop. */
  wrapFetch(
    transport: (
      request: SandboxNetworkRequest,
      context: SandboxNetworkContext,
    ) => Promise<SandboxNetworkResponse>,
    contextFor: (
      request: SandboxNetworkRequest,
      context: SandboxNetworkContext,
    ) => CookieRequestContext,
  ) {
    return async (
      request: SandboxNetworkRequest,
      context: SandboxNetworkContext,
    ) => {
      const supplied = contextFor(request, context),
        authoritative = {
          ...supplied,
          requestURL: request.url,
          documentURL: context.documentURL,
          credentials: request.credentials,
          preflight: context.preflight,
          signal: context.signal,
        };
      const headers = request.headers.filter(
          ([name]) => !/^cookie2?$/i.test(name),
        ),
        cookie = await this.getRequestHeader(authoritative);
      if (cookie) headers.push(["cookie", cookie]);
      const response = await transport({ ...request, headers }, context);
      if (this.check(response.url).href !== this.check(request.url).href)
        throw invalid("cookie_redirect_requires_checked_hop");
      const lines = response.headers
        .filter(([name]) => name.toLowerCase() === "set-cookie")
        .map(([, value]) => value);
      if (lines.length) await this.storeResponseCookies(lines, authoritative);
      return {
        ...response,
        headers: response.headers.filter(
          ([name]) => !/^set-cookie2?$/i.test(name),
        ),
      };
    };
  }
  async endSession() {
    // An account profile is one durable logical browser across frontend hosts.
    // Closing one branch is not the end of every website's profile session.
    if (this.options.profileId) return;
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["cookies", "meta"], "readwrite", {
        durability: "strict",
      });
      this.transactions.add(tx);
      const meta = tx.objectStore("meta"),
        revision = meta.get("revision"),
        store = tx.objectStore("cookies"),
        request = store.getAll();
      let changed = false;
      const journal: unknown[] = [];
      request.onsuccess = () => {
        for (const cookie of request.result as Cookie[])
          if (cookie.sessionId === this.options.browserSessionId) {
            store.delete(cookie.id);
            journal.push({ op: "delete", cookie });
            changed = true;
          }
        if (changed) {
          const version = (revision.result || 0) + 1;
          meta.put(version, "revision");
          this.journal(
            tx,
            "https://" + (journal[0] as any).cookie.domain,
            journal,
            version,
          );
        }
      };
      tx.oncomplete = () => {
        this.transactions.delete(tx);
        resolve();
      };
      tx.onabort = () => {
        this.transactions.delete(tx);
        reject(
          tx.error || new DOMException("End session aborted", "AbortError"),
        );
      };
    });
    this.notify();
  }
  async close() {
    this.closed = true;
    for (const dispose of [...this.bindings]) dispose();
    for (const transaction of this.transactions) {
      try {
        transaction.abort();
      } catch {}
    }
    this.channel?.close();
    this.listeners.clear();
    (await this.database).close();
  }
}
