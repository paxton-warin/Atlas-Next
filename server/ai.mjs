import {
  createAiConfig,
  providerPresets,
  routingReason,
} from "./ai-config.mjs";
import { createAiBudget } from "./ai-budget.mjs";
import {
  instructions,
  providerPayload,
  providerError,
  streamProvider,
  retrySeconds,
} from "./ai-stream.mjs";
export function installAi(
  app,
  { store, session, rate, ip, fail, limitIp, requestLimits },
) {
  const configStore = createAiConfig(store),
    budgets = createAiBudget(store.db);
  const eligible = (c) => c.providers.filter((p) => !routingReason(c, p));
  const publicConfig = () => {
    const c = configStore.read(),
      providers = c.enabled ? eligible(c) : [];
    return {
      configured: providers.length > 0,
      model: providers[0]?.model || null,
      provider: providers[0]?.name || null,
      freeOnly: c.freeOnly,
      geminiDataUse: providers.some(
        (p) => p.id === "gemini" && p.billing === "free",
      ),
    };
  };
  const ownerConfig = () => {
    const c = configStore.read();
    return {
      ...c,
      providers: c.providers.map(({ key, ...p }) => ({
        ...p,
        hasKey: !!key,
        usage: budgets.status(p.id),
        routingStatus: routingReason(c, { ...p, key }) || "Ready",
      })),
      presets: providerPresets,
    };
  };
  app.get("/api/ai/config", publicConfig);
  app.get("/api/admin/ai", (req) => {
    session(req);
    return ownerConfig();
  });
  app.put("/api/admin/ai", (req) => {
    session(req, true);
    configStore.save(req.body);
    return ownerConfig();
  });
  const active = new Map();
  let total = 0;
  app.post("/api/ai/chat", async (req, reply) => {
    const config = configStore.read(),
      candidates = config.enabled ? eligible(config) : [];
    if (!candidates.length)
      throw fail(
        "AI is not configured. Enable an eligible provider in the administrator panel.",
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
    // The browser acknowledges the disclosure before any free Gemini routing.
    const allowed = candidates.filter(
      (p) =>
        p.id !== "gemini" ||
        p.billing !== "free" ||
        req.body?.allowGeminiDataUse === true,
    );
    if (!allowed.length)
      throw fail(
        "Enable Gemini data sharing in the chat disclosure, or configure another provider.",
        400,
      );
    const client = ip(req);
    if (
      (active.get(client) || 0) >= requestLimits.aiCapacity(req.ip) ||
      total >= 8
    )
      throw fail("Another reply is in progress. Try again shortly.", 429);
    limitIp(req, "ai");
    rate(
      "ai:day:" + new Date().toISOString().slice(0, 10),
      config.dailyLimit,
      86400000,
    );
    active.set(client, (active.get(client) || 0) + 1);
    total++;
    const controller = new AbortController(),
      lifetime = setTimeout(() => controller.abort(), 60000);
    const disconnect = () => controller.abort();
    reply.raw.once("close", disconnect);
    let streaming = false,
      attempted = false,
      lastError;
    const send = (value) => {
      if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(value) + "\n");
    };
    try {
      // UTF-8 byte count + protocol overhead is deliberately conservative until
      // actual usage arrives. Unknown/aborted usage keeps its reservation.
      const reserved =
        Buffer.byteLength(JSON.stringify(messages)) +
        Buffer.byteLength(instructions) +
        512 +
        config.maxOutputTokens;
      for (const provider of allowed) {
        if (controller.signal.aborted) break;
        const settle = budgets.reserve(provider, reserved);
        if (!settle) continue;
        attempted = true;
        const attempt = new AbortController();
        const abort = () => attempt.abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        let deadline = setTimeout(() => attempt.abort(), 12000);
        try {
          const upstream = await fetch(
            provider.baseUrl +
              (provider.protocol === "responses"
                ? "/responses"
                : "/chat/completions"),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + provider.key,
              },
              body: JSON.stringify(
                providerPayload(provider, messages, config.maxOutputTokens),
              ),
              signal: attempt.signal,
              redirect: "error",
            },
          );
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();
            const retryable =
              upstream.status === 429 ||
              upstream.status === 402 ||
              upstream.status >= 500;
            const message = [401, 403].includes(upstream.status)
              ? "The AI provider rejected its credentials or account access. Ask the administrator to check the key and plan."
              : upstream.status === 402
                ? "The AI provider has no available API credits. Ask the administrator to check billing."
                : upstream.status === 429
                  ? "The AI provider rate limit was reached. Try again later."
                  : "The AI provider request failed. Check the model and endpoint in the administrator panel.";
            budgets.cool(
              provider.id,
              retrySeconds(
                upstream.headers.get("retry-after"),
                retryable ? 60 : 300,
              ),
              message,
            );
            throw providerError(message, retryable);
          }
          for await (const delta of streamProvider(
            upstream,
            provider,
            settle,
          )) {
            if (!streaming) {
              clearTimeout(deadline);
              deadline = null;
              reply.hijack();
              streaming = true;
              reply.raw.writeHead(200, {
                ...reply.getHeaders(),
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
              });
              send({
                type: "source",
                provider: provider.name,
                model: delta.model,
              });
            }
            send({ type: "delta", text: delta.text });
          }
          send({ type: "done" });
          reply.raw.end();
          return;
        } catch (error) {
          if (streaming) throw error; // Never append a different model to a partial answer.
          if (controller.signal.aborted) break;
          const retryable = error.retryable ?? true;
          lastError = error.statusCode
            ? error
            : providerError(
                "The AI provider could not be reached. Try again shortly.",
                true,
              );
          if (!budgets.status(provider.id).cooldown)
            budgets.cool(provider.id, 30, "Connection or stream error");
          if (!retryable) throw lastError;
        } finally {
          clearTimeout(deadline);
          controller.signal.removeEventListener("abort", abort);
          attempt.abort();
        }
      }
      if (controller.signal.aborted)
        throw fail("Reply stopped or timed out.", 504);
      if (attempted && lastError) throw lastError;
      throw fail(
        "The configured AI providers are at their current limits or cooling down. Try again later or start a shorter chat.",
        429,
      );
    } catch (error) {
      if (streaming) {
        send({
          type: "error",
          message: controller.signal.aborted
            ? "Reply stopped or timed out."
            : error.statusCode
              ? error.message
              : "The provider stream ended before completion. Please retry.",
        });
        reply.raw.end();
      } else if (!reply.raw.destroyed)
        throw error.statusCode
          ? error
          : fail("The AI request failed. Try again shortly.", 502);
    } finally {
      clearTimeout(lifetime);
      reply.raw.off("close", disconnect);
      controller.abort();
      const remaining = (active.get(client) || 1) - 1;
      if (remaining > 0) active.set(client, remaining);
      else active.delete(client);
      total--;
    }
  });
}
