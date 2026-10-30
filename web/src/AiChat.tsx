import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  getActiveProfile,
  getActiveLocalAuthority,
} from "../../runtime/profile-context.ts";
import { sameLocalActorAuthority } from "../../runtime/local-authority.ts";
import "./atlas-v21-ai.css";
import {
  MessageSquare,
  Plus,
  FileText,
  X,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import "katex/dist/katex.min.css";
import { api, profileLocalKey, readLocal, writeLocal } from "./model";
import { AiComposer, type AiComposerHandle } from "./ai-composer";
import { AiMessageView } from "./ai-message";
import { readAiComposerState } from "./ai-composer-state";
import {
  createAiStreamPublisher,
  restoreAiChats,
  type AiMessage as Message,
  type AiChatRecord as Chat,
} from "./ai-chat-state";
import {
  acceptedFiles,
  readAttachment,
  withAttachments,
  type Attachment,
} from "./chat-files";
function restored(): Chat[] {
  return restoreAiChats(readLocal<unknown>("atlas.chats", []));
}
export default function AiChat() {
  const [chats, setChatsState] = useState<Chat[]>(restored),
    [selected, setSelected] = useState(
      () =>
        readAiComposerState(
          undefined,
          profileLocalKey("atlas.chats") + ":composer-v1",
        ).selected,
    ),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [reading, setReading] = useState(false),
    [now, setNow] = useState(Date.now()),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(""),
    [visible, setVisible] = useState(true),
    [chatLimit, setChatLimit] = useState(50),
    [messageWindow, setMessageWindow] = useState({ id: "", start: 0 }),
    [allowGeminiDataUse, setAllowGeminiDataUse] = useState(
      () => readLocal<boolean>("atlas.ai.geminiConsent", false) === true,
    );
  const [config, setConfig] = useState<{
    configured: boolean;
    model: string | null;
    provider?: string | null;
    geminiDataUse?: boolean;
  } | null>(null);
  const scope = useRef({
    key: profileLocalKey("atlas.chats"),
    profile: getActiveProfile(),
    authority: getActiveLocalAuthority(),
  });
  const scopeCurrent = useCallback(
    () =>
      profileLocalKey("atlas.chats") === scope.current.key &&
      getActiveProfile() === scope.current.profile &&
      (scope.current.authority
        ? sameLocalActorAuthority(
            scope.current.authority,
            getActiveLocalAuthority(),
          )
        : !getActiveLocalAuthority()),
    [],
  );
  const control = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    composer = useRef<AiComposerHandle>(null);
  const files = useRef<HTMLInputElement>(null),
    busyRef = useRef(false),
    fileRead = useRef(false),
    titleRequests = useRef(new Map<string, AbortController>()),
    mounted = useRef(true),
    visibleRef = useRef(true),
    followTail = useRef(true),
    configFlight = useRef(false),
    stream = useRef<ReturnType<typeof createAiStreamPublisher> | null>(null),
    activeReply = useRef<{
      chatId: string;
      userId: string;
      assistantId: string;
    } | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    lastSaved = useRef<Chat[] | undefined>(undefined),
    prependAnchor = useRef<{ top: number; height: number } | null>(null);
  const chatsRef = useRef(chats);
  const changeChats = useCallback(
    (change: (old: Chat[]) => Chat[]) => {
      if (!scopeCurrent()) return;
      const next = change(chatsRef.current);
      if (next === chatsRef.current) return;
      // Terminal/pagehide flushes can persist the newest buffered tokens before
      // React schedules its next render. This ref never stores a stale event copy.
      chatsRef.current = next;
      if (mounted.current) setChatsState(next);
    },
    [scopeCurrent],
  );
  const current = useMemo(
    () => chats.find((c) => c.id === selected),
    [chats, selected],
  );
  const filteredChats = useMemo(() => {
    const needle = query.toLowerCase();
    return chats.filter((c) => c.title.toLowerCase().includes(needle));
  }, [chats, query]);
  const messageStart =
    messageWindow.id === selected
      ? messageWindow.start
      : Math.max(0, (current?.messages.length ?? 0) - 40);
  const persist = useCallback(() => {
    if (!scopeCurrent() || lastSaved.current === chatsRef.current) return;
    if (writeLocal("atlas.chats", chatsRef.current))
      lastSaved.current = chatsRef.current;
    else if (mounted.current)
      setError(
        "Device storage is full. Delete an old chat to save this conversation.",
      );
  }, [scopeCurrent]);
  const flush = useCallback(() => {
    stream.current?.flush();
    composer.current?.flushDraft();
    persist();
  }, [persist]);
  const stopReply = useCallback(() => {
    stream.current?.flush();
    const active = activeReply.current;
    activeReply.current = null;
    if (active)
      changeChats((old) =>
        old.map((chat) =>
          chat.id === active.chatId
            ? {
                ...chat,
                messages: chat.messages.filter(
                  (message) =>
                    message.id !== active.assistantId || message.content,
                ),
                failure: {
                  userId: active.userId,
                  error: "Reply stopped.",
                  retryAt: 0,
                },
              }
            : chat,
        ),
      );
    control.current?.abort();
    persist();
  }, [changeChats, persist]);
  const refresh = useCallback(async () => {
    if (configFlight.current || !scopeCurrent()) return;
    configFlight.current = true;
    try {
      const next = await api("/ai/config");
      if (mounted.current && scopeCurrent()) setConfig(next);
    } catch {
      if (mounted.current && scopeCurrent())
        setError("AI settings could not be loaded.");
    } finally {
      configFlight.current = false;
    }
  }, [scopeCurrent]);
  useEffect(() => {
    const update = () => {
      const next = !document.hidden && !panel.current?.closest("[hidden]");
      if (visibleRef.current === next) return;
      visibleRef.current = next;
      setVisible(next);
      stream.current?.visibilityChanged();
    };
    const observer = new MutationObserver(update);
    for (
      let node: Element | null = panel.current;
      node;
      node = node.parentElement
    )
      observer.observe(node, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    const focus = () => {
      if (visibleRef.current) void refresh();
    };
    void refresh();
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", focus);
      stopReply();
      titleRequests.current.forEach((abort) => abort.abort());
      clearTimeout(copyTimer.current);
    };
  }, [refresh, stopReply]);
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);
  useEffect(() => {
    if (!busy) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      persist();
    } else if (saveTimer.current === undefined) {
      // A coarse, single pending save is independent of the display cadence.
      // Hidden250ms publications must not trigger a full-archive save each time.
      saveTimer.current = setTimeout(() => {
        saveTimer.current = undefined;
        persist();
      }, 1000);
    }
  }, [chats, busy, persist]);
  useEffect(() => {
    const beforeRevoke = (event: Event) => {
      if (
        (event as CustomEvent).detail?.generation ===
        scope.current.authority?.localAuthGeneration
      ) {
        stopReply();
        flush();
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("atlas:profile-local-before-revoke", beforeRevoke);
    return () => {
      clearTimeout(saveTimer.current);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener(
        "atlas:profile-local-before-revoke",
        beforeRevoke,
      );
      flush();
    };
  }, [flush, stopReply]);
  useEffect(() => {
    followTail.current = true;
    const start = Math.max(
      0,
      (chatsRef.current.find((c) => c.id === selected)?.messages.length ?? 0) -
        40,
    );
    setMessageWindow((old) =>
      old.id === selected && old.start === start
        ? old
        : { id: selected, start },
    );
  }, [selected]);
  useLayoutEffect(() => {
    const anchor = prependAnchor.current,
      node = scroller.current;
    if (!anchor || !node) return;
    node.scrollTop = anchor.top + node.scrollHeight - anchor.height;
    prependAnchor.current = null;
  }, [messageStart]);
  useEffect(() => {
    if (visible && followTail.current)
      bottom.current?.scrollIntoView({ block: "nearest" });
  }, [current?.messages.at(-1)?.content, selected, visible]);
  useEffect(() => {
    const retryAt = current?.failure?.retryAt;
    if (!retryAt || !visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const value = Date.now();
      setNow(value);
      if (retryAt > value)
        timer = setTimeout(tick, Math.min(1000, retryAt - value));
    };
    tick();
    return () => clearTimeout(timer);
  }, [current?.failure?.retryAt, visible]);
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
        changeChats((old) =>
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
    composer.current?.setDraft("");
    setError("");
    composer.current?.focus();
  }
  async function submit(e?: FormEvent, retry = false) {
    e?.preventDefault();
    if (busyRef.current || fileRead.current || !config?.configured) return;
    const draft = composer.current?.getDraft() || "";
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
    if (!retry || draft.trim() === question) composer.current?.setDraft("");
    if (!retry) setAttachments([]);
    setBusy(true);
    setError("");
    changeChats((old) =>
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
          ],
    );
    const abort = new AbortController();
    control.current = abort;
    let done = false,
      retryAt = 0;
    const publisher = createAiStreamPublisher({
      visible: () => visibleRef.current,
      publish(snapshot) {
        changeChats((old) =>
          old.map((chat) =>
            chat.id === id
              ? {
                  ...chat,
                  messages: chat.messages.map((message) =>
                    message.id === assistant.id
                      ? { ...message, ...snapshot }
                      : message,
                  ),
                }
              : chat,
          ),
        );
      },
    });
    stream.current = publisher;
    activeReply.current = {
      chatId: id,
      userId: user.id,
      assistantId: assistant.id,
    };
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
      consume: while (true) {
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
          if (event.type === "done") {
            done = true;
            publisher.flush();
            // The application protocol is terminal here; a provider keeping
            // HTTP open must not retain a completed UI request indefinitely.
            void reader.cancel().catch(() => {});
            break consume;
          }
          if (
            event.type === "source" &&
            typeof event.provider === "string" &&
            typeof event.model === "string"
          )
            publisher.source({ provider: event.provider, model: event.model });
          if (event.type === "delta" && typeof event.text === "string")
            publisher.delta(event.text);
        }
      }
      if (!done)
        throw Error("The connection closed before the reply finished.");
      if (!current || current.titleRequested === false) {
        changeChats((old) =>
          old.map((c) => (c.id === id ? { ...c, titleRequested: true } : c)),
        );
        publisher.flush();
        void nameChat(
          id,
          messages.find((m) => m.role === "user")!,
          publisher.text(),
        );
      }
    } catch (e) {
      publisher.flush();
      const message = abort.signal.aborted
        ? "Reply stopped."
        : (e as Error).message;
      setNow(Date.now());
      abort.abort();
      changeChats((old) =>
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
      publisher.close();
      if (stream.current === publisher) {
        stream.current = null;
        activeReply.current = null;
      }
      setBusy(false);
      busyRef.current = false;
      control.current = null;
      if (!mounted.current) persist();
    }
  }
  const submitAction = useRef(() => {});
  useLayoutEffect(() => {
    // Stable composer callbacks must observe the committed conversation, not a
    // speculative parent render interrupted before commit.
    submitAction.current = () => {
      void submit();
    };
  });
  const submitComposer = useCallback(() => submitAction.current(), []);
  const attachComposer = useCallback(() => files.current?.click(), []);
  const draftFailure = useCallback(() => {
    if (mounted.current && scopeCurrent())
      setError(
        "Your draft is still in this tab, but device storage did not save it.",
      );
  }, [scopeCurrent]);
  const copy = useCallback(
    async (message: Message) => {
      try {
        await navigator.clipboard.writeText(message.content);
        if (!mounted.current || !scopeCurrent()) return;
        setCopied(message.id);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(""), 1500);
      } catch {
        if (mounted.current && scopeCurrent())
          setError("Select the message text to copy it.");
      }
    },
    [scopeCurrent],
  );
  return (
    <div className="ai-chat" ref={panel}>
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
          {filteredChats.slice(0, chatLimit).map((chat) => (
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
                  composer.current?.setDraft("");
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
                    changeChats((old) => old.filter((c) => c.id !== chat.id));
                    if (selected === chat.id) newChat();
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {filteredChats.length > chatLimit && (
            <button
              type="button"
              className="button"
              onClick={() => setChatLimit((n) => n + 50)}
            >
              Show earlier chats ({filteredChats.length - chatLimit})
            </button>
          )}
          {!chats.length && <p className="muted">No chats yet.</p>}
        </div>
        <small>
          {getActiveProfile()
            ? "Chats are saved locally and backed up to your Atlas account."
            : "Chats are saved in this browser."}
        </small>
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
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            followTail.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
          role="log"
          aria-label="Chat messages"
          aria-live="polite"
        >
          <div className="chat-transcript">
            {!current?.messages.length ? (
              <div className="chat-empty">
                <Sparkles size={28} />
                <h1>What can I help with?</h1>
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
                        composer.current?.setDraft(text);
                        composer.current?.focus();
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messageStart > 0 && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const node = scroller.current;
                      if (node)
                        prependAnchor.current = {
                          top: node.scrollTop,
                          height: node.scrollHeight,
                        };
                      followTail.current = false;
                      setMessageWindow({
                        id: selected,
                        start: Math.max(0, messageStart - 40),
                      });
                    }}
                  >
                    Show earlier messages ({messageStart})
                  </button>
                )}
                {current.messages.slice(messageStart).map((message) => (
                  <AiMessageView
                    key={message.id}
                    message={message}
                    copied={copied === message.id}
                    onCopy={copy}
                  />
                ))}
              </>
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
                      if (scopeCurrent())
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
            <AiComposer
              ref={composer}
              configured={!!config?.configured}
              reading={reading}
              busy={busy}
              attachmentCount={attachments.length}
              draftKey={scope.current.key + ":composer-v1"}
              selected={selected}
              current={scopeCurrent}
              onDraftFailure={draftFailure}
              onSubmit={submitComposer}
              onAttach={attachComposer}
              onStop={stopReply}
            />
            <div className="chat-disclosure">
              Messages and extracted file text are sent to the configured
              provider.{" "}
              {getActiveProfile()
                ? "Chats are backed up to your Atlas account."
                : "Chats are saved in this browser."}{" "}
              Check important answers.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
