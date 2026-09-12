import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { digest } from "./store.mjs";

export const requestLimitRules = [
  { key: "api", label: "All API requests", max: 600, windowSeconds: 60 },
  {
    key: "suggestions",
    label: "Search suggestions",
    max: 120,
    windowSeconds: 60,
  },
  {
    key: "login",
    label: "Owner sign-in and setup",
    max: 8,
    windowSeconds: 900,
  },
  { key: "ticket", label: "New support tickets", max: 5, windowSeconds: 3600 },
  {
    key: "browse",
    label: "Browsing session requests",
    max: 60,
    windowSeconds: 60,
  },
  {
    key: "node-heartbeat",
    label: "Node heartbeats",
    max: 120,
    windowSeconds: 60,
  },
  { key: "ai", label: "AI chat requests", max: 20, windowSeconds: 3600 },
];
export const defaultRequestLimits = () => ({
  enabled: true,
  whitelist: [],
  aiConcurrent: 2,
  rules: Object.fromEntries(
    requestLimitRules.map(({ key, max, windowSeconds }) => [
      key,
      { max, windowSeconds },
    ]),
  ),
});
const invalid = (message) =>
  Object.assign(new Error(message), { statusCode: 400 });
function address(value) {
  if (typeof value !== "string" || value.includes("%") || !isIP(value))
    throw invalid(`Invalid IP address: ${String(value).slice(0, 100)}`);
  const parsed = ipaddr.parse(value);
  return parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address()
    : parsed;
}
export function normalizeClientIp(value) {
  try {
    return address(value).toString();
  } catch {
    return String(value);
  }
}
function network(value) {
  if (typeof value !== "string" || value.length > 100)
    throw invalid("Whitelist entries must be IP addresses or CIDR ranges.");
  const parts = value.trim().split("/");
  if (parts.length > 2) throw invalid(`Invalid CIDR range: ${value}`);
  const ip = address(parts[0]);
  const bits = ip.kind() === "ipv4" ? 32 : 128;
  let prefix = bits;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1]))
      throw invalid(`Invalid CIDR range: ${value}`);
    prefix = Number(parts[1]);
    // IPv4-mapped IPv6 prefixes cover the 96-bit mapping prefix first.
    if (isIP(parts[0]) === 6 && bits === 32) prefix -= 96;
    if (prefix < 0 || prefix > bits)
      throw invalid(`Invalid CIDR range: ${value}`);
  }
  const bytes = ip
    .toByteArray()
    .map(
      (byte, i) =>
        byte & (0xff << (8 - Math.min(8, Math.max(0, prefix - i * 8)))),
    );
  const base = ipaddr.fromByteArray(bytes);
  return {
    ip: base,
    prefix,
    value: base.toString() + (parts.length === 2 ? `/${prefix}` : ""),
  };
}
function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw invalid(`Invalid ${label}.`);
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw invalid(`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}
export function normalizeRequestLimits(input, base = defaultRequestLimits()) {
  object(
    input,
    ["enabled", "whitelist", "aiConcurrent", "rules"],
    "request limit settings",
  );
  const result = { ...structuredClone(base), ...input };
  if (typeof result.enabled !== "boolean")
    throw invalid("Enabled must be true or false.");
  if (!Array.isArray(result.whitelist) || result.whitelist.length > 256)
    throw invalid(
      "Add up to 256 IP addresses or CIDR ranges to the whitelist.",
    );
  result.whitelist = [
    ...new Set(result.whitelist.map((value) => network(value).value)),
  ];
  result.aiConcurrent = integer(
    result.aiConcurrent,
    0,
    10000,
    "Concurrent AI replies per IP",
  );
  const rules = input.rules === undefined ? {} : input.rules;
  object(
    rules,
    requestLimitRules.map((rule) => rule.key),
    "request rules",
  );
  result.rules = structuredClone(base.rules);
  for (const { key, label } of requestLimitRules) {
    if (!Object.hasOwn(rules, key)) continue;
    object(rules[key], ["max", "windowSeconds"], label);
    const rule = { ...result.rules[key], ...rules[key] };
    result.rules[key] = {
      max: integer(rule.max, 0, 1000000, `${label}: requests`),
      windowSeconds: integer(
        rule.windowSeconds,
        1,
        86400,
        `${label}: window in seconds`,
      ),
    };
  }
  return result;
}
export function environmentRequestLimits(env = process.env) {
  const enabled = env.IP_RATE_LIMIT_ENABLED;
  if (enabled && !["true", "false"].includes(enabled))
    throw invalid("IP_RATE_LIMIT_ENABLED must be true or false.");
  let rules = {};
  try {
    rules = env.IP_RATE_LIMIT_RULES ? JSON.parse(env.IP_RATE_LIMIT_RULES) : {};
  } catch {
    throw invalid("IP_RATE_LIMIT_RULES must be a JSON object.");
  }
  return normalizeRequestLimits({
    enabled: enabled !== "false",
    whitelist: (env.IP_RATE_LIMIT_WHITELIST || "")
      .split(/[\s,]+/)
      .filter(Boolean),
    aiConcurrent: env.IP_RATE_LIMIT_AI_CONCURRENT
      ? Number(env.IP_RATE_LIMIT_AI_CONCURRENT)
      : 2,
    rules,
  });
}
export function createRequestLimits(store, rate, env = process.env) {
  let policy = normalizeRequestLimits(
    store.get("ipRequestLimits") ?? environmentRequestLimits(env),
  );
  let networks = policy.whitelist.map(network);
  function bypass(clientIp) {
    if (!policy.enabled) return true;
    let ip;
    try {
      ip = address(clientIp);
    } catch {
      return false;
    }
    return networks.some(
      (entry) =>
        ip.kind() === entry.ip.kind() && ip.match(entry.ip, entry.prefix),
    );
  }
  return {
    current: () => structuredClone(policy),
    save(input) {
      const next = normalizeRequestLimits(input, policy);
      const clear = store.db.prepare(
        "DELETE FROM limits WHERE key LIKE ? AND key NOT LIKE 'ai:day:%'",
      );
      store.db.exec("BEGIN");
      try {
        store.set("ipRequestLimits", next);
        for (const { key } of requestLimitRules) clear.run(key + ":%");
        store.audit("request-limits.update");
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
      policy = next;
      networks = policy.whitelist.map(network);
      return structuredClone(policy);
    },
    limit(clientIp, key) {
      const rule = policy.rules[key];
      if (!rule) throw new Error(`Unknown IP request rule: ${key}`);
      if (!rule.max || bypass(clientIp)) return;
      rate(
        key + ":" + digest(normalizeClientIp(clientIp)),
        rule.max,
        rule.windowSeconds * 1000,
      );
    },
    aiCapacity(clientIp) {
      return bypass(clientIp) || !policy.aiConcurrent
        ? Infinity
        : policy.aiConcurrent;
    },
  };
}
