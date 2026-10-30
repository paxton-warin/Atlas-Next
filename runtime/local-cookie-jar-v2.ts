/** Dedicated browser-local cookie jar. The dependency graph contains native
 * storage names, local capabilities and dirty metadata only; no cloud permits,
 * replication journal, Hub request, lease, backup codec or scheduler. */
import { profileDatabaseName } from "./local-storage-names.ts";
import { appendLocalDirty } from "./local-dirty-v2.ts";
import {
  checkedLocalActorAuthority,
  sameLocalActorAuthority,
  type LocalActorAuthority,
} from "./local-authority.ts";
import type { CookieViewEntry } from "./sandbox-cookie-result.ts";
/** Frontend-owned browser cookie authority for the opaque runtime.
 * The persistent jar never enters an untrusted document. Document capabilities
 * expose only a URL-bound, path/domain/Secure/SameSite-filtered non-HttpOnly
 * cookie string. Network Set-Cookie commits complete before wrapped fetch does.
 */
import { parse as parseDomain } from "tldts";

export const SANDBOX_COOKIE_DATABASE = "atlas.browsing.cookies.v2";
export const SANDBOX_COOKIE_PROTOCOL = "atlas-cookies-v2";
const LIFETIME = 400 * 24 * 60 * 60 * 1000;
const MAX_LINE = 16384;
// These are admission estimates, not claims about the browser's physical heap.
const MAX_CACHED_PARTITIONS = 64;
const MAX_CACHED_PARTITION_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_VIEWS = 256;
const MAX_CACHED_VIEW_BYTES = 1024 * 1024;
const MAX_SITE_TOKENS = 128;
const MAX_IDENTITY_LOOKUPS = 8;
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
type Outcome = {
  accepted: number;
  rejected: string[];
  revision: number;
  baseRevision?: number;
  acceptedChanges?: { op: "set" | "delete"; cookie: Cookie }[];
};
type LocalCookieMutationIdentity = { binding: string; sequence: number };
type View = {
  value: string;
  revision: number;
  expiresAt: number | null;
  entries?: CookieViewEntry[];
};
type Partition = { cookies: Cookie[]; revision: number };
type SiteUsage = {
  format: 1; site: string; revision: number; count: number; bytes: number;
  // Conservative earliest expiry: it may be earlier after a deletion, never later.
  nextExpiry: number | null;
};
function checkedSiteUsage(value: unknown, site: string, revision: number, usage: any, now: number): SiteUsage | undefined {
  const v = value as SiteUsage | undefined;
  if (!v || v.format !== 1 || v.site !== site || v.revision !== revision ||
      !Number.isSafeInteger(v.count) || v.count < 0 || !Number.isSafeInteger(v.bytes) || v.bytes < 0 ||
      !usage || !Number.isSafeInteger(usage.count) || usage.count < v.count ||
      !Number.isSafeInteger(usage.bytes) || usage.bytes < v.bytes ||
      !(v.nextExpiry === null || (Number.isFinite(v.nextExpiry) && v.nextExpiry > now))) return;
  return v;
}
function sameCookieState(a: Cookie, b: Cookie): boolean {
  // created is retained on replacement. accessed is internal bookkeeping, not
  // a reason to rewrite an otherwise identical visible/session/expiry state.
  return a.id === b.id && a.name === b.name && a.value === b.value &&
    a.domain === b.domain && a.hostOnly === b.hostOnly && a.path === b.path &&
    a.secure === b.secure && a.httpOnly === b.httpOnly && a.sameSite === b.sameSite &&
    a.partition === b.partition && a.sessionId === b.sessionId &&
    a.expires === b.expires && a.site === b.site;
}
function cookieCacheBytes(cookie: Cookie): number {
  return 256 + 2 * (cookie.id.length + cookie.name.length + cookie.value.length +
    cookie.domain.length + cookie.path.length + cookie.site.length);
}
const cookieViewEntry = (cookie: Cookie): CookieViewEntry => ({
  id: cookie.id,
  name: cookie.name,
  value: cookie.value,
  path: cookie.path,
  created: cookie.created,
  expiresAt: cookie.expires,
});
type Options = {
  factory: IDBFactory;
  profileId?: string | null;
  localAuthority?: LocalActorAuthority;
  localAuthorityCurrent?: () => LocalActorAuthority | null;
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

export class LocalCookieJarV2 {
  private readonly factory: IDBFactory;
  private readonly database: Promise<IDBDatabase>;
  private readonly forbidden: Set<string>;
  private readonly options: Required<
    Omit<
      Options,
      | "factory"
      | "forbiddenOrigins"
      | "localAuthority"
      | "localAuthorityCurrent"
    >
  >;
  private readonly listeners = new Set<() => void>();
  private readonly bindings = new Set<() => void>();
  private readonly transactions = new Set<IDBTransaction>();
  private readonly channel?: BroadcastChannel;
  private closed = false;
  private readonly localAuthority: LocalActorAuthority;
  private readonly localAuthorityCurrent?: () => LocalActorAuthority | null;
  private cacheEpoch = 0;
  private latestRevision = 0;
  private latestSourceDocument: string | null = null;
  private latestChangedSite: string | null = null;
  private readonly headerViews = new Map<string, { site: string; view: View; bytes: number }>();
  // An exact hint for this Map's last insertion, not a cookie-validity cache.
  // Repeated hits already at the MRU position need no delete/set promotion.
  private lastHeaderViewKey: string | null = null;
  private headerViewBytes = 0;
  private partitionBytes = 0;
  // Identity tokens fence an in-flight read without unbounded site counters.
  private readonly siteTokens = new Map<string, object>();
  // Expendable write-side certificates. A restart may scan once; no schema or
  // orphan persistent rows are introduced. Publication happens only oncomplete.
  private readonly siteUsageProofs = new Map<string, SiteUsage>();
  private readonly partitionReads = new Map<
    string,
    { epoch: number; token: object; promise: Promise<Partition> }
  >();
  private readonly partitions = new Map<
    string,
    Partition & { cacheBytes: number }
  >();
  private dropPartition(site: string) {
    const prior = this.partitions.get(site);
    if (prior) this.partitionBytes -= prior.cacheBytes;
    this.partitions.delete(site);
  }
  private siteToken(site: string): object {
    const prior = this.siteTokens.get(site);
    if (prior) {
      this.siteTokens.delete(site);
      this.siteTokens.set(site, prior);
      return prior;
    }
    while (this.siteTokens.size >= MAX_SITE_TOKENS) {
      const oldest = this.siteTokens.keys().next().value!;
      this.siteTokens.delete(oldest);
      this.dropPartition(oldest);
      this.partitionReads.delete(oldest);
    }
    const token = {};
    this.siteTokens.set(site, token);
    return token;
  }
  private rememberPartition(site: string, partition: Partition): Partition {
    const cacheBytes = 128 + partition.cookies.reduce((n, cookie) => n + cookieCacheBytes(cookie), 0);
    this.dropPartition(site);
    if (cacheBytes > MAX_CACHED_PARTITION_BYTES) return partition;
    while (this.partitions.size >= MAX_CACHED_PARTITIONS ||
      this.partitionBytes + cacheBytes > MAX_CACHED_PARTITION_BYTES) {
      this.dropPartition(this.partitions.keys().next().value!);
    }
    const cached = { ...partition, cacheBytes };
    this.partitions.set(site, cached);
    this.partitionBytes += cacheBytes;
    return cached;
  }
  private dropView(key: string) {
    const prior = this.headerViews.get(key);
    if (prior) this.headerViewBytes -= prior.bytes;
    this.headerViews.delete(key);
    if (this.lastHeaderViewKey === key) this.lastHeaderViewKey = null;
  }
  private invalidateViews(site?: string) {
    if (site === undefined) {
      this.cacheEpoch++;
      this.partitions.clear();
      this.partitionReads.clear();
      this.siteTokens.clear();
      this.siteUsageProofs.clear();
      this.headerViews.clear();
      this.lastHeaderViewKey = null;
      this.partitionBytes = this.headerViewBytes = 0;
      return;
    }
    this.dropPartition(site);
    this.partitionReads.delete(site);
    this.siteTokens.delete(site);
    for (const [key, cached] of this.headerViews)
      if (cached.site === site) this.dropView(key);
  }
  private assertLocal() {
    if (
      this.localAuthority &&
      !sameLocalActorAuthority(
        this.localAuthority,
        this.localAuthorityCurrent
          ? this.localAuthorityCurrent()
          : this.localAuthority,
      )
    )
      throw new DOMException(
        "Local cookie authorization is no longer current",
        "SecurityError",
      );
  }
  private assertWrite(_origin: string) {
    this.assertLocal();
    return Promise.resolve();
  }
  private assertWriteCached(_origin: string) {
    this.assertLocal();
  }
  constructor(options: Options) {
    this.factory = options.factory;
    this.localAuthority = checkedLocalActorAuthority(options.localAuthority);
    this.localAuthorityCurrent = options.localAuthorityCurrent;
    if (options.profileId !== this.localAuthority.replicaId)
      throw new DOMException(
        "Local cookie physical namespace mismatch",
        "SecurityError",
      );
    this.assertLocal();
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
        const cookies = request.result.createObjectStore("cookies", {
          keyPath: "id",
        });
        if (this.localAuthority) {
          cookies.createIndex("site", "site");
          cookies.createIndex("domain", "domain");
          cookies.createIndex("expires", "expires");
        }
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
        if (event.data?.type === "changed")
          this.notify(
            false,
            event.data.revision,
            event.data.sourceDocumentId,
            event.data.site,
          );
      };
    }
  }
  private journal(
    tx: IDBTransaction,
    _origin: string,
    changes: unknown[],
    _revision: number,
  ) {
    for (const change of changes as { op: string; cookie: Cookie }[])
      appendLocalDirty(tx.objectStore("meta"), {
        namespace: JSON.stringify(["cookies", change.cookie.site, ""]),
        key: change.cookie.id,
        operation: change.op === "delete" ? "delete" : "upsert",
        estimatedNativeBytes: bytes(JSON.stringify(change.cookie)),
        shapeEligible: true,
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
  private notify(
    broadcast = true,
    revision?: number,
    sourceDocumentId?: string,
    changedSite?: string,
  ) {
    this.latestSourceDocument = sourceDocumentId || null;
    const site = typeof changedSite === "string" && changedSite ? changedSite : undefined;
    this.latestChangedSite = site || null;
    if (Number.isSafeInteger(revision) && revision! >= 0)
      this.latestRevision = Math.max(this.latestRevision, revision!);
    this.invalidateViews(site);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
    if (broadcast)
      this.channel?.postMessage({
        type: "changed",
        revision: this.latestRevision,
        sourceDocumentId,
        site,
      });
  }
  private async readLocal(context: Context, fromHTTP: boolean): Promise<View> {
    this.assertLocal();
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    if (context.signal?.aborted)
      throw (
        context.signal.reason ||
        new DOMException("Cookie read aborted", "AbortError")
      );
    const site =
      parseDomain(context.request.hostname, { allowPrivateDomains: true })
        .domain || context.request.hostname;
    const cacheKey = JSON.stringify([
      // Query/hash do not change cookie visibility. Preserve origin and exact
      // path, plus every existing security/credentials/SameSite input.
      context.request.origin,
      context.request.pathname,
      context.document.origin,
      context.site,
      context.top.origin,
      context.method,
      context.navigation,
      context.credentials,
      fromHTTP,
    ]);
    const cached = this.headerViews.get(cacheKey),
      currentTime = this.options.now();
    if (cached && (cached.view.expiresAt === null || cached.view.expiresAt > currentTime)) {
      if (this.lastHeaderViewKey !== cacheKey) {
        this.headerViews.delete(cacheKey);
        this.headerViews.set(cacheKey, cached);
        this.lastHeaderViewKey = cacheKey;
      }
      return cached.view;
    }
    if (cached) this.dropView(cacheKey);
    const token = this.siteToken(site);
    let partition: Partition | undefined = this.partitions.get(site);
    if (partition) {
      this.partitions.delete(site);
      this.partitions.set(site, partition as Partition & { cacheBytes: number });
    }
    if (!partition) {
      const capturedEpoch = this.cacheEpoch;
      let pending = this.partitionReads.get(site);
      if (!pending || pending.epoch !== capturedEpoch || pending.token !== token) {
        const promise = this.database.then((db) => {
          this.assertLocal();
          return new Promise<Partition>(
            (resolve, reject) => {
              const tx = db.transaction(["cookies", "meta"], "readonly"),
                revision = tx.objectStore("meta").get("revision"),
                rows = tx.objectStore("cookies").index("site").getAll(site);
              this.transactions.add(tx);
              tx.oncomplete = () => {
                this.transactions.delete(tx);
                resolve({
                  cookies: rows.result,
                  revision: revision.result || 0,
                });
              };
              tx.onabort = () => {
                this.transactions.delete(tx);
                reject(
                  tx.error ||
                    new DOMException("Cookie read aborted", "AbortError"),
                );
              };
            },
          );
        });
        pending = { epoch: capturedEpoch, token, promise };
        this.partitionReads.set(site, pending);
        const identity = pending;
        void promise
          .finally(() => {
            if (this.partitionReads.get(site) === identity)
              this.partitionReads.delete(site);
          })
          .catch(() => {});
      }
      partition = await pending.promise;
      this.assertLocal();
      // A concurrent writer can invalidate a cache, not the completed readonly
      // cut. Never starve a cookie read by retrying behind continuous writes.
      if (capturedEpoch === this.cacheEpoch && this.siteTokens.get(site) === token)
        partition = this.rememberPartition(site, partition);
    }
    const now = this.options.now(),
      selected = partition.cookies.filter((cookie) =>
        cookieMatches(
          cookie,
          context,
          fromHTTP,
          this.options.browserSessionId,
          now,
        ),
      );
    selected.sort(
      (a, b) =>
        b.path.length - a.path.length ||
        a.created - b.created ||
        a.id.localeCompare(b.id),
    );
    const view: View = {
      value: selected
        .map((cookie) =>
          cookie.name ? cookie.name + "=" + cookie.value : cookie.value,
        )
        .join("; "),
      revision: partition.revision,
      // HTTP only needs its header; entry arrays belong to document snapshots.
      ...(fromHTTP ? {} : { entries: selected.map(cookieViewEntry) }),
      expiresAt: selected.reduce<number | null>(
        (n, cookie) =>
          cookie.expires === null
            ? n
            : n === null
              ? cookie.expires
              : Math.min(n, cookie.expires),
        null,
      ),
    };
    if (this.partitions.get(site) === partition) {
      const size = 256 + 2 * (cacheKey.length + site.length + view.value.length) +
        (view.entries?.reduce((n, e) => n + 128 + 2 * (e.id.length + e.name.length + e.value.length + e.path.length), 0) || 0);
      if (size <= MAX_CACHED_VIEW_BYTES) {
        this.dropView(cacheKey);
        while (this.headerViews.size >= MAX_CACHED_VIEWS ||
          this.headerViewBytes + size > MAX_CACHED_VIEW_BYTES)
          this.dropView(this.headerViews.keys().next().value!);
        this.headerViews.set(cacheKey, { site, view, bytes: size });
        this.lastHeaderViewKey = cacheKey;
        this.headerViewBytes += size;
      }
    }
    return view;
  }
  private read(context: Context, fromHTTP: boolean) {
    return this.readLocal(context, fromHTTP);
  }
  private async write(
    lines: string[],
    context: Context,
    fromHTTP: boolean,
    identity?: LocalCookieMutationIdentity,
  ): Promise<Outcome> {
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    if (context.signal?.aborted)
      throw (context.signal.reason || new DOMException("Cookie write aborted", "AbortError"));
    if (!Array.isArray(lines) || lines.length > 128 || lines.some(line => typeof line !== "string"))
      throw new TypeError("Set-Cookie requires separate bounded header lines");
    await this.assertWrite(context.request.origin);
    const db = await this.database;
    if (this.closed)
      throw new DOMException("Cookie authority is closed", "InvalidStateError");
    return new Promise<Outcome>((resolve, reject) => {
      const transaction = db.transaction(["cookies", "meta"], "readwrite", { durability: "default" });
      this.transactions.add(transaction);
      const store = transaction.objectStore("cookies"), meta = transaction.objectStore("meta"),
        revision = meta.get("revision"),
        priorIdentity = this.localAuthority && identity
          ? meta.get(["local-cookie-result-v2", identity.binding, identity.sequence]) : undefined,
        usage = this.localAuthority ? meta.get("local-usage-v2") : undefined,
        requestSite = parseDomain(context.request.hostname, { allowPrivateDomains: true }).domain || context.request.hostname,
        metadataTail = usage || priorIdentity || revision;
      let failure: unknown, result: Outcome, changed = false, nextProof: SiteUsage | null | undefined;
      const fail = (error: unknown) => {
        failure = error;
        try { transaction.abort(); } catch {}
      };
      const abort = () => fail(context.signal?.reason || new DOMException("Cookie write aborted", "AbortError"));
      context.signal?.addEventListener("abort", abort, { once: true });
      const guard = (work: () => void) => {
        try {
          this.assertWriteCached(context.request.origin);
          if (context.signal?.aborted) return abort();
          work();
        } catch (error) { fail(error); }
      };
      const scan = () => {
        const request = store.index("site").getAll(requestSite);
        request.onsuccess = () => guard(() => apply(request.result as Cookie[], undefined, this.options.now()));
      };
      const apply = (rows: Cookie[], proof: SiteUsage | undefined, now: number,
        prepared?: ReturnType<typeof parseLine>[]) => {
        const all = new Map<string, Cookie>(), journal: { op: "set" | "delete"; cookie: Cookie }[] = [],
          sizes = new WeakMap<Cookie, number>();
        const sizeOf = (cookie: Cookie) => {
          let size = sizes.get(cookie);
          if (size === undefined) { size = bytes(JSON.stringify(cookie)); sizes.set(cookie, size); }
          return size;
        };
        const beforeCount = proof ? proof.count : rows.length,
          beforeBytes = proof ? proof.bytes : rows.reduce((sum, cookie) => sum + sizeOf(cookie), 0);
        let count = beforeCount, size = beforeBytes, nextExpiry = proof?.nextExpiry ?? null;
        const earlier = (expiry: number | null) => {
          if (expiry !== null) nextExpiry = nextExpiry === null ? expiry : Math.min(nextExpiry, expiry);
        };
        for (const cookie of rows) {
          if (cookie.expires !== null && cookie.expires <= now) {
            if (cookie.site === requestSite) {
              count--; size -= sizeOf(cookie); journal.push({ op: "delete", cookie });
            }
          } else { all.set(cookie.id, cookie); if (!proof) earlier(cookie.expires); }
        }
        let accepted = 0;
        const acceptedChanges: { op: "set" | "delete"; cookie: Cookie }[] = [], rejected: string[] = [];
        for (let index = 0; index < lines.length; index++) {
          const parsed = prepared?.[index] ?? parseLine(lines[index], context, fromHTTP, this.options.browserSessionId, now),
            cookie = parsed.cookie && { ...parsed.cookie };
          if (!cookie) { rejected.push(parsed.reason!); continue; }
          const previous = all.get(cookie.id);
          if (!fromHTTP && previous?.httpOnly) { rejected.push("cookie_httponly_overwrite_denied"); continue; }
          if (!secure(context.request) && !cookie.secure && [...all.values()].some(old =>
            old.secure && old.name === cookie.name &&
            (cookieDomainMatches(old.domain, cookie.domain) || cookieDomainMatches(cookie.domain, old.domain)) &&
            cookiePathMatches(cookie.path, old.path))) {
            rejected.push("cookie_secure_overlay_denied"); continue;
          }
          accepted++;
          if (cookie.expires !== null && cookie.expires <= now) {
            acceptedChanges.push({ op: "delete", cookie });
            if (all.delete(cookie.id)) {
              count--; size -= sizeOf(previous!); journal.push({ op: "delete", cookie });
            }
            continue;
          }
          if (previous) cookie.created = previous.created;
          if (previous && sameCookieState(previous, cookie)) {
            acceptedChanges.push({ op: "set", cookie: previous }); continue;
          }
          count += previous ? 0 : 1;
          size += sizeOf(cookie) - (previous ? sizeOf(previous) : 0);
          earlier(cookie.expires);
          all.set(cookie.id, cookie); acceptedChanges.push({ op: "set", cookie }); journal.push({ op: "set", cookie });
        }
        const aggregate = this.localAuthority
          ? { count: (usage?.result?.count || 0) + count - beforeCount,
              bytes: (usage?.result?.bytes || 0) + size - beforeBytes }
          : { count, bytes: size };
        if (aggregate.count > this.options.maxCookies || aggregate.bytes > this.options.maxBytes || count > this.options.maxCookiesPerSite) {
          // No source writes have been queued yet. A pressure fallback can
          // reclaim expired rows without replaying any partially applied set.
          if (proof) return scan();
          throw new DOMException("Cookie quota exceeded", "QuotaExceededError");
        }
        changed = journal.length > 0;
        const version = (revision.result || 0) + (changed ? 1 : 0);
        for (const item of journal) {
          if (item.op === "delete") store.delete(item.cookie.id); else store.put(item.cookie);
        }
        if (changed) {
          meta.put(version, "revision"); meta.put(aggregate, "local-usage-v2");
          this.journal(transaction, context.request.origin, journal, version);
        }
        // Capture only after successful validation. The certificate becomes
        // reusable in oncomplete, never while a source commit is uncertain.
        nextProof = count > 0 ? { format: 1, site: requestSite, revision: version,
          count, bytes: size, nextExpiry } : null;
        result = { accepted, rejected, revision: version,
          ...(this.localAuthority && identity ? { baseRevision: revision.result || 0, acceptedChanges } : {}) };
        if (this.localAuthority && identity) {
          meta.put(result, ["local-cookie-result-v2", identity.binding, identity.sequence]);
          if (identity.sequence > 8) meta.delete(IDBKeyRange.bound(
            ["local-cookie-result-v2", identity.binding], ["local-cookie-result-v2", identity.binding, identity.sequence - 8]));
        }
      };
      // This callback runs after revision, result identity and usage requests.
      metadataTail.onsuccess = () => guard(() => {
        if (priorIdentity?.result) { result = priorIdentity.result; return; }
        const now = this.options.now(), proof = checkedSiteUsage(this.siteUsageProofs.get(requestSite), requestSite, revision.result || 0, usage?.result, now);
        if (!proof || !secure(context.request)) return scan();
        const prepared = lines.map(line => parseLine(line, context, fromHTTP, this.options.browserSessionId, now)),
          ids = [...new Set(prepared.flatMap(p => p.cookie ? [p.cookie.id] : []))];
        if (ids.length > MAX_IDENTITY_LOOKUPS || prepared.some(p => p.cookie && p.cookie.site !== requestSite)) return scan();
        if (!ids.length) return apply([], proof, now, prepared);
        const rows: Cookie[] = [];
        let remaining = ids.length;
        for (const id of ids) {
          const r = store.get(id);
          r.onsuccess = () => guard(() => {
            if (r.result) rows.push(r.result);
            if (--remaining) return;
            const currentTime = this.options.now();
            if ((proof.nextExpiry !== null && proof.nextExpiry <= currentTime) ||
                rows.some(row => row.site !== requestSite || (row.expires !== null &&
                  (row.expires <= currentTime || proof.nextExpiry === null || row.expires < proof.nextExpiry))) ||
                rows.length > proof.count || rows.reduce((sum, row) => sum + bytes(JSON.stringify(row)), 0) > proof.bytes)
              return scan();
            apply(rows, proof, now, prepared);
          });
        }
      });
      transaction.oncomplete = () => {
        this.transactions.delete(transaction); context.signal?.removeEventListener("abort", abort);
        if (nextProof !== undefined) {
          this.siteUsageProofs.delete(requestSite);
          if (nextProof) {
            while (this.siteUsageProofs.size >= MAX_CACHED_PARTITIONS)
              this.siteUsageProofs.delete(this.siteUsageProofs.keys().next().value!);
            this.siteUsageProofs.set(requestSite, nextProof);
          }
        }
        if (changed) {
          this.notify(true, result.revision, identity?.binding.split(":")[0], requestSite);
          try { this.options.onNativeCommit(context.request.origin); } catch {}
        }
        resolve(result!);
      };
      transaction.onabort = () => {
        this.transactions.delete(transaction); context.signal?.removeEventListener("abort", abort);
        reject(failure || transaction.error || new DOMException("Cookie transaction aborted", "AbortError"));
      };
      transaction.onerror = () => {};
    });
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
    const localIdentities = new Set<string>();
    const set = async (
      line: string,
      identity?: LocalCookieMutationIdentity,
    ) => {
      assertLive();
      if (typeof line !== "string")
        throw new TypeError("Document cookie must be a string");
      if (
        identity &&
        (!this.localAuthority ||
          !/^[A-Za-z0-9_:-]{16,196}$/.test(identity.binding) ||
          !Number.isSafeInteger(identity.sequence) ||
          identity.sequence < 1)
      )
        throw new TypeError("Invalid local cookie mutation identity");
      if (identity) localIdentities.add(identity.binding);
      const outcome = await this.write([line], context, false, identity);
      assertLive();
      if (this.localAuthority && identity) {
        const upsert: CookieViewEntry[] = [],
          remove: string[] = [];
        for (const change of outcome.acceptedChanges || []) {
          if (
            change.op === "set" &&
            cookieMatches(
              change.cookie,
              context,
              false,
              this.options.browserSessionId,
              this.options.now(),
            )
          )
            upsert.push(cookieViewEntry(change.cookie));
          else remove.push(change.cookie.id);
        }
        return {
          ...outcome,
          view: "",
          expiresAt: null,
          delta: { baseRevision: outcome.baseRevision || 0, upsert, remove },
        };
      }
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
      if (this.localAuthority && localIdentities.size)
        void this.database
          .then((db) => {
            const tx = db.transaction("meta", "readwrite"),
              meta = tx.objectStore("meta");
            for (const identity of localIdentities)
              meta.delete(
                IDBKeyRange.bound(
                  ["local-cookie-result-v2", identity],
                  ["local-cookie-result-v2", identity + "\0"],
                  false,
                  true,
                ),
              );
          })
          .catch(() => {});
    };
    this.bindings.add(disposeDocument);
    return Object.freeze({
      view: async () => (await snapshot()).value,
      snapshot,
      set,
      observeChanges: (listener: (revision: number) => void) => {
        assertLive();
        const changed = () => {
          if (this.latestSourceDocument === documentId) return;
          const localSite =
            parseDomain(context.request.hostname, { allowPrivateDomains: true })
              .domain || context.request.hostname;
          if (this.latestChangedSite && this.latestChangedSite !== localSite)
            return;
          listener(this.latestRevision);
        };
        this.listeners.add(changed);
        const stop = () => {
          this.listeners.delete(changed);
          disposers.delete(stop);
        };
        disposers.add(stop);
        return stop;
      },
      subscribe,
      dispose: disposeDocument,
    });
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
    this.invalidateViews();
    (await this.database).close();
  }
}
