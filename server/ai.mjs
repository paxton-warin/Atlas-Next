import { titleInstructions, cleanTitle, reserveTokens } from "./ai-context.mjs";
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
  const handle =
    (title = false) =>
    async (req, reply) => {
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
        messages.length > (title ? 2 : 30) ||
        messages.some(
          (m) =>
            !m ||
            !["user", "assistant"].includes(m.role) ||
            typeof m.content !== "string" ||
            !m.content.trim() ||
            m.content.length > (title ? 4000 : 36000),
        ) ||
        (title
          ? messages.length !== 2 ||
            messages[0].role !== "user" ||
            messages[1].role !== "assistant"
          : messages.at(-1).role !== "user") ||
        JSON.stringify(messages).length > (title ? 9000 : 80000)
      )
        throw fail(
          title
            ? "Send the opening user message and completed assistant reply."
            : "Send up to 30 text messages, ending with a user message. Shorten this conversation or start a new chat.",
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
      const system = title ? titleInstructions : instructions,
        outputLimit = title
          ? Math.min(256, config.maxOutputTokens)
          : config.maxOutputTokens;
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
        for (const provider of allowed) {
          if (controller.signal.aborted) break;
          const reserved = reserveTokens(
            provider,
            messages,
            system,
            outputLimit,
          );
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
                  providerPayload(provider, messages, outputLimit, system),
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
            let titleText = "";
            for await (const delta of streamProvider(
              upstream,
              provider,
              settle,
            )) {
              if (title) {
                clearTimeout(deadline);
                titleText += delta.text;
                if (titleText.length > 500)
                  throw providerError("Invalid conversation title.");
                continue;
              }
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
            if (title) {
              const name = cleanTitle(titleText);
              if (!name) throw providerError("Invalid conversation title.");
              return reply
                .header("Cache-Control", "no-store")
                .send({ title: name });
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
            if (
              error.message !== "Invalid conversation title." &&
              !budgets.status(provider.id).cooldown
            )
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
        const blocks = allowed
          .map((p) =>
            budgets.blocked(p, reserveTokens(p, messages, system, outputLimit)),
          )
          .filter(Boolean);
        const wait = blocks
          .filter((b) => b.retryAt)
          .sort((a, b) => a.retryAt - b.retryAt)[0];
        if (attempted && lastError) {
          if (wait)
            reply.header(
              "Retry-After",
              Math.max(1, Math.ceil((wait.retryAt - Date.now()) / 1000)),
            );
          throw lastError;
        }
        if (wait) {
          const seconds = Math.max(
            1,
            Math.ceil((wait.retryAt - Date.now()) / 1000),
          );
          reply.header("Retry-After", seconds);
          throw fail(
            wait.kind === "day"
              ? "The daily AI allowance is used up. Your message is saved; retry after the daily reset."
              : wait.kind === "minute"
                ? "The AI allowance for this minute is in use. Your message is saved; retry shortly."
                : lastError?.message ||
                  "The AI provider is cooling down. Your message is saved; retry shortly.",
            429,
          );
        }
        if (blocks.length && blocks.every((b) => b.kind === "context"))
          throw fail(
            "This conversation or attachment is larger than the configured AI token allowance. Shorten it, start a new chat, or ask the owner to check the provider limits.",
            413,
          );
        throw fail(
          "The configured AI providers are at their current limits. Try again later.",
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
    };
  app.post("/api/ai/chat", { bodyLimit: 256 * 1024 }, handle());
  app.post("/api/ai/title", handle(true));
}
