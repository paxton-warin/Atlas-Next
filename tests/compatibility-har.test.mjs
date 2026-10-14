import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHar } from "../scripts/analyze-compatibility-har.mjs";
test("HAR summaries contain counts only, never authenticated URL/body/header values", () => {
  const marker = "PRIVATE-FIXTURE-CONTENT";
  const report = summarizeHar({
    log: {
      entries: [
        {
          request: {
            url: "https://chatgpt.com/backend-api/conversation?token=" + marker,
            headers: [{ name: "Authorization", value: marker }],
          },
          response: {
            status: 200,
            content: {
              mimeType: "text/event-stream",
              text:
                "data: " +
                JSON.stringify({
                  v: {
                    message: {
                      author: { role: "assistant" },
                      content: { parts: [marker] },
                    },
                  },
                }) +
                "\n\ndata: [DONE]",
            },
          },
        },
      ],
    },
  });
  assert.equal(report.findings.assistantDataReceived, true);
  assert.equal(report.streams[0].assistantTextCharacters, marker.length);
  assert.equal(report.streams[0].completed, true);
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(JSON.stringify(report).includes("Authorization"), false);
});
