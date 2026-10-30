import { unified } from "unified";
import remarkParse from "remark-parse";

const markdown = unified().use(remarkParse);
type Span = { start: number; end: number };

/** Normalize model delimiters using Markdown's actual code and container bounds. */
export function normalizeMath(source: string): string {
  if (!/\\[([]|\$\$/.test(source)) return source;
  const protectedSpans: Span[] = [],
    containers: Array<Span & { prefix: string }> = [];
  const tree = markdown.parse(source);
  const visit = (
    node: typeof tree | (typeof tree.children)[number],
    nested = false,
  ) => {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (
      ["code", "inlineCode", "html", "link", "image", "definition"].includes(
        node.type,
      )
    ) {
      protectedSpans.push({ start, end });
      return;
    }
    if (nested && ["paragraph", "heading"].includes(node.type)) {
      const line = source.lastIndexOf("\n", start - 1) + 1;
      // Keep quote markers; replace list markers with equally wide continuation spaces.
      const prefix = source
        .slice(line, start)
        .replace(/(?:[-+*]|\d+[.)])[ \t]+/g, (match) =>
          " ".repeat(match.length),
        );
      containers.push({ start, end, prefix });
    }
    if ("children" in node)
      for (const child of node.children)
        visit(
          child as typeof node,
          nested || node.type === "listItem" || node.type === "blockquote",
        );
  };
  visit(tree);
  protectedSpans.sort((a, b) => a.start - b.start);
  let result = "",
    i = 0,
    protectedIndex = 0;
  while (i < source.length) {
    while (protectedSpans[protectedIndex]?.end <= i) protectedIndex++;
    const protectedSpan = protectedSpans[protectedIndex];
    if (protectedSpan && i >= protectedSpan.start) {
      result += source.slice(i, protectedSpan.end);
      i = protectedSpan.end;
      continue;
    }
    const rest = source.slice(i);
    if (source[i] === "`") {
      const ticks = /^`+/.exec(rest)![0];
      let end = source.indexOf(ticks, i + ticks.length);
      while (
        end >= 0 &&
        (source[end - 1] === "`" || source[end + ticks.length] === "`")
      )
        end = source.indexOf(ticks, end + ticks.length);
      if (end >= 0) {
        result += source.slice(i, end + ticks.length);
        i = end + ticks.length;
        continue;
      }
      result += ticks;
      i += ticks.length;
      continue;
    }
    const delimiter = rest.startsWith("\\(")
      ? "\\)"
      : rest.startsWith("\\[")
        ? "\\]"
        : rest.startsWith("$$")
          ? "$$"
          : null;
    if (delimiter) {
      let end = source.indexOf(delimiter, i + 2);
      while (end >= 0) {
        let slashes = 0;
        for (let j = end - 1; source[j] === "\\"; j--) slashes++;
        if (slashes % 2 === 0) break;
        end = source.indexOf(delimiter, end + 2);
      }
      if (end >= 0 && (!protectedSpan || end < protectedSpan.start)) {
        const prefix =
          containers.find(
            (container) => i >= container.start && end <= container.end,
          )?.prefix ?? "";
        const formula = source
          .slice(i + 2, end)
          .split("\n")
          .map((line, index) =>
            index && prefix && line.startsWith(prefix)
              ? line.slice(prefix.length)
              : line,
          )
          .join("\n")
          .trim();
        const separation = `\n${prefix}\n`;
        result +=
          delimiter === "\\)"
            ? `$${formula}$`
            : `${separation}${prefix}$$\n${prefix}${formula.replaceAll("\n", "\n" + prefix)}\n${prefix}$$${separation}${prefix}`;
        i = end + 2;
        continue;
      }
    }
    // Preserve escaped backslashes/dollars rather than treating them as openers.
    if (source[i] === "\\" && i + 1 < source.length) {
      result += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    result += source[i++];
  }
  return result;
}
