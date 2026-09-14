/** Normalize common model math delimiters without changing Markdown code examples. */
export function normalizeMath(source: string): string {
  let result = "",
    i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (i === 0 || source[i - 1] === "\n") {
      const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(rest);
      if (fence) {
        const marker = fence[2][0],
          length = fence[2].length;
        const close = new RegExp(
          `^ {0,3}${marker}{${length},}[ \\t]*(?:\\n|$)`,
          "m",
        );
        const tail = rest.slice(fence[0].length),
          end = close.exec(tail);
        const count = end
          ? fence[0].length + end.index + end[0].length
          : rest.length;
        result += rest.slice(0, count);
        i += count;
        continue;
      }
      // Indented Markdown code remains literal too.
      if (/^( {4}|\t)/.test(rest)) {
        const end = source.indexOf("\n", i);
        const count = end < 0 ? source.length : end + 1;
        result += source.slice(i, count);
        i = count;
        continue;
      }
    }
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
      if (end >= 0) {
        const formula = source.slice(i + 2, end).trim();
        result +=
          delimiter === "\\)" ? `$${formula}$` : `\n\n$$\n${formula}\n$$\n\n`;
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
