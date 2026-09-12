# Built-in Atlas AI

The AI navigation tab is a native chat interface, not an embedded ChatGPT page. It supports streaming text, Markdown/code formatting, stop, copy, new/delete/search chats, and local chat history. Switching application pages preserves the mounted conversation. Messages are submitted only when the user presses Send.

## Connect a provider

Open the verified administrator panel and choose **AI provider**. Enter:

- API protocol: **OpenAI Responses**, or **OpenAI-compatible Chat Completions** for a compatible provider.
- Provider base URL, including its API version path (for example `https://api.openai.com/v1`).
- A model ID available to that provider account.
- The provider API key.
- A global daily request limit; then enable chat and save.

Reopen the AI tab or use **Refresh AI connection**. The application never returns the saved key, including to the admin UI. Keys saved in the panel are encrypted using the existing server master key. An authenticated admin can replace the key; a blank field retains it. Environment configuration is documented in `.env.example`, and saved admin configuration takes precedence.

A real provider/key has **not** been configured in this local preview. No paid model requests were made. Tests use an explicitly labeled local streaming fixture; its replies are not model-generated.

## Request handling

The OpenAI Responses adapter follows [official OpenAI documentation](https://developers.openai.com/api/docs/guides/streaming-responses): `stream: true`, incremental `response.output_text.delta` events, and completion/error handling. Requests set `store: false`. This is not a promise about a provider's other retention policies.

Only user/assistant text is accepted from the browser. The server chooses credentials, model, protocol and instructions. There are no attached tools, web search, uploads or arbitrary provider URLs in chat requests. Markdown HTML and remote images are not rendered. The public API enforces the application Origin, input bounds, 20 requests per IP per hour, 2 simultaneous replies per IP, 8 globally, and the configured daily request cap (default 200). Request caps are not a currency budget; configure a spending limit at the provider.

The stream stops on disconnect/cancel and has a 60-second timeout. Provider response bodies and credentials are not included in public error messages. Prompt/response bodies are not logged or stored by Atlas's backend. Local chat storage is separate from website cookies and is not included in settings exports.
