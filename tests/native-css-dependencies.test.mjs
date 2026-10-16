import test from "node:test";
import assert from "node:assert/strict";
import {
  scanNativeCSSDependencies as scan,
  quoteNativeCSSURL,
} from "../runtime/native-css-dependencies.ts";
test("CSS parser distinguishes escaped imports, font src, URL images, strings and non-fetch preludes", () => {
  const source = String.raw`/* url(no) */ @namespace url(https://ns.test/); @\69mport "a.css" layer(theme) supports(display:grid) screen; @font-face{font-family:"url(fake)"; src:local('Fallback'),u\72l(fo\6f.woff2) format('woff2')} a{content:"url(fake)";background:URL(../a.png),image-set("two.png" 2x,url('one.png') 1x);filter:url(#local)} @supports(background:url(not-fetched)){a{background:url(yes.png)}}`;
  const refs = scan(source);
  assert.deepEqual(
    refs.map((r) => [r.url, r.kind]),
    [
      ["a.css", "style"],
      ["foo.woff2", "font"],
      ["../a.png", "image"],
      ["two.png", "image"],
      ["one.png", "image"],
      ["#local", "image"],
      ["yes.png", "image"],
    ],
  );
  for (const r of refs) assert.ok(source.slice(r.start, r.end));
  assert.ok(source.slice(refs[0].end).startsWith(" layer(theme)"));
});
test("URL escapes and continuations decode without regex rewriting unrelated syntax", () => {
  const source = String.raw`@import "f\6f o.css";a{background:u\72l("a\"b.png");cursor:url(foo\)bar.svg),auto}`;
  assert.deepEqual(
    scan(source).map((r) => r.url),
    ["foo.css", 'a"b.png', "foo)bar.svg"],
  );
  assert.equal(quoteNativeCSSURL('a"\\\n'), '"a\\"\\\\\\a "');
});
test("malformed URL/string/comment or exceeded resource budget fails explicitly", () => {
  for (const css of [
    "a{background:url(foo(bar))}",
    'a{background:url("unterminated)}',
    "/* no end",
    "a{background:url(a b)}",
    'a{background:image-set("a"',
  ])
    assert.throws(() => scan(css), { name: "NotSupportedError" });
  assert.throws(
    () =>
      scan(
        "a{background:" +
          Array.from({ length: 1025 }, (_, i) => `url(${i})`).join(",") +
          "}",
      ),
    { name: "QuotaExceededError" },
  );
});

test("unquoted URL comments are literal URL bytes, not lexer comments", () => {
  assert.equal(
    scan("a{background:url(/*literal*/a.png)}")[0].url,
    "/*literal*/a.png",
  );
  assert.throws(() => scan('a{background:url( /*literal*/"a.png")}'), {
    name: "NotSupportedError",
  });
  assert.equal(scan('a{background:url("a\0b.png")}')[0].url, "a\ufffdb.png");
});
