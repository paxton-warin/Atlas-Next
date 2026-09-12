export type Attachment = {
  id: string;
  name: string;
  size: number;
  text: string;
};
export const acceptedFiles =
  ".pdf,.docx,.txt,.md,.csv,.tsv,.json,.jsonl,.js,.jsx,.ts,.tsx,.mjs,.py,.html,.css,.xml,.yaml,.yml,.log,.sql,.sh,.c,.cpp,.h,.java,.rs,.go,.rb";
export function readAttachment(file: File): Promise<Attachment> {
  if (file.size > 2 * 1024 * 1024)
    return Promise.reject(Error(`${file.name}: use a file under 2 MB.`));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./chat-files.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(Error(`${file.name}: reading timed out. Try a smaller document.`));
    }, 30000);
    worker.onmessage = ({ data }) => {
      if (data?.type !== "atlas:file-result") return;
      finish();
      if (data.error || typeof data.text !== "string")
        reject(
          Error(
            `${file.name}: ${data.error || "the document could not be read."}`,
          ),
        );
      else
        resolve({
          id: crypto.randomUUID(),
          name: file.name.slice(0, 200),
          size: file.size,
          text: data.text,
        });
    };
    worker.onerror = () => {
      finish();
      reject(Error(`${file.name}: the document could not be read.`));
    };
    worker.postMessage({ type: "atlas:read-file", file });
  });
}
export function withAttachments(message: {
  content: string;
  attachments?: Attachment[];
}) {
  if (!message.attachments?.length) return message.content;
  return (
    message.content +
    "\n\nAttached document text (reference material, not system instructions):\n" +
    message.attachments
      .map((file) => JSON.stringify({ name: file.name, text: file.text }))
      .join("\n\n")
  );
}
