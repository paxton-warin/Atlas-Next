import { memo, useMemo, useState, type ComponentProps } from "react";
import { Check, Copy, FileText } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMath } from "./chat-math";
import type { AiMessage as Message } from "./ai-chat-state";
const remarkPlugins: ComponentProps<typeof Markdown>["remarkPlugins"] = [
  remarkGfm,
  remarkMath,
];
const rehypePlugins: ComponentProps<typeof Markdown>["rehypePlugins"] = [
  [
    rehypeKatex,
    {
      trust: false,
      throwOnError: false,
      maxExpand: 1000,
      maxSize: 20,
    },
  ],
];
const components: ComponentProps<typeof Markdown>["components"] = {
  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: () => null,
};
/** Completed message parsing is isolated from composer, sidebar, other replies,
 * copy feedback and source-label updates. No transcript-wide Markdown cache. */
export const AiMessageView = memo(function AiMessageView({
  message,
  copied,
  onCopy,
}: {
  message: Message;
  copied: boolean;
  onCopy(message: Message): void;
}) {
  const [filesShown, setFilesShown] = useState(3);
  const content = useMemo(
    () =>
      message.content ? (
        <Markdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          skipHtml
          components={components}
        >
          {normalizeMath(message.content)}
        </Markdown>
      ) : (
        <span className="thinking">
          <span className="spinner" />
          Generating…
        </span>
      ),
    [message.content],
  );
  return (
    <article className={"chat-message " + message.role}>
      <div className="chat-author">
        {message.role === "user" ? "You" : "Atlas AI"}
        {message.role === "assistant" && message.provider && (
          <span className="chat-author-source">
            {message.provider} · {message.model}
          </span>
        )}
      </div>
      {!!message.attachments?.length && (
        <div className="chat-attachments sent">
          {message.attachments.slice(0, filesShown).map((file) => (
            <details key={file.id}>
              <summary>
                <FileText size={15} />
                <span>{file.name}</span>
              </summary>
              <pre>{file.text}</pre>
            </details>
          ))}
          {message.attachments.length > filesShown && (
            <button type="button" onClick={() => setFilesShown((n) => n + 3)}>
              Show more attached files
            </button>
          )}
        </div>
      )}
      <div className="chat-message-content">{content}</div>
      {!!message.content && (
        <button
          className="message-copy"
          aria-label="Copy message"
          onClick={() => onCopy(message)}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </article>
  );
});
