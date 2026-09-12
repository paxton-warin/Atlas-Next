import { readFileSync, writeFileSync } from "node:fs";
const report = JSON.parse(
  readFileSync("evidence/browser-results.json", "utf8"),
);
const tests = [];
function walk(s) {
  for (const spec of s.specs || [])
    for (const test of spec.tests || [])
      tests.push({
        name: spec.title,
        expected: test.expectedStatus,
        actual: test.results.at(-1)?.status,
        status: test.status,
      });
  for (const child of s.suites || []) walk(child);
}
walk(report);
const passed = tests.filter(
  (t) => t.expected === "passed" && t.actual === "passed",
).length;
const known = tests.filter(
  (t) => t.expected === "failed" && t.actual === "failed",
).length;
const unexpected = tests.filter((t) => t.status !== "expected").length;
const output = `BROWSER_PASS=${passed}; KNOWN_UPSTREAM_FAILURE=${known}; UNEXPECTED_FAILURE=${unexpected}`;
writeFileSync("evidence/browser-summary.txt", output + "\n");
console.log(output);
if (unexpected) process.exitCode = 1;
