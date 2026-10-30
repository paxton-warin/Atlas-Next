import {sameLocalActorAuthority, checkedLocalActorAuthority, type LocalActorAuthority} from "./local-authority.ts";
/** Trusted controller-only account context. Opaque website code has no module
 * reference or capability to change this binding. No credentials live here. */
let profile: string | null = null;
export function setActiveProfile(value: string | null): void {
  if (
    value !== null &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new TypeError("Invalid profile identity");
  profile = value;
}
export function getActiveProfile(): string | null {
  return profile;
}

let context: string | undefined;
export type ProfileDocumentOptions = { interactive?: boolean };
let beforeDocument: ((origin: string, options?: ProfileDocumentOptions) => Promise<void>) | undefined;
export function setActiveProfileContext(value?: string) {
  context = value;
}
export function getActiveProfileContext() {
  return context;
}
export function setProfileDocumentGuard(
  fn?: (origin: string, options?: ProfileDocumentOptions) => Promise<void>,
) {
  beforeDocument = fn;
}
export async function prepareProfileDocument(url: string, options?: ProfileDocumentOptions) {
  if (profile) {
    if (!beforeDocument) throw Error("PROFILE_NOT_INITIALIZED");
    await beforeDocument(new URL(url).origin, options);
  }
}

/** V2 local authority has a login generation, but no network lease or expiry. */
let localAuthority: LocalActorAuthority | null = null;
export function getActiveLocalAuthority() { return localAuthority; }
export function setActiveLocalAuthority(value: LocalActorAuthority | null) {
  if (!sameLocalActorAuthority(localAuthority,value)) localSites = new Map();
  localAuthority = value === null ? null : checkedLocalActorAuthority(value);
  localCookieReady = false;
}
export function clearActiveLocalAuthority(expected: LocalActorAuthority) {
  if (!sameLocalActorAuthority(localAuthority, expected)) return false;
  localAuthority = null; localSites = new Map();localCookieReady=false; return true;
}

export type LocalSiteMode = {mode:'local-v2'|'legacy';reason?:string};
let localSites = new Map<string,LocalSiteMode>();
export function setLocalSiteMode(origin:string,value:LocalSiteMode) {localSites.set(new URL(origin).origin,value);}
export function getLocalSiteMode(url:string):LocalSiteMode|undefined {return localAuthority ? localSites.get(new URL(url).origin) : undefined;}

let localCookieReady=false;
export function setLocalCookieProfileReady(value:boolean) {localCookieReady=value;}
export function isLocalCookieProfileReady() {return !!localAuthority&&localCookieReady;}
