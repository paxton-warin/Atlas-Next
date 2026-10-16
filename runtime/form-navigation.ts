/** Only serialized website form navigation crosses the original document port.
 * Headers, initiator identity, CSP and relay selection are trusted-owner fields. */
export type FormNavigation = Readonly<{
  url: string;
  method: "GET" | "POST";
  contentType?: string;
  body?: ArrayBuffer;
}>;
export type TrustedFormNavigation = FormNavigation &
  Readonly<{
    initiatorURL: string;
    authorizeURL: (url: string, redirects: number) => void;
  }>;
export const FORM_NAVIGATION_BYTES = 2 * 1024 * 1024;
export function cleanFormNavigation(
  value: unknown,
): FormNavigation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).some(
      (key) => !["url", "method", "contentType", "body"].includes(key),
    ) ||
    Object.values(descriptors).some((d) => !("value" in d))
  )
    return;
  const v = value as FormNavigation;
  if (
    typeof v.url !== "string" ||
    v.url.length > 16384 ||
    !["GET", "POST"].includes(v.method)
  )
    return;
  let url: URL;
  try {
    url = new URL(v.url);
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
  if (v.method === "GET") {
    if (Object.keys(descriptors).length !== 2) return;
    return Object.freeze({ url: url.href, method: "GET" });
  }
  if (
    Object.keys(descriptors).length !== 4 ||
    !(v.body instanceof ArrayBuffer) ||
    v.body.byteLength > FORM_NAVIGATION_BYTES ||
    typeof v.contentType !== "string" ||
    !/^(?:application\/x-www-form-urlencoded|text\/plain|multipart\/form-data; boundary=[A-Za-z0-9'()+_,.\/:=?-]{1,70})$/.test(
      v.contentType,
    )
  )
    return;
  return Object.freeze({
    url: url.href,
    method: "POST",
    contentType: v.contentType,
    body: v.body.slice(0),
  });
}
