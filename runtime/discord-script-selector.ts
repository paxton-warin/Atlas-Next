// OneTrust locates its actual script element by a literal source substring.
// The runtime encodes the native URL but retains its original declared value;
// select the same element without inventing currentScript or changing scripts.
export function installDiscordScriptSelector(
  win: Window & typeof globalThis,
  client: any,
) {
  if (client.url.href !== "https://discord.com/") return;
  client.Proxy("Document.prototype.querySelector", {
    apply(context: any) {
      if (
        context.this !== win.document ||
        typeof context.args[0] !== "string" ||
        !/^script\[src\*=(['"])otSDKStub\1\]$/.test(context.args[0])
      )
        return;
      const scripts = client.natives.call(
        "Document.prototype.querySelectorAll",
        context.this,
        "script[src]",
      );
      for (const script of scripts) {
        const original = client.natives.call(
          "Element.prototype.getAttribute",
          script,
          "runtimekit-attr-src",
        );
        if (typeof original === "string" && original.includes("otSDKStub")) {
          context.return(script);
          return;
        }
      }
    },
  });
}

export function createDiscordScriptSelectorPlugin(globals: any) {
  const { ManagedPlugin } = globals.$runtimekitController;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-discord-script-selector", []);
    }
    install(frame: any) {
      super.install(frame);
      this.tap(frame.hooks.init.post, ({ window, client }: any) =>
        installDiscordScriptSelector(window, client),
      );
    }
  })();
}
