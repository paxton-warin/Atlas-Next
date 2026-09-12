import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";
GlobalWorkerOptions.workerSrc = pdfWorker;
self.onmessage = async ({
  data,
}: MessageEvent<{ type: string; file: File }>) => {
  if (data?.type !== "atlas:read-file") return;
  const file = data.file;
  try {
    const ext = file.name.split(".").pop()?.toLowerCase();
    let text = "";
    if (ext === "pdf") {
      const task = getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        useSystemFonts: false,
      });
      task.onPassword = () => {
        void task.destroy();
      };
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 50) throw Error("use a PDF with 50 pages or fewer.");
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n),
            content = await page.getTextContent();
          text +=
            content.items
              .map((item) =>
                "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
              )
              .join("") + "\n";
          if (text.length > 12000)
            throw Error(
              "the extracted text exceeds 12,000 characters. Upload an excerpt.",
            );
        }
      } finally {
        await task.destroy();
      }
    } else if (ext === "docx") {
      text = (
        await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
      ).value;
    } else if (
      /^(txt|md|csv|tsv|json|jsonl|js|jsx|ts|tsx|mjs|py|html|css|xml|yaml|yml|log|sql|sh|c|cpp|h|java|rs|go|rb)$/.test(
        ext || "",
      )
    ) {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (/\x00/.test(text)) throw Error("use a UTF-8 text file, PDF or DOCX.");
    } else
      throw Error(
        "supported files are text, code, PDF and DOCX. Images and scanned PDFs need text extraction first.",
      );
    if (!text.trim())
      throw Error("no readable text was found. Scanned PDFs need OCR first.");
    if (text.length > 12000)
      throw Error(
        "the extracted text exceeds 12,000 characters. Upload an excerpt.",
      );
    self.postMessage({ type: "atlas:file-result", text });
  } catch (error) {
    self.postMessage({
      type: "atlas:file-result",
      error: (error as Error).message || "the document could not be read.",
    });
  }
};
