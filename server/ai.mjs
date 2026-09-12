// Provider credentials remain server-side. Public callers can supply only user/assistant text.
// Responses streaming: https://developers.openai.com/api/docs/guides/streaming-responses
export function installAi(app, { store, session, rate, ip, fail }) {
  const { get, set, seal, unseal, audit } = store;
  const read = () => {
    const saved = get("aiConfig");
    return saved
      ? { ...saved, key: saved.key ? unseal(saved.key) : "" }
      : {
          enabled: process.env.AI_ENABLED === "true",
          baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
          model: process.env.AI_MODEL || "",
          protocol:
            process.env.AI_PROTOCOL === "chat-completions"
              ? "chat-completions"
              : "responses",
          key: process.env.AI_API_KEY || "",
          dailyLimit: 200,
        };
  };
  const available = (c) => !!(c.enabled && c.model && c.key);
  app.get("/api/ai/config", () => {
    const c = read();
    return { configured: available(c), model: available(c) ? c.model : null };
  });
  app.get("/api/admin/ai", (req) => {
    session(req);
    const { key, ...c } = read();
    return { ...c, hasKey: !!key };
  });
  app.put("/api/admin/ai", (req) => {
    session(req, true);
    const b = req.body || {},
      old = read();
    let u;
    try {
      u = new URL(b.baseUrl);
    } catch {
      throw fail("Enter a valid provider base URL.");
    }
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
        ))
    )
      throw fail("Use HTTPS, or HTTP for a loopback provider.");
    if (typeof b.model !== "string" || !/^[\w./:@-]{1,120}$/.test(b.model))
      throw fail("Enter a provider model ID.");
    if (!["responses", "chat-completions"].includes(b.protocol))
      throw fail("Choose an API protocol.");
    if (
      b.apiKey !== undefined &&
      (typeof b.apiKey !== "string" || b.apiKey.length > 4096)
    )
      throw fail("Invalid provider key.");
    const key = b.clearKey ? "" : b.apiKey?.trim() || old.key;
    const c = {
      enabled: b.enabled === true,
      baseUrl: u.href.replace(/\/$/, ""),
      model: b.model,
      protocol: b.protocol,
      key: key ? seal(key) : "",
      dailyLimit: Math.max(1, Math.min(10000, Number(b.dailyLimit) || 200)),
    };
    set("aiConfig", c);
    audit("ai.settings_saved");
    return { ok: true };
  });
  const active = new Map();
  let total = 0;
  app.post("/api/ai/chat", async (req, reply) => {
    const c = read();
    if (!available(c))
      throw fail(
        "AI is not configured. Add a provider in the administrator panel.",
        503,
      );
    const messages = req.body?.messages;
    if (
      !Array.isArray(messages) ||
      !messages.length ||
      messages.length > 30 ||
      messages.some(
        (m) =>
          !m ||
          !["user", "assistant"].includes(m.role) ||
          typeof m.content !== "string" ||
          !m.content.trim() ||
          m.content.length > 12000,
      ) ||
      messages.at(-1).role !== "user" ||
      JSON.stringify(messages).length > 26000
    )
      throw fail(
        "Send up to 30 text messages, ending with a user message. Shorten this conversation or start a new chat.",
      );
    const client = ip(req);
    if ((active.get(client) || 0) >= 2 || total >= 8)
      throw fail("Another reply is in progress. Try again shortly.", 429);
    rate("ai:" + client, 20, 3600000);
    rate(
      "ai:day:" + new Date().toISOString().slice(0, 10),
      c.dailyLimit,
      86400000,
    );
    active.set(client, (active.get(client) || 0) + 1);
    total++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 60000);
    const disconnect = () => abort.abort();
    reply.raw.once("close", disconnect);
    let streaming = false;
    const send = (value) => {
      if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + "\n");
    };
    try {
      const instructions =
        "You are Atlas AI. Answer clearly and directly. Use Markdown for code or structure when useful. Do not claim to browse the web or run tools: no tools are connected.";
      const payload =
        c.protocol === "responses"
          ? {
              model: c.model,
              input: messages.map(({ role, content }) => ({ role, content })),
              instructions,
              stream: true,
              store: false,
              max_output_tokens: 2048,
            }
          : {
              model: c.model,
              messages: [
                { role: "system", content: instructions },
                ...messages.map(({ role, content }) => ({ role, content })),
              ],
              stream: true,
              max_tokens: 2048,
            };
      const upstream = await fetch(
        c.baseUrl +
          (c.protocol === "responses" ? "/responses" : "/chat/completions"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + c.key,
          },
          body: JSON.stringify(payload),
          signal: abort.signal,
          redirect: "error",
        },
      );
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw fail(
          upstream.status === 401 || upstream.status === 403
            ? "The AI provider rejected its credentials. Ask the administrator to check the key."
            : upstream.status === 429
              ? "The AI provider rate limit was reached. Try again later."
              : "The AI provider request failed. Check the model and endpoint in the administrator panel.",
          502,
        );
      }
      reply.hijack();
      streaming = true;
      reply.raw.writeHead(200, {
        ...reply.getHeaders(),
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      let buffer = "",
        completed = false,
        output = 0;
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 1000000)
          throw Error("Provider event exceeded the stream limit.");
        let split;
        while ((split = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, split).trim();
          buffer = buffer.slice(split + 1);
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") {
            completed = true;
            continue;
          }
          let event;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }
          if (
            event.type === "response.failed" ||
            event.type === "error" ||
            event.error
          )
            throw Error("The AI provider interrupted the reply.");
          if (event.type === "response.incomplete")
            throw Error(
              "The provider reached its output limit. Ask it to continue in a new message.",
            );
          const delta =
            c.protocol === "responses"
              ? event.type === "response.output_text.delta"
                ? event.delta
                : ""
              : event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            output += delta.length;
            if (output > 100000)
              throw Error("Reply exceeded the output limit.");
            send({ type: "delta", text: delta });
          }
          if (
            event.type === "response.completed" ||
            event.choices?.[0]?.finish_reason
          )
            completed = true;
        }
      }
      if (!completed || !output)
        throw Error("The provider ended without a complete text reply.");
      send({ type: "done" });
      reply.raw.end();
    } catch (e) {
      if (streaming) {
        send({
          type: "error",
          message: abort.signal.aborted
            ? "Reply stopped or timed out."
            : e.statusCode
              ? e.message
              : "The provider stream ended before completion. Please retry.",
        });
        reply.raw.end();
      } else if (!reply.raw.destroyed)
        throw e.statusCode
          ? e
          : fail(
              "The AI provider could not be reached. Check the provider settings.",
              502,
            );
    } finally {
      clearTimeout(timer);
      reply.raw.off("close", disconnect);
      active.set(client, Math.max(0, (active.get(client) || 1) - 1));
      total--;
    }
  });
}
