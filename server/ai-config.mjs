// Fixed provider origins keep a saved key tied to its provider. Custom endpoints
// remain supported, but are never eligible for free-only routing.
export const providerPresets = [
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    protocol: "chat-completions",
    model: "openai/gpt-oss-120b",
    billing: "free",
    limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "chat-completions",
    model: "gemini-3.5-flash-lite",
    billing: "free",
    limits: { rpm: 5, rpd: 100, tpm: 8000, tpd: 100000 },
  },
  {
    id: "xai",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    protocol: "responses",
    model: "grok-4.6",
    billing: "paid",
    limits: { rpm: 10, rpd: 100, tpm: 20000, tpd: 200000 },
  },
  {
    id: "custom",
    name: "Custom provider",
    baseUrl: "https://api.openai.com/v1",
    protocol: "responses",
    model: "",
    billing: "paid",
    limits: { rpm: 10, rpd: 200, tpm: 30000, tpd: 300000 },
  },
];
export function defaultAiConfig() {
  return {
    version: 2,
    enabled: false,
    freeOnly: true,
    allowGeminiDataUse: false,
    dailyLimit: 200,
    maxOutputTokens: 1024,
    providers: providerPresets.map((p) => ({
      ...structuredClone(p),
      enabled: p.id === "groq",
      freeTierConfirmed: false,
      key: "",
    })),
  };
}
const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw bad(`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}
export function freeEligible(p) {
  const preset = providerPresets.find((v) => v.id === p.id);
  const models = {
    groq: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  };
  return (
    p.billing === "free" &&
    p.freeTierConfirmed === true &&
    p.baseUrl === preset?.baseUrl &&
    models[p.id]?.includes(p.model) === true
  );
}
export function routingReason(config, p) {
  if (!p.enabled) return "Disabled";
  if (!p.key || !p.model) return "Add an API key and model";
  if (config.freeOnly && !freeEligible(p)) return "Excluded by free-only mode";
  if (p.id === "gemini" && p.billing === "free" && !config.allowGeminiDataUse)
    return "Gemini data-use acknowledgement required";
  return "";
}
export function createAiConfig(store, env = process.env) {
  function read() {
    const saved = store.get("aiRouting");
    if (saved)
      return {
        ...saved,
        providers: saved.providers.map((p) => ({
          ...p,
          key: p.key ? store.unseal(p.key) : "",
        })),
      };
    const legacy = store.get("aiConfig");
    const c = defaultAiConfig();
    // Preserve an explicitly configured existing provider; do not silently reroute
    // its chats or pretend that an existing paid account is a free-tier account.
    if (legacy || env.AI_API_KEY || env.AI_MODEL || env.AI_ENABLED === "true") {
      const old = legacy
        ? { ...legacy, key: legacy.key ? store.unseal(legacy.key) : "" }
        : {
            enabled: env.AI_ENABLED === "true",
            baseUrl: env.AI_BASE_URL || "https://api.openai.com/v1",
            model: env.AI_MODEL || "",
            protocol:
              env.AI_PROTOCOL === "chat-completions"
                ? "chat-completions"
                : "responses",
            key: env.AI_API_KEY || "",
            dailyLimit: 200,
          };
      c.enabled = old.enabled;
      c.freeOnly = false;
      c.dailyLimit = old.dailyLimit;
      c.maxOutputTokens = 2048;
      c.providers.forEach((p) => (p.enabled = false));
      Object.assign(
        c.providers.find((p) => p.id === "custom"),
        old,
        {
          id: "custom",
          name: "Custom provider",
          billing: "paid",
          freeTierConfirmed: false,
        },
      );
      c.providers.sort(
        (a, b) => Number(b.id === "custom") - Number(a.id === "custom"),
      );
    }
    return c;
  }
  function save(b) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      throw bad("Invalid AI settings.");
    const old = read();
    for (const key of ["enabled", "freeOnly", "allowGeminiDataUse"])
      if (typeof b[key] !== "boolean") throw bad(`Invalid ${key} setting.`);
    if (
      !Array.isArray(b.providers) ||
      b.providers.length !== providerPresets.length ||
      new Set(b.providers.map((p) => p?.id)).size !== providerPresets.length
    )
      throw bad("Configure each provider exactly once.");
    const next = {
      version: 2,
      enabled: b.enabled,
      freeOnly: b.freeOnly,
      allowGeminiDataUse: b.allowGeminiDataUse,
      dailyLimit: integer(b.dailyLimit, 1, 1000000, "Global daily requests"),
      maxOutputTokens: integer(
        b.maxOutputTokens,
        128,
        4096,
        "Reply token limit",
      ),
      providers: b.providers.map((p) => {
        const preset = providerPresets.find((v) => v.id === p?.id),
          previous = old.providers.find((v) => v.id === p?.id);
        if (!preset || !previous) throw bad("Unknown provider.");
        if (
          typeof p.enabled !== "boolean" ||
          typeof p.freeTierConfirmed !== "boolean" ||
          !["free", "paid"].includes(p.billing)
        )
          throw bad("Invalid provider settings.");
        if (["xai", "custom"].includes(p.id) && p.billing !== "paid")
          throw bad("xAI and custom providers require paid routing mode.");
        let url;
        try {
          url = new URL(p.baseUrl);
        } catch {
          throw bad("Enter a valid provider base URL.");
        }
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
        )
          throw bad("Use HTTPS, or HTTP for a loopback provider.");
        const baseUrl = url.href.replace(/\/$/, "");
        if (
          p.id !== "custom" &&
          (baseUrl !== preset.baseUrl || p.protocol !== preset.protocol)
        )
          throw bad("Use the preset endpoint and protocol for this provider.");
        if (
          typeof p.model !== "string" ||
          (p.model !== "" && !/^[\w./:@-]{1,120}$/.test(p.model)) ||
          (p.enabled && !p.model)
        )
          throw bad("Enter a provider model ID.");
        if (!["responses", "chat-completions"].includes(p.protocol))
          throw bad("Choose an API protocol.");
        if (
          p.apiKey !== undefined &&
          (typeof p.apiKey !== "string" || p.apiKey.length > 4096)
        )
          throw bad("Invalid provider key.");
        if (p.clearKey !== undefined && typeof p.clearKey !== "boolean")
          throw bad("Invalid key removal setting.");
        const sameOrigin = url.origin === new URL(previous.baseUrl).origin;
        if (
          !sameOrigin &&
          previous.key &&
          p.enabled &&
          !p.apiKey?.trim() &&
          !p.clearKey
        )
          throw bad("Enter a new API key when changing provider origin.");
        const key = p.clearKey
          ? ""
          : p.apiKey?.trim() || (sameOrigin ? previous.key : "");
        return {
          id: p.id,
          name: preset.name,
          enabled: p.enabled,
          model: p.model,
          baseUrl,
          protocol: p.protocol,
          billing: p.billing,
          freeTierConfirmed: p.freeTierConfirmed,
          key: key ? store.seal(key) : "",
          limits: Object.fromEntries(
            ["rpm", "rpd", "tpm", "tpd"].map((field) => [
              field,
              integer(
                p.limits?.[field],
                1,
                10000000,
                `${preset.name} ${field.toUpperCase()}`,
              ),
            ]),
          ),
        };
      }),
    };
    store.set("aiRouting", next);
    store.audit("ai.routing_saved");
    return read();
  }
  return { read, save };
}
