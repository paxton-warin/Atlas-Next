import type { Attachment } from "./chat-files";
export type AiMessage = {
  attachments?: Attachment[];
  id: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  model?: string;
};
export type AiChatRecord = {
  id: string;
  title: string;
  titleRequested?: boolean;
  updated: number;
  messages: AiMessage[];
  failure?: { userId: string; error: string; retryAt: number };
};
/** Validate restored records without silently cutting off valid retained chats,
 * messages or extracted file text. Rendering is windowed separately. The legacy
 * canonical preference remains untouched until a complete archive migration. */
export function restoreAiChats(value: unknown): AiChatRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c) =>
        c &&
        typeof c.id === "string" &&
        typeof c.title === "string" &&
        Array.isArray(c.messages),
    )
    .map((c) => ({
      ...c,
      failure:
        c.failure &&
        typeof c.failure.userId === "string" &&
        typeof c.failure.error === "string" &&
        Number.isFinite(c.failure.retryAt)
          ? c.failure
          : undefined,
      messages: c.messages
        .filter(
          (m: any) =>
            m &&
            ["user", "assistant"].includes(m.role) &&
            typeof m.content === "string",
        )
        .map((m: any, index: number) => ({
          ...m,
          id:
            typeof m.id === "string"
              ? m.id
              : c.id + ":restored-message:" + index,
          provider: typeof m.provider === "string" ? m.provider : undefined,
          model: typeof m.model === "string" ? m.model : undefined,
          attachments: Array.isArray(m.attachments)
            ? m.attachments.filter(
                (f: any) =>
                  f &&
                  typeof f.id === "string" &&
                  typeof f.name === "string" &&
                  typeof f.text === "string",
              )
            : undefined,
        })),
    }));
}
export type AiStreamSnapshot = {
  content: string;
  provider?: string;
  model?: string;
};
export type AiStreamClock = {
  setTimeout(work: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};
/** Buffer provider deltas, not already-rendered copies of the whole archive.
 * A terminal/cancel/pagehide flush is synchronous and exact; view hiding only
 * changes publication cadence, never the requested provider generation. */
export function createAiStreamPublisher(options: {
  visible(): boolean;
  publish(snapshot: AiStreamSnapshot): void;
  clock?: AiStreamClock;
}) {
  const clock = options.clock ?? {
    setTimeout: (work: () => void, delay: number) => setTimeout(work, delay),
    clearTimeout: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown,
    closed = false,
    changed = false,
    content = "",
    chunks: string[] = [];
  let provider: string | undefined, model: string | undefined;
  function clear() {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  }
  function flush() {
    clear();
    if (!changed) return;
    if (chunks.length) {
      content += chunks.join("");
      chunks = [];
    }
    changed = false;
    options.publish({
      content,
      ...(provider === undefined ? {} : { provider, model }),
    });
  }
  function schedule() {
    if (!closed && timer === undefined && changed)
      timer = clock.setTimeout(flush, options.visible() ? 50 : 250);
  }
  return {
    delta(text: string) {
      if (!closed && text) {
        chunks.push(text);
        changed = true;
        schedule();
      }
    },
    source(value: { provider: string; model: string }) {
      if (closed || (provider === value.provider && model === value.model))
        return;
      provider = value.provider;
      model = value.model;
      changed = true;
      schedule();
    },
    flush,
    visibilityChanged() {
      clear();
      if (options.visible()) flush();
      else schedule();
    },
    text() {
      return chunks.length ? content + chunks.join("") : content;
    },
    close() {
      if (closed) return;
      flush();
      closed = true;
    },
  };
}
