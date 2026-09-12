import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, readLocal, writeLocal } from "./model";
type Message = { id: string; role: "user" | "assistant"; content: string };
type Chat = { id: string; title: string; updated: number; messages: Message[] };
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
            .slice(-60),
        }))
    : [];
}
export default function AiChat() {
  const [chats, setChats] = useState<Chat[]>(restored),
    [selected, setSelected] = useState(""),
    [draft, setDraft] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState("");
  const [config, setConfig] = useState<{
    configured: boolean;
    model: string | null;
  } | null>(null);
  const control = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
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
  function newChat() {
    if (busy) return;
    setSelected("");
    setDraft("");
    setError("");
    input.current?.focus();
  }
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || busy || !config?.configured) return;
    const question = draft.trim(),
      id = current?.id || crypto.randomUUID(),
      user: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: question,
      },
      assistant: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
    const messages = [...(current?.messages || []), user];
    setSelected(id);
    setDraft("");
    setBusy(true);
    setError("");
    setChats((old) =>
      current
        ? old.map((c) =>
            c.id === id
              ? {
                  ...c,
                  messages: [...messages, assistant],
                  updated: Date.now(),
                }
              : c,
          )
        : [
            {
              id,
              title: question.slice(0, 48),
              updated: Date.now(),
              messages: [user, assistant],
            },
            ...old,
          ].slice(0, 50),
    );
    const abort = new AbortController();
    control.current = abort;
    let done = false;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages
            .slice(-29)
            .map(({ role, content }) => ({ role, content })),
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
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
          if (event.type === "delta" && typeof event.text === "string")
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
      if (!done)
        throw Error("The connection closed before the reply finished.");
    } catch (e) {
      setError(abort.signal.aborted ? "Reply stopped." : (e as Error).message);
      abort.abort();
      setChats((old) =>
        old.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: c.messages.filter(
                  (m) => m.id !== assistant.id || m.content,
                ),
              }
            : c,
        ),
      );
    } finally {
      setBusy(false);
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
        <button className="button primary" onClick={newChat} disabled={busy}>
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
                  disabled={busy}
                  onClick={() => {
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
                  disabled={busy}
                  onClick={() => {
                    if (confirm("Delete this chat from this browser?")) {
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
            {config?.model || "No model connected"}
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
          {!current?.messages.length ? (
            <div className="chat-empty">
              <Sparkles size={28} />
              <h1>New chat</h1>
              <p>Ask a question or paste something to work on.</p>
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
                </div>
                <div className="chat-message-content">
                  {message.content ? (
                    <Markdown
                      remarkPlugins={[remarkGfm]}
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
                      {message.content}
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
        <div className="chat-composer-wrap">
          {config && !config.configured && (
            <div className="ai-setup" role="status">
              <strong>Connect an AI provider</strong>
              <span>
                Set the endpoint, model, and API key under Admin → AI provider.
              </span>
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <form className="chat-composer" onSubmit={submit}>
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
                disabled={!config?.configured || !draft.trim()}
              >
                <ArrowUp size={18} />
              </button>
            )}
          </form>
          <div className="chat-disclosure">
            Messages are sent to the configured provider. Check important
            answers.
          </div>
        </div>
      </section>
    </div>
  );
}
