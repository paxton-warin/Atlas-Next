import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMath } from "../web/src/chat-math.ts";

const render = (source) =>
  renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkMath],
      rehypePlugins: [[rehypeKatex, { trust: false, throwOnError: false }]],
      skipHtml: true,
      children: normalizeMath(source),
    }),
  );
test("nested-list display formulas render as math without leaving the list", () => {
  const source = String.raw`- **Key properties**
  - Its **fundamental group** is
    \[\pi_{1}\bigl(SU(n)\bigr)=0\quad\text{for }n\ge 2.\]
    This group is simply connected.`;
  const html = render(source);
  assert.match(html, /katex-display/);
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  assert.ok(html.indexOf("katex-display") < html.indexOf("</li>"));
  assert.doesNotMatch(html, /class="katex-error"/);
  assert.doesNotMatch(
    html.replace(/<annotation[\s\S]*?<\/annotation>/g, ""),
    /\\pi|\\mathbb|\\quad/,
  );
});
test("display math preserves ordered-list and blockquote continuations", () => {
  for (const source of [
    String.raw`1. Equation

   \[x^2+y^2=z^2\]

   Explanation.`,
    String.raw`> Equation
>
> \[
> x^2+y^2=z^2
> \]
>
> Explanation.`,
  ]) {
    const html = render(source);
    assert.match(html, /katex-display/);
    assert.doesNotMatch(html, /class="katex-error"/);
    assert.ok(
      html.indexOf("katex-display") <
        html.indexOf(source.startsWith(">") ? "</blockquote>" : "</li>"),
    );
  }
});
test("real indented and fenced code inside lists stays literal", () => {
  const source = String.raw`- Code example

      \[literal\]

  \`\`\`tex
  \[also literal\]
  \`\`\`

  Formula \(x^2\).`.replaceAll("\\`", "`");
  const html = render(source);
  assert.equal((html.match(/class="katex"/g) || []).length, 1);
  assert.match(html, /\\\[literal\\\]/);
  assert.match(html, /\\\[also literal\\\]/);
});
test("incomplete streamed formulas and links remain usable until the closing delimiter arrives", () => {
  const before = String.raw`- Formula \[\frac{1}{`;
  assert.equal(normalizeMath(before), before);
  const after = render(before + String.raw`2}\]`);
  assert.match(after, /katex-display/);
  const code =
    String.raw`See \`\(literal\)\` and [docs](https://example.com/a).`.replaceAll(
      "\\`",
      "`",
    );
  assert.match(render(code), /href="https:\/\/example.com\/a"/);
});
