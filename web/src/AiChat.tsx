import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  MessageSquare,
  Plus,
  Paperclip,
  FileText,
  X,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMath } from "./chat-math";
import { api, readLocal, writeLocal } from "./model";
import {
  acceptedFiles,
  readAttachment,
  withAttachments,
  type Attachment,
} from "./chat-files";
type Message = {
  attachments?: Attachment[];
  id: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  model?: string;
};
type Chat = {
  id: string;
  title: string;
  titleRequested?: boolean;
  updated: number;
  messages: Message[];
  failure?: { userId: string; error: string; retryAt: number };
};
function restored(): Chat[] {
  const values = readLocal<any>("atlas.chats", []);
  return Array.isArray(values)
    ? values
        .filter(
          (c) =>
            c &&
            typeof c.id === "string" &&
            typeof c.title === "string" &&
            Array.isArray(c.messages),
        )
        .slice(0, 50)
        .map((c) => ({
          ...c,
          messages: c.messages
            .filter(
              (m: any) =>
                m &&
                ["user", "assistant"].includes(m.role) &&
                typeof m.content === "string",
            )
            .slice(-60)
            .map((m: Message) => ({
              ...m,
              attachments: Array.isArray(m.attachments)
                ? m.attachments
                    .filter(
                      (f) =>
                        f &&
                        typeof f.id === "string" &&
                        typeof f.name === "string" &&
                        typeof f.text === "string" &&
                        f.text.length <= 12000,
                    )
                    .slice(0, 3)
                : undefined,
            })),
        }))
    : [];
}
export default function AiChat() {
  const [chats, setChats] = useState<Chat[]>(restored),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [reading, setReading] = useState(false),
    [now, setNow] = useState(Date.now()),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(""),
    [allowGeminiDataUse, setAllowGeminiDataUse] = useState(
      () => readLocal<boolean>("atlas.ai.geminiConsent", false) === true,
    );
  const [config, setConfig] = useState<{
    configured: boolean;
    model: string | null;
    provider?: string | null;
    geminiDataUse?: boolean;
  } | null>(null);
  const control = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null),
    busyRef = useRef(false),
    fileRead = useRef(false),
    titleRequests = useRef(new Map<string, AbortController>());
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const current = chats.find((c) => c.id === selected);
  async function refresh() {
    try {
      setConfig(await api("/ai/config"));
    } catch {
      setError("AI settings could not be loaded.");
    }
  }
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      control.current?.abort();
      titleRequests.current.forEach((abort) => abort.abort());
    };
  }, []);
  useEffect(() => {
    const save = () => {
      if (!writeLocal("atlas.chats", chatsRef.current))
        setError(
          "Device storage is full. Delete an old chat to save this conversation.",
        );
    };
    if (!busy) {
      save();
      return;
    }
    const timer = setTimeout(save, 200);
    return () => clearTimeout(timer);
  }, [chats, busy]);
  useEffect(() => {
    const flush = () => writeLocal("atlas.chats", chatsRef.current);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [current?.messages.at(-1)?.content, selected]);
  useEffect(() => {
    if (!current?.failure?.retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current?.failure?.retryAt]);
  const retrySeconds = Math.max(
    0,
    Math.ceil(((current?.failure?.retryAt || 0) - now) / 1000),
  );
  async function attach(list: FileList | null) {
    if (!list?.length || fileRead.current || busyRef.current) return;
    if (attachments.length + list.length > 3) {
      setError("Attach up to 3 files per message.");
      return;
    }
    fileRead.current = true;
    setReading(true);
    setError("");
    try {
      const added: Attachment[] = [];
      for (const file of Array.from(list))
        added.push(await readAttachment(file));
      if (
        [...attachments, ...added].reduce((sum, f) => sum + f.text.length, 0) >
        20000
      )
        throw Error(
          "Keep the combined attachment text under 20,000 characters.",
        );
      setAttachments((old) => [...old, ...added]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      fileRead.current = false;
      setReading(false);
    }
  }
  async function nameChat(id: string, opening: Message, answer: string) {
    const abort = new AbortController();
    titleRequests.current.set(id, abort);
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch("/api/ai/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({
          allowGeminiDataUse,
          messages: [
            { role: "user", content: withAttachments(opening).slice(0, 4000) },
            { role: "assistant", content: answer.slice(0, 4000) },
          ],
        }),
      });
      if (!response.ok) return;
      const result = await response.json();
      if (
        typeof result.title === "string" &&
        result.title.trim() &&
        result.title.length <= 100
      )
        setChats((old) =>
          old.map((c) => (c.id === id ? { ...c, title: result.title } : c)),
        );
    } catch {
      /* Keep the temporary title; never interrupt a successful reply. */
    } finally {
      clearTimeout(timer);
      titleRequests.current.delete(id);
    }
  }
  function newChat() {
    if (busyRef.current || fileRead.current) return;
    setAttachments([]);
    setSelected("");
    setDraft("");
    setError("");
    input.current?.focus();
  }
  async function submit(e?: FormEvent, retry = false) {
    e?.preventDefault();
    if (busyRef.current || fileRead.current || !config?.configured) return;
    const failed = current?.messages.find(
      (m) => m.id === current.failure?.userId,
    );
    // Re-entering the same failed prompt is a retry, not a second user bubble.
    retry =
      retry ||
      !!(
        failed &&
        draft.trim() === failed.content &&
        !attachments.length &&
        !failed.attachments?.length
      );
    if (retry && (!failed || retrySeconds)) return;
    if (!retry && !draft.trim() && !attachments.length) return;
    const question = retry
        ? failed!.content
        : draft.trim() || "Summarize the attached files.",
      id = current?.id || crypto.randomUUID(),
      user: Message = retry
        ? failed!
        : {
            id: crypto.randomUUID(),
            role: "user",
            content: question,
            ...(attachments.length ? { attachments } : {}),
          },
      assistant: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
    const history = current?.messages || [];
    const messages = retry
      ? history.slice(0, history.findIndex((m) => m.id === user.id) + 1)
      : [...history, user];
    const wire = messages
      .filter((m) => m.content && (retry || m.id !== current?.failure?.userId))
      .slice(-29)
      .map((m) => ({ role: m.role, content: withAttachments(m) }));
    if (JSON.stringify(wire).length > 80000) {
      setError(
        "This conversation is too long. Start a new chat or use shorter attachments.",
      );
      return;
    }
    busyRef.current = true;
    setSelected(id);
    if (!retry || draft.trim() === question) setDraft("");
    if (!retry) setAttachments([]);
    setBusy(true);
    setError("");
    setChats((old) =>
      current
        ? old.map((c) =>
            c.id === id
              ? {
                  ...c,
                  failure: undefined,
                  messages: [...messages, assistant],
                  updated: Date.now(),
                }
              : c,
          )
        : [
            {
              id,
              title: question.slice(0, 48),
              titleRequested: false,
              updated: Date.now(),
              messages: [user, assistant],
            },
            ...old,
          ].slice(0, 50),
    );
    const abort = new AbortController();
    control.current = abort;
    let done = false,
      answer = "",
      retryAt = 0;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowGeminiDataUse,
          messages: wire,
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const seconds = Number(response.headers.get("Retry-After"));
        if (Number.isFinite(seconds) && seconds > 0)
          retryAt = Date.now() + seconds * 1000;
        const result = await response.json();
        throw Error(result.error || "Request failed.");
      }
      if (!response.body) throw Error("The provider returned an empty stream.");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, split);
          buffer = buffer.slice(split + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "error") throw Error(event.message);
          if (event.type === "done") done = true;
          if (
            event.type === "source" &&
            typeof event.provider === "string" &&
            typeof event.model === "string"
          )
            setChats((old) =>
              old.map((c) =>
                c.id === id
                  ? {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.id === assistant.id
                          ? {
                              ...m,
                              provider: event.provider,
                              model: event.model,
                            }
                          : m,
                      ),
                    }
                  : c,
              ),
            );
          if (event.type === "delta" && typeof event.text === "string") {
            answer += event.text;
            setChats((old) =>
              old.map((c) =>
                c.id === id
                  ? {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.id === assistant.id
                          ? { ...m, content: m.content + event.text }
                          : m,
                      ),
                    }
                  : c,
              ),
            );
          }
        }
      }
      if (!done)
        throw Error("The connection closed before the reply finished.");
      if (!current || current.titleRequested === false) {
        setChats((old) =>
          old.map((c) => (c.id === id ? { ...c, titleRequested: true } : c)),
        );
        void nameChat(id, messages.find((m) => m.role === "user")!, answer);
      }
    } catch (e) {
      const message = abort.signal.aborted
        ? "Reply stopped."
        : (e as Error).message;
      setNow(Date.now());
      abort.abort();
      setChats((old) =>
        old.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: c.messages.filter(
                  (m) => m.id !== assistant.id || m.content,
                ),
                failure: { userId: user.id, error: message, retryAt },
              }
            : c,
        ),
      );
    } finally {
      setBusy(false);
      busyRef.current = false;
      control.current = null;
    }
  }
  async function copy(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(message.id);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("Select the message text to copy it.");
    }
  }
  return (
    <div className="ai-chat">
      <aside className="chat-sidebar">
        <button
          className="button primary"
          onClick={newChat}
          disabled={busy || reading}
        >
          <Plus size={16} />
          New chat
        </button>
        <label className="chat-search">
          <Search size={14} />
          <input
            aria-label="Search chats"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="chat-list">
          {chats
            .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
            .map((chat) => (
              <div
                className={
                  "chat-item " + (selected === chat.id ? "selected" : "")
                }
                key={chat.id}
              >
                <button
                  disabled={busy || reading}
                  title={chat.title}
                  aria-label={chat.title}
                  onClick={() => {
                    setAttachments([]);
                    setSelected(chat.id);
                    setError("");
                    setDraft("");
                  }}
                >
                  <MessageSquare size={15} />
                  <span>{chat.title}</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={"Delete chat " + chat.title}
                  disabled={busy || reading}
                  onClick={() => {
                    if (confirm("Delete this chat from this browser?")) {
                      titleRequests.current.get(chat.id)?.abort();
                      setChats((old) => old.filter((c) => c.id !== chat.id));
                      if (selected === chat.id) newChat();
                    }
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          {!chats.length && <p className="muted">No chats yet.</p>}
        </div>
        <small>Chats are saved on this device.</small>
      </aside>
      <section className="chat-main">
        <header className="chat-header">
          <Sparkles size={17} />
          <strong>Atlas AI</strong>
          <span className="chat-model">
            {config?.provider
              ? `Auto · ${config.provider}`
              : config?.model || "No model connected"}
          </span>
          <button
            className="icon-button"
            aria-label="Refresh AI connection"
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
        </header>
        <div
          className="chat-messages"
          role="log"
          aria-label="Chat messages"
          aria-live="polite"
        >
          <div className="chat-transcript">
            {!current?.messages.length ? (
              <div className="chat-empty">
                <Sparkles size={28} />
                <h1>New chat</h1>
                <p>
                  Ask a question or attach text, code, a PDF or a Word document.
                </p>
                <div className="chat-suggestions">
                  {[
                    "Explain a concept",
                    "Review some code",
                    "Help me write an email",
                  ].map((text) => (
                    <button
                      key={text}
                      onClick={() => {
                        setDraft(text);
                        input.current?.focus();
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              current.messages.map((message) => (
                <article
                  className={"chat-message " + message.role}
                  key={message.id}
                >
                  <div className="chat-author">
                    {message.role === "user" ? "You" : "Atlas AI"}
                    {message.role === "assistant" && message.provider && (
                      <span className="chat-author-source">
                        {message.provider} · {message.model}
                      </span>
                    )}
                  </div>
                  {message.attachments?.length ? (
                    <div className="chat-attachments sent">
                      {message.attachments.map((file) => (
                        <details key={file.id}>
                          <summary>
                            <FileText size={15} />
                            <span>{file.name}</span>
                          </summary>
                          <pre>{file.text}</pre>
                        </details>
                      ))}
                    </div>
                  ) : null}
                  <div className="chat-message-content">
                    {message.content ? (
                      <Markdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[
                          [
                            rehypeKatex,
                            {
                              trust: false,
                              throwOnError: false,
                              maxExpand: 1000,
                              maxSize: 20,
                            },
                          ],
                        ]}
                        skipHtml
                        components={{
                          a: (props) => (
                            <a
                              {...props}
                              target="_blank"
                              rel="noopener noreferrer"
                            />
                          ),
                          img: () => null,
                        }}
                      >
                        {normalizeMath(message.content)}
                      </Markdown>
                    ) : (
                      <span className="thinking">
                        <span className="spinner" />
                        Generating…
                      </span>
                    )}
                  </div>
                  {message.content && (
                    <button
                      className="message-copy"
                      aria-label="Copy message"
                      onClick={() => void copy(message)}
                    >
                      {copied === message.id ? (
                        <Check size={13} />
                      ) : (
                        <Copy size={13} />
                      )}
                    </button>
                  )}
                </article>
              ))
            )}
            <div ref={bottom} />
          </div>
        </div>
        <div className="chat-composer-wrap">
          <div className="chat-compose-lane">
            {config && !config.configured && (
              <div className="ai-setup" role="status">
                <strong>Connect an AI provider</strong>
                <span>
                  Enable a provider and add its API key under Admin → AI
                  provider.
                </span>
              </div>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            {current?.failure && (
              <div className="chat-failure">
                <span role="alert">{current.failure.error}</span>
                <button
                  className="button"
                  disabled={busy || reading || retrySeconds > 0}
                  onClick={() => void submit(undefined, true)}
                >
                  <RefreshCw size={14} />
                  {retrySeconds > 0
                    ? `Retry in ${retrySeconds >= 3600 ? Math.ceil(retrySeconds / 3600) + "h" : retrySeconds >= 60 ? Math.ceil(retrySeconds / 60) + "m" : retrySeconds + "s"}`
                    : "Retry reply"}
                </button>
              </div>
            )}
            {config?.geminiDataUse && (
              <div className="ai-gemini-consent">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={allowGeminiDataUse}
                    onChange={(event) => {
                      setAllowGeminiDataUse(event.target.checked);
                      writeLocal(
                        "atlas.ai.geminiConsent",
                        event.target.checked,
                      );
                    }}
                  />
                  Allow Google Gemini as a backup. Google may use messages and
                  replies sent to its free tier to improve its products.
                </label>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="chat-attachments" aria-label="Attached files">
                {attachments.map((file) => (
                  <div className="chat-file" key={file.id}>
                    <FileText size={15} />
                    <span title={file.name}>{file.name}</span>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setAttachments((old) =>
                          old.filter((f) => f.id !== file.id),
                        )
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {reading && (
              <div className="chat-file-status" role="status">
                Reading document text…
              </div>
            )}
            <input
              ref={files}
              type="file"
              hidden
              multiple
              accept={acceptedFiles}
              aria-label="Choose chat files"
              onChange={(e) => {
                void attach(e.target.files);
                e.target.value = "";
              }}
            />
            <form className="chat-composer" onSubmit={submit}>
              <button
                type="button"
                className="chat-attach"
                aria-label="Attach files"
                title="Attach text, code, PDF or DOCX · up to 3 files, 2 MB each"
                disabled={busy || reading}
                onClick={() => files.current?.click()}
              >
                <Paperclip size={19} />
              </button>
              <textarea
                ref={input}
                aria-label="Message Atlas AI"
                placeholder="Message Atlas AI"
                value={draft}
                maxLength={12000}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              {busy ? (
                <button
                  type="button"
                  aria-label="Stop reply"
                  onClick={() => control.current?.abort()}
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Send AI message"
                  disabled={
                    !config?.configured ||
                    reading ||
                    (!draft.trim() && !attachments.length)
                  }
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </form>
            <div className="chat-disclosure">
              Messages and extracted file text are sent to the configured
              provider and saved on this device. Check important answers.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
