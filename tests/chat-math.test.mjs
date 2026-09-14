import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMath } from "../web/src/chat-math.ts";
test("math accepts model delimiters and same-line display formulas", () => {
  assert.equal(normalizeMath(String.raw`Inline \(x^2\).`), "Inline $x^2$.");
  assert.equal(
    normalizeMath(String.raw`\[\frac{a}{b}\]`),
    "\n\n$$\n\\frac{a}{b}\n$$\n\n",
  );
  assert.equal(normalizeMath("$$x+y$$"), "\n\n$$\nx+y\n$$\n\n");
});
test("math leaves code, escapes, incomplete streaming input and ordinary Markdown unchanged", () => {
  for (const value of [
    "`\\(x\\)`",
    "``a ` $$x$$``",
    "```tex\n\\[x\\]\n```\n",
    "~~~tex\n$$x$$\n~~~\n",
    "```tex\n$$x$$",
    "    $$code$$\n",
    String.raw`\\(escaped\\)`,
    String.raw`\$5`,
    "Streaming \\(x",
    "Hello **world** $x$ and [link](https://example.com).",
  ])
    assert.equal(normalizeMath(value), value);
});
