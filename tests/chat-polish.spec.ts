import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
async function ai(page: Page) {
  await page.route("**/api/ai/config", (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: "Groq",
        model: "openai/gpt-oss-120b",
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Use defaults" }).click();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "AI", exact: true })
    .click();
}
const reply = (content = "A complete reply.") =>
  [
    { type: "source", provider: "Groq", model: "openai/gpt-oss-120b" },
    { type: "delta", text: content },
    { type: "done" },
  ]
    .map((e) => JSON.stringify(e) + "\n")
    .join("");
async function send(page: Page, content: string) {
  await page.getByLabel("Message Atlas AI", { exact: true }).fill(content);
  await page.getByLabel("Send AI message").click();
}

test("chat titles summarize meaning once, persist, and leave replies responsive", async ({
  page,
}) => {
  let titleCalls = 0,
    opening: any;
  await page.route("**/api/ai/title", async (route) => {
    titleCalls++;
    opening = route.request().postDataJSON();
    await route.fulfill({ json: { title: "Healthy Tomato Plants" } });
  });
  await page.route("**/api/ai/chat", (route) =>
    route.fulfill({
      body: reply("Improve drainage and check the leaves for pests."),
      contentType: "application/x-ndjson",
    }),
  );
  await ai(page);
  await send(page, "The leaves on my tomatoes are yellow. What should I do?");
  await expect(
    page
      .locator(".chat-item")
      .getByRole("button", { name: "Healthy Tomato Plants", exact: true }),
  ).toBeVisible();
  expect(opening.messages[0].content).toContain("tomatoes");
  expect(opening.messages[1].content).toContain("drainage");
  expect(opening.allowGeminiDataUse).toBe(false);
  await send(page, "How much water?");
  await expect(page.locator(".chat-message.assistant")).toHaveCount(2);
  expect(titleCalls).toBe(1);
  await page.reload();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "AI", exact: true })
    .click();
  await page
    .locator(".chat-item")
    .getByRole("button", { name: "Healthy Tomato Plants", exact: true })
    .click();
  await expect(page.locator(".chat-message.user")).toHaveCount(2);
});

test("failed replies retry in place after cooldown, including after reload", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/ai/title", (route) =>
    route.fulfill({ status: 503, json: { error: "Not available" } }),
  );
  await page.route("**/api/ai/chat", (route) =>
    ++calls === 1
      ? route.fulfill({
          status: 429,
          headers: { "Retry-After": "2" },
          json: {
            error:
              "The AI allowance for this minute is in use. Your message is saved; retry shortly.",
          },
        })
      : route.fulfill({ contentType: "application/x-ndjson", body: reply() }),
  );
  await ai(page);
  await send(page, "Wow!");
  await expect(page.getByRole("alert")).toContainText("minute");
  await expect(page.getByRole("button", { name: /Retry in/ })).toBeDisabled();
  await page.reload();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "AI", exact: true })
    .click();
  await page.locator(".chat-item").getByRole("button").first().click();
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  await page.getByRole("button", { name: "Retry reply", exact: true }).click();
  await expect(page.locator(".chat-message.assistant")).toContainText(
    "A complete reply.",
  );
  await expect(page.locator(".chat-message.user")).toHaveCount(1);
  expect(calls).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("document attachments extract text locally, preview, remove and persist", async ({
  page,
}) => {
  const outgoing: any[] = [];
  await page.route("**/api/ai/title", (route) =>
    route.fulfill({ json: { title: "Reviewing Project Notes" } }),
  );
  await page.route("**/api/ai/chat", (route) => {
    outgoing.push(route.request().postDataJSON());
    return route.fulfill({
      body: reply(),
      contentType: "application/x-ndjson",
    });
  });
  await ai(page);
  const upload = page.getByLabel("Choose chat files", { exact: true });
  await upload.setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Project notes\nThe launch is Friday."),
  });
  await expect(page.getByLabel("Attached files")).toContainText("notes.md");
  await page.getByLabel("Remove notes.md").click();
  await expect(page.getByLabel("Attached files")).toHaveCount(0);
  await upload.setInputFiles([
    resolve("tests/fixtures/chat-text.pdf"),
    resolve("tests/fixtures/chat-text.docx"),
  ]);
  await expect(page.getByLabel("Attached files")).toContainText(
    "chat-text.pdf",
  );
  await expect(page.getByLabel("Attached files")).toContainText(
    "chat-text.docx",
  );
  await send(page, "Review these documents");
  await expect(page.locator(".chat-message.assistant")).toBeVisible();
  expect(outgoing[0].messages[0].content).toContain(
    "PDF fixture project notes",
  );
  expect(outgoing[0].messages[0].content).toContain(
    "DOCX fixture launch checklist",
  );
  await page.locator(".chat-attachments.sent summary").first().click();
  await expect(
    page.locator(".chat-attachments.sent pre").first(),
  ).toContainText("PDF fixture project notes");
  await page.reload();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "AI", exact: true })
    .click();
  await page.locator(".chat-item").getByRole("button").first().click();
  await expect(page.locator(".chat-attachments.sent")).toContainText(
    "chat-text.docx",
  );
  await upload.setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from("fake"),
  });
  await expect(page.getByRole("alert")).toContainText("supported files");
  await upload.setInputFiles({
    name: "large.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("x".repeat(12001)),
  });
  await expect(page.getByRole("alert")).toContainText("12,000");
});

for (const width of [2771, 1440, 768, 390, 320])
  test(`chat layout keeps a readable aligned lane at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1100 });
    await page.addInitScript(() =>
      localStorage.setItem(
        "atlas.chats",
        JSON.stringify([
          {
            id: "layout",
            title: "Layout example",
            updated: 1,
            messages: [
              {
                id: "a",
                role: "assistant",
                content:
                  "## A readable heading\n\nA readable paragraph with **emphasis**.\n\n- First item\n- Second item\n\n```js\n" +
                  "long_code_line_".repeat(40) +
                  "\n```",
              },
              { id: "u", role: "user", content: "Thanks!" },
            ],
          },
        ]),
      ),
    );
    await ai(page);
    await page.locator(".chat-item").getByRole("button").first().click();
    const user = await page.locator(".chat-message.user").boundingBox(),
      composer = await page.locator(".chat-composer").boundingBox(),
      assistant = await page.locator(".chat-message.assistant").boundingBox();
    expect(
      Math.abs(user!.x + user!.width - composer!.x - composer!.width),
    ).toBeLessThan(3);
    expect(Math.abs(assistant!.x - composer!.x)).toBeLessThan(3);
    expect(
      await page
        .locator(".chat-message-content")
        .first()
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    expect(
      await page
        .locator(".chat-message-content h2")
        .evaluate((e) => getComputedStyle(e).fontFamily),
    ).not.toMatch(/Georgia|Lora/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    expect(composer!.y + composer!.height).toBeLessThan(
      width < 500 ? 844 : 1100,
    );
    await page.screenshot({ path: `evidence/chat-polish/chat-${width}.png` });
  });

test("late title completion never resurrects a deleted conversation", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/ai/title", async (route) => {
    await gate;
    await route.fulfill({ json: { title: "Deleted Topic" } }).catch(() => {});
  });
  await page.route("**/api/ai/chat", (route) =>
    route.fulfill({ body: reply(), contentType: "application/x-ndjson" }),
  );
  await ai(page);
  const requested = page.waitForRequest("**/api/ai/title");
  await send(page, "A temporary topic");
  await requested;
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete chat A temporary topic" })
    .click();
  release();
  await expect(page.locator(".chat-item")).toHaveCount(0);
  await page.reload();
  await page
    .locator(".main-nav")
    .getByRole("button", { name: "AI", exact: true })
    .click();
  await expect(page.locator(".chat-item")).toHaveCount(0);
});
