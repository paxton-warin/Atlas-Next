// A self-contained, versioned URL codec. The controller serializes these
// functions into page/worker realms, so they must not close over module state.
// This removes literal destinations from wrapper paths, not access to page
// content by browser extensions. It is encoding, not encryption.
export function encodeTarget(value: string): string {
  if (!value) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (
    "v1." +
    btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

export function decodeTarget(value: string): string {
  if (!value) return value;
  // Previously saved escaped URLs remain readable during a rolling update.
  if (!value.startsWith("v1.")) return decodeURIComponent(value);
  const encoded = value.slice(3);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1)
    throw Error("Invalid page address.");
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (byte) => byte.charCodeAt(0)),
  );
}
