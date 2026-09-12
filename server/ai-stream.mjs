export const instructions =
  "You are Atlas AI. Answer clearly and directly. Use Markdown for code or structure when useful. Do not claim to browse the web or run tools: no tools are connected.";
export const providerError = (message, retryable = false) =>
  Object.assign(new Error(message), { statusCode: 502, retryable });
export function providerPayload(
  provider,
  messages,
  maxOutputTokens,
  system = instructions,
) {
  const chat = [
    { role: "system", content: system },
    ...messages.map(({ role, content }) => ({ role, content })),
  ];
  if (provider.protocol === "responses")
    return {
      model: provider.model,
      input: chat,
      stream: true,
      store: false,
      max_output_tokens: maxOutputTokens,
    };
  return {
    model: provider.model,
    messages: chat,
    stream: true,
    ...(provider.id === "groq"
      ? {
          max_completion_tokens: maxOutputTokens,
          reasoning_effort: "low",
          stream_options: { include_usage: true },
        }
      : { max_tokens: maxOutputTokens }),
  };
}
// SSE events may span chunks or multiple data lines. Flush the final event even
// without a terminating newline; never render reasoning or provider error bodies.
async function* events(body) {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (buffer.length + data.join("\n").length > 1000000)
        throw providerError("Provider event exceeded the stream limit.", true);
      if (done) buffer += "\n\n";
      let split;
      while ((split = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, split).replace(/\r$/, "");
        buffer = buffer.slice(split + 1);
        if (!line && data.length) {
          yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function* streamProvider(response, provider, settle) {
  let completed = false,
    output = 0,
    model = provider.model,
    actualUsage;
  for await (const raw of events(response.body)) {
    if (raw === "[DONE]") {
      completed = true;
      continue;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw providerError("The provider returned an invalid stream.", true);
    }
    const actualModel = event.model || event.response?.model;
    if (typeof actualModel === "string" && actualModel.length <= 120)
      model = actualModel;
    const usage = event.usage || event.x_groq?.usage || event.response?.usage;
    if (usage)
      actualUsage =
        usage.total_tokens ??
        (usage.input_tokens ?? usage.prompt_tokens) +
          (usage.output_tokens ?? usage.completion_tokens);
    if (event.error || ["error", "response.failed"].includes(event.type))
      throw providerError("The AI provider interrupted the reply.", true);
    if (
      event.type === "response.incomplete" ||
      event.choices?.[0]?.finish_reason === "length"
    )
      throw providerError(
        "The provider reached the reply limit. Ask a shorter question or raise the reply token limit.",
      );
    if (
      event.choices?.[0]?.finish_reason === "content_filter" ||
      event.type === "response.refusal.done"
    )
      throw providerError("The provider declined this request.");
    if (event.choices?.[0]?.finish_reason === "tool_calls")
      throw providerError("This chat supports text replies, not tool calls.");
    const delta =
      provider.protocol === "responses"
        ? event.type === "response.output_text.delta"
          ? event.delta
          : ""
        : event.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      output += delta.length;
      if (output > 100000)
        throw providerError("Reply exceeded the output limit.");
      yield { text: delta, model };
    }
    if (
      event.type === "response.completed" ||
      event.choices?.[0]?.finish_reason === "stop"
    )
      completed = true;
  }
  if (completed) settle(actualUsage);
  if (!completed || !output)
    throw providerError(
      "The provider ended without a complete text reply.",
      true,
    );
}
export function retrySeconds(value, fallback) {
  if (!value) return fallback;
  const seconds = /^\d+(\.\d+)?$/.test(value)
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds)
    ? Math.min(86400, Math.max(1, Math.ceil(seconds)))
    : fallback;
}
