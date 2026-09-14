# Atlas AI: free-first provider routing

Atlas keeps its native streaming chat, Markdown/code formatting, stop/copy actions, and device-local history. Provider credentials stay encrypted in the backend database. The browser supplies user/assistant text, never a provider URL, model override or API key.

## Recommended setup

1. Open the verified owner panel → **AI provider**.
2. Keep **Free-only routing** on. Enable **Groq**, enter a Groq API key, and confirm it belongs to a free-tier account with paid billing disabled. The default model is `openai/gpt-oss-120b`. The key belongs to Groq, not OpenAI or xAI.
3. Check the limits in your Groq account. The preset starts at 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute and 200,000 tokens/day. These are shared by all Atlas visitors, not per user. Atlas caps are additional admission controls, not extra provider capacity.
4. Optionally enable **Google Gemini**, add its own key, and keep `gemini-3.5-flash-lite` or choose `gemini-3.1-flash-lite`. Confirm the project is on the free tier with paid billing disabled. Set its caps to the limits shown in your Google AI Studio project; Atlas's Gemini defaults are deliberately conservative local caps, not a published Google allowance.
5. Acknowledge Google's free-tier data use with **Allow the optional Gemini free-tier backup**. The chat also asks each visitor to opt in before sending that visitor's messages to free Gemini. Without their opt-in, Atlas skips Gemini.
6. Set the global daily request cap and reply-token limit. Enable **AI chat**, then **Save AI settings**.
7. Open the AI tab or select **Refresh AI connection**. Send a short question. Each answer shows the provider and model that generated it. Check **Refresh usage** in the owner panel to see requests, token accounting and cooldowns.

Use the arrow buttons to change provider priority. Disabled, keyless or ineligible providers are skipped. API keys may be configured while chat remains disabled. A blank key field retains that provider's saved key; its **Remove saved key** checkbox clears it. Changing a custom provider's origin requires a new key if that provider is enabled; credentials are never reused across origins.

### What free-only means

Free-only mode admits only supported Groq/Gemini free-model presets, their fixed official endpoints, and owner-confirmed free-tier accounts. It excludes xAI and custom endpoints regardless of their position in the list. It never enables a paid provider automatically when free capacity runs out.

Atlas cannot query or enforce your external billing plan. Keep the provider account/project on its genuine free tier with paid billing disabled. Local quotas are not a currency spending limit and do not cover use of the same key from other apps. Provider-specific availability, quota and data-use rules still apply.

No Cloudflare or OpenRouter integration is included in this first iteration. AWS CloudFront remains Atlas's CDN and is unrelated to Cloudflare Workers AI. Images, tools, live web search and code execution are not enabled by changing a model; this remains text-only chat.

## Optional paid xAI or custom provider

To use Grok, enable **xAI Grok**, enter an xAI API key and a model available to that account (preset `grok-4.6`). Explicitly turn **Free-only routing** off. The xAI preset uses `https://api.x.ai/v1/responses`, streams in the existing Atlas chat, and sets `store: false` for Responses requests. Set a spending limit in the provider console as well as Atlas request/token caps. Grok's free website access is separate from API billing.

The **Custom provider** card retains Responses and Chat Completions support for existing installations and local providers. Custom endpoints are always treated as paid/unverified for routing purposes. Existing saved single-provider settings and legacy `AI_*` environment variables are migrated in memory without dropping their key or silently rerouting chats. Their previous explicit provider remains enabled with free-only off; the first owner save writes the encrypted v2 configuration (`aiRouting`). New installations default to free-only on and chat disabled.

## Budgets, usage and failures

- Provider request/token counters and cooldowns live in SQLite and survive restarts. Saving configuration does not reset them. Provider daily windows reset at midnight UTC; minute windows start at the first admitted request and last 60 seconds. External providers can use different windows (Google uses Pacific time for its RPD reset); their own 429 responses remain authoritative.
- Atlas reserves a conservative UTF-8 input-size estimate, protocol overhead and the full allowed reply token count **before** starting an upstream request. Concurrent calls cannot all consume the same remaining budget. Completed streams replace their token reservation with reported total usage when available. Failed, cancelled or unreported usage retains its reservation rather than assuming the request was free. These counters are not invoices or exact remaining provider credits.
- Groq/Gemini use streaming Chat Completions; xAI uses Responses. Responses and Chat Completions usage events are recognized. Groq requests use low reasoning effort and request streaming usage metadata.
- A quota rejection (429/402), upstream 5xx or connection failure can select the next eligible provider before the first text reaches the visitor. `Retry-After` is respected, with persisted bounded cooldowns. Each provider is attempted at most once per request. Invalid credentials, input/configuration errors and provider refusals do not trigger automatic model switching.
- The first-text deadline is 12 seconds per provider, with 60 seconds overall. Once text starts, Atlas never splices in another model's answer. It retains a partial answer and reports an interrupted stream. Stop/disconnect aborts the upstream request and never triggers a fallback.
- All visitors, including IP-whitelisted visitors, share provider budgets, the global daily cap and the eight-reply global concurrency cap. Per-IP limits and per-IP concurrency are independently configurable under **Request limits**.
- Prompt/response text is not logged or stored in Atlas's backend. Provider error bodies and credentials are not exposed. Google free-tier use has an explicit owner acknowledgement and visitor opt-in; switching providers sends the conversation context needed for that answer to the selected provider.

## Verification

`pnpm test` covers provider order, quota fallback, encrypted credentials, free-only exclusion, Gemini consent, partial-stream behavior, xAI Responses, persistent accounting, IP exemptions and legacy configuration. Browser tests cover the owner controls, responsive layout and native chat. Tests use synthetic keys and streams, not real model replies. A live smoke test requires your actual provider keys and account access; no paid API requests are made by the test suite.

## Provider references

Checked September 12, 2026:

- [Groq rate limits](https://console.groq.com/docs/rate-limits) and [OpenAI-compatible endpoint](https://console.groq.com/docs/openai).
- [Groq GPT-OSS 120B](https://console.groq.com/docs/model/openai/gpt-oss-120b) and [reasoning controls](https://console.groq.com/docs/reasoning).
- [Gemini compatibility and streaming](https://ai.google.dev/gemini-api/docs/openai), [pricing/data use](https://ai.google.dev/gemini-api/docs/pricing) and [project quotas](https://ai.google.dev/gemini-api/docs/rate-limits).
- [xAI API setup](https://docs.x.ai/developers/quickstart) and [Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses).

## Chat workspace, titles and files

- The message column and composer share a responsive 940 px lane. User messages align right; assistant messages use readable system sans-serif text and contained code/table scrolling.
- New conversations get a short, model-generated topic title after the first completed reply. Atlas submits a bounded excerpt of the opening exchange to `/api/ai/title` in the background. This costs one additional small provider request, uses the same routing/billing/consent rules and shared budgets, and never delays the reply. If titling fails, the original prompt-based label stays. Titles and conversations persist on the current device.
- The paperclip accepts **UTF-8 text/code, PDF with selectable text, and DOCX**: 3 files per message, 2 MB each, 12,000 extracted characters per file and 20,000 combined. PDFs are limited to 50 pages. Images, scanned PDFs, encrypted documents and other binary formats are not image/OCR inputs. Extract text before attaching these.
- Parsing runs in a disposable local worker. Only extracted plain text and filenames enter the AI request; no document HTML, scripts, macros or remote images are rendered. Extraction fails explicitly rather than silently truncating a document. File text can be previewed in the sent message and is saved with the conversation in browser storage. Deleting the chat removes that local copy. Sending a message also sends its file text to the chosen provider, including any acknowledged Gemini fallback.
- Failed/stopped replies retain the original user message and offer **Retry reply**. Retrying reuses that message, replacing a partial reply rather than duplicating the user bubble. Known quota/cooldown reset times produce a countdown that persists across reloads; requests are never automatically repeated in a loop.
- GPT-OSS input reservations use the o200k text tokenizer plus framing headroom and the configured reply cap, instead of treating each byte as a token. This avoids falsely rejecting long-answer follow-ups. Actual provider-reported usage still reconciles the reservation. Models with other tokenizers retain conservative byte-based reservations. Configured/provider limits still apply; oversized context has a distinct error rather than a misleading wait-and-retry message.

Implementation references: [GPT-OSS tokenizer](https://github.com/openai/gpt-oss/blob/main/gpt_oss/tokenizer.py), [PDF.js text extraction API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html), [Mammoth raw-text extraction](https://github.com/mwilliamson/mammoth.js#extracting-raw-text).

## LaTeX math

Chat renders inline `$E=mc^2$` and display `$$...$$`, plus common model delimiters `\(...\)` and `\[...\]`. Fractions, roots, matrices, sums and integrals use locally bundled KaTeX fonts/styles; no math CDN is requested. Code spans/fences remain literal. Copying a message retains its original Markdown/LaTeX source. Incomplete streamed formulas render once their delimiters are complete; unsupported commands do not crash the conversation. Long display equations scroll within the message lane on narrow screens.

Example prompt:

```text
Explain the quadratic formula. Use LaTeX for the formula and show the steps.
```

The renderer uses `remark-math` with `rehype-katex`, disables trusted HTML/link commands and bounds macro expansion and user-requested sizing. References: [remark-math rendering](https://github.com/remarkjs/remark-math), [KaTeX options](https://katex.org/docs/options.html).
