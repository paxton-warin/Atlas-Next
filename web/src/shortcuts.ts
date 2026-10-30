/** Display letters, never the old decorative symbol stored in a saved shortcut. */
export function shortcutInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toLocaleUpperCase();
}

/** Shortcuts are website destinations, not search queries. Default bare hosts to HTTPS. */
export function shortcutURL(value: string): string {
  const input = value.trim();
  if (!input || /\s/u.test(input))
    throw Error("Enter a website address, such as example.com.");
  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  if (
    !hasProtocol &&
    /^[a-z][a-z\d+.-]*:/i.test(input) &&
    !/^[^/:]+:\d+(?:[/?#]|$)/u.test(input)
  )
    throw Error("Use an HTTP or HTTPS website address.");
  let url: URL;
  try {
    url = new URL(
      hasProtocol ? input : "https://" + input.replace(/^\/\//u, ""),
    );
  } catch {
    throw Error("Enter a valid website address, such as example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw Error("Use an HTTP or HTTPS website address.");
  if (url.username || url.password)
    throw Error("Remove credentials from the address.");
  const host = url.hostname;
  if (
    host !== "localhost" &&
    !host.startsWith("[") &&
    !/^(?:[^.]+\.)+[^.]+\.?$/u.test(host)
  )
    throw Error("Enter a full domain, such as example.com.");
  if (
    !host.startsWith("[") &&
    host
      .split(".")
      .filter(Boolean)
      .some((label) => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))
  )
    throw Error("Enter a valid website address, such as example.com.");
  return url.href;
}
