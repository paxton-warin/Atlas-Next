/** Opaque documents may send Main's native-resource enrollment cookies. These
 * names are ambient transport state, never Hub identity or operation authority.
 * Only callers with an independently validated document/receipt capability may
 * ignore this exact family. Values are deliberately neither read nor trusted.
 */
export function onlyNativeResourceEnrollmentCookies(header) {
  if (header === undefined) return true;
  if (typeof header !== "string" || header.length > 16384) return false;
  const cookies = header
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    cookies.length <= 128 &&
    cookies.every((value) => {
      const separator = value.indexOf("=");
      return (
        separator > 0 &&
        /^__Host-atlas-native-[A-Za-z0-9_-]{16}$/.test(
          value.slice(0, separator),
        )
      );
    })
  );
}
