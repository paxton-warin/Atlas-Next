import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LinkInput } from "@atlas-link-dispenser/shared";
import { AppError } from "./errors.js";
export function validatedPublicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError("VALIDATION_ERROR", `Invalid URL: ${value}`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new AppError(
      "VALIDATION_ERROR",
      `Only credential-free HTTP(S) URLs are accepted: ${value}`,
    );
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Private-network URLs are not allowed.",
    );
  return url.toString();
}
const privateAddress = (host: string) =>
  host === "::1" ||
  host === "::" ||
  host.startsWith("fc") ||
  host.startsWith("fd") ||
  host.startsWith("fe80:") ||
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host);
export async function assertPublicDestination(value: string) {
  const url = new URL(validatedPublicUrl(value));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => privateAddress(address.toLowerCase()))
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "This destination resolves to a private network and cannot be checked.",
    );
  return url;
}
export function parseBulkLinks(text: string): LinkInput[] {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rows.length || rows.length > 5000)
    throw new AppError(
      "VALIDATION_ERROR",
      "Paste between 1 and 5,000 links at a time.",
    );
  const seen = new Set<string>();
  return rows.map((line, index) => {
    const divider = line.includes("|") ? "|" : line.includes("\t") ? "\t" : "";
    const parts = divider
      ? line.split(divider).map((value) => value.trim())
      : [line];
    const rawUrl = parts.length > 1 ? parts.at(-1)! : parts[0]!;
    const url = validatedPublicUrl(rawUrl);
    if (seen.has(url))
      throw new AppError(
        "VALIDATION_ERROR",
        `Duplicate URL on line ${index + 1}.`,
      );
    seen.add(url);
    return {
      name: (parts.length > 1
        ? parts.slice(0, -1).join(" ")
        : new URL(url).hostname
      ).slice(0, 160),
      url,
      enabled: true,
      capacity: null,
      weight: 1,
      notes: "",
      healthMonitoring: true,
    };
  });
}
